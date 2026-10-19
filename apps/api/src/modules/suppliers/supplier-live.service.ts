import { performance } from 'node:perf_hooks';
import { Inject, Injectable } from '@nestjs/common';
import {
  CATALOG_IMAGE_MAX_BYTES,
  CATALOG_IMAGE_MAX_INPUT_PIXELS,
  type CatalogImage,
  isNearbySupplierOrder,
  NEARBY_SUPPLIER_ORDER_MINUTES,
  type NearbySupplierOrders,
  type PlatformStatus,
  SUPPLIER_CODES,
  type SupplierCallOperation,
  type SupplierCode,
  type SupplierOrder,
  type SupplierOrderPage,
  type SupplierPanelCapabilities,
  type SupplierTransactionPage,
  supplierPanelCapabilities,
} from '@vertex-digital/contracts';
import {
  type AttemptSupplierFacts,
  type Database,
  supplierCategories,
  supplierOrderMatches,
  suppliers,
  type Transaction,
} from '@vertex-digital/db';
import {
  type SupplierAdapter,
  SupplierError,
  type SupplierMoney,
  type SupplierOrderRow,
} from '@vertex-digital/suppliers';
import { and, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import { CodedException } from '../../core/errors/index.js';
import { CatalogService } from '../catalog/index.js';
import { SupplierAdaptersService } from './supplier-adapters.service.js';
import { refusals } from './supplier-records.js';

/*
 * S16's live supplier reads for the panel (rules IM1–IM3, SF3–SF5): category images, the
 * statement, nearby supplier orders and the platform status. Each call goes through the
 * supplier's adapter with its credentials decrypted per call, is recorded in `supplier_calls`
 * (left out of health, SF6), and nothing it reads is stored but an imported cover.
 */

/** IM1: a thumbnail's source is at most 2 MB, read within 5 seconds; at most 256 px wide or high. */
const THUMBNAIL_SOURCE_LIMITS = { maxBytes: 2 * 1024 * 1024, timeoutMs: 5_000 };
const THUMBNAIL_SIZE = 256;
const THUMBNAIL_CACHE = 500;
/** IM2: a cover is downloaded under S06's 5 MB limit. */
const COVER_LIMITS = { maxBytes: CATALOG_IMAGE_MAX_BYTES, timeoutMs: 10_000 };
/** SF3, SF4: one statement read per 5 seconds per supplier and list. */
const STATEMENT_INTERVAL_MS = 5_000;
/** SF5: the platform status is read again after a minute. */
const STATUS_TTL_MS = 60_000;
/** SF4: at most this many statement pages are read to reach an attempt's send time. */
const NEARBY_MAX_PAGES = 3;

type Capability = keyof SupplierPanelCapabilities;

interface SupplierRef {
  id: string;
  code: SupplierCode;
}

const usdUnits = (money: SupplierMoney | undefined) =>
  money?.currency === 'USD' ? money.amountUnits : null;

const unavailable = () =>
  new CodedException(409, 'SUPPLIER_UNAVAILABLE', 'The supplier did not answer as expected');

@Injectable()
export class SupplierLiveService {
  /** IM1's memory cache: the newest 500 thumbnails, by supplier, category and source URL. */
  private readonly thumbnails = new Map<string, Buffer>();
  private readonly statuses = new Map<string, PlatformStatus & { readAt: number }>();
  private readonly lastReads = new Map<string, number>();

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly adapters: SupplierAdaptersService,
    private readonly catalog: CatalogService,
  ) {}

  /** The supplier of a `:code`, or `NOT_FOUND` (`fake` too, where it is not enabled). */
  async supplier(code: string): Promise<SupplierRef> {
    const known = (SUPPLIER_CODES as readonly string[]).includes(code);
    const visible = code !== 'fake' || this.env.SUPPLIER_FAKE_ENABLED;
    const [row] =
      known && visible
        ? await this.db
            .select({ id: suppliers.id, code: suppliers.code })
            .from(suppliers)
            .where(eq(suppliers.code, code as SupplierCode))
        : [];
    if (!row) throw refusals.notFound('supplier');
    return row;
  }

  /** The supplier of a row's `supplier_id`. */
  async supplierById(id: string, db: Database | Transaction = this.db): Promise<SupplierRef> {
    const [row] = await db
      .select({ id: suppliers.id, code: suppliers.code })
      .from(suppliers)
      .where(eq(suppliers.id, id));
    if (!row) throw refusals.notFound('supplier');
    return row;
  }

  // Images (IM1–IM3) --------------------------------------------------------------------------

  /**
   * IM1: a category's image as a WebP of at most 256 px, from the memory cache or fetched from
   * the adapter's declared hosts, decoded with S06's pixel limit; null on any failure.
   */
  async thumbnail(code: string, categoryId: string): Promise<Buffer | null> {
    const supplier = await this.supplier(code);
    const imageUrl = await this.categoryImage(supplier.id, categoryId);
    if (!imageUrl) return null;
    const key = `${supplier.id}\n${categoryId}\n${imageUrl}`;
    const cached = this.thumbnails.get(key);
    if (cached) {
      this.thumbnails.delete(key);
      this.thumbnails.set(key, cached);
      return cached;
    }
    let bytes: Uint8Array;
    try {
      bytes = await this.fetchImage(supplier, imageUrl, THUMBNAIL_SOURCE_LIMITS);
    } catch {
      return null;
    }
    const webp = await sharp(bytes, {
      limitInputPixels: CATALOG_IMAGE_MAX_INPUT_PIXELS,
      failOn: 'error',
    })
      .rotate()
      .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, { fit: 'inside', withoutEnlargement: true })
      .webp()
      .toBuffer()
      .catch(() => null);
    if (!webp) return null;
    this.thumbnails.set(key, webp);
    if (this.thumbnails.size > THUMBNAIL_CACHE) {
      this.thumbnails.delete(this.thumbnails.keys().next().value as string);
    }
    return webp;
  }

  /**
   * IM2, IM3: the category's image downloaded again and stored as a new catalog image through
   * S06's rule CT10 (decoded, stripped, fitted within 1600 px, WebP); `IMAGE_FETCH_FAILED`
   * otherwise. Called before the transaction that uses it.
   */
  async storeCover(supplier: SupplierRef, imageUrl: string | null): Promise<CatalogImage> {
    const failed = () =>
      new CodedException(409, 'IMAGE_FETCH_FAILED', 'The supplier image could not be used');
    if (!imageUrl) throw failed();
    let bytes: Uint8Array;
    try {
      bytes = await this.fetchImage(supplier, imageUrl, COVER_LIMITS);
    } catch {
      throw failed();
    }
    try {
      return await this.catalog.uploadImage(Buffer.from(bytes));
    } catch (error) {
      if (error instanceof CodedException) throw failed();
      throw error;
    }
  }

  // Statement and nearby orders (SF3, SF4) ------------------------------------------------------

  /** SF3: a page of the supplier's wallet transactions, matched to our attempts. */
  async transactions(code: string, page: number): Promise<SupplierTransactionPage> {
    const supplier = await this.supplier(code);
    const adapter = await this.adapter(supplier, 'statement');
    this.throttle(`${supplier.id}:transactions`);
    const read = await this.call(supplier, 'list_transactions', () =>
      adapter.listTransactions(page),
    );
    const matches = await supplierOrderMatches(
      this.db,
      supplier.id,
      read.items.flatMap((row) => (row.supplierOrderId ? [row.supplierOrderId] : [])),
    );
    return {
      page,
      hasMore: read.hasMore,
      items: read.items.map((row) => ({
        id: row.id,
        type: row.type ?? null,
        amountUsdUnits: usdUnits(row.amount),
        balanceAfterUsdUnits: usdUnits(row.balanceAfter),
        reference: row.reference ?? null,
        supplierOrderId: row.supplierOrderId ?? null,
        createdAt: row.createdAt?.toISOString() ?? null,
        match: (row.supplierOrderId && matches.get(row.supplierOrderId)) || null,
      })),
    };
  }

  /** SF3: a page of the supplier's order history, matched to our attempts. */
  async orders(code: string, page: number): Promise<SupplierOrderPage> {
    const supplier = await this.supplier(code);
    const adapter = await this.adapter(supplier, 'statement');
    this.throttle(`${supplier.id}:orders`);
    const read = await this.call(supplier, 'list_orders', () => adapter.listOrders(page));
    return { page, hasMore: read.hasMore, items: await this.matched(supplier, read.items) };
  }

  /**
   * SF4: the supplier's orders for the attempt's offer and quantity within 15 minutes of its
   * send, each with the attempt it is matched to (this one, another, or none); read live.
   * `complete` is false when the pages read did not reach the window or a row had no time.
   */
  async nearby(attempt: AttemptSupplierFacts): Promise<NearbySupplierOrders> {
    const supplier = { id: attempt.supplierId, code: attempt.supplierCode };
    if (!attempt.sentAt || !attempt.supplierOfferId) {
      throw new CodedException(409, 'CAPABILITY_UNSUPPORTED', 'The attempt was never sent');
    }
    const adapter = await this.adapter(supplier, 'statement');
    this.throttle(`${supplier.id}:nearby`);
    const since = attempt.sentAt.getTime() - NEARBY_SUPPLIER_ORDER_MINUTES * 60_000;
    const found: SupplierOrderRow[] = [];
    let reached = false;
    for (let page = 1; page <= NEARBY_MAX_PAGES && !reached; page += 1) {
      const read = await this.call(supplier, 'list_orders', () => adapter.listOrders(page));
      found.push(...read.items);
      const oldest = read.items.at(-1)?.createdAt;
      reached = !read.hasMore || (oldest !== undefined && oldest.getTime() < since);
    }
    const rows = await this.matched(supplier, found);
    const facts = {
      supplierOfferId: attempt.supplierOfferId,
      quantity: attempt.quantity,
      sentAt: attempt.sentAt,
    };
    return {
      items: rows.filter((row) => isNearbySupplierOrder(row, facts)),
      complete: reached && found.every((row) => row.createdAt !== undefined),
    };
  }

  // Platform status (SF5) ---------------------------------------------------------------------

  /** SF5: the supplier's own status, read again after a minute. */
  async platformStatus(code: string): Promise<PlatformStatus> {
    const supplier = await this.supplier(code);
    const cached = this.cachedStatus(supplier.id);
    if (cached) return cached;
    const adapter = await this.adapter(supplier, 'platformStatus');
    const read = await this.call(supplier, 'platform_status', () => adapter.getPlatformStatus());
    const status: PlatformStatus = {
      status: read.status.slice(0, 64),
      catalogUpdatedAt: read.catalogUpdatedAt?.toISOString() ?? null,
      checkedAt: new Date().toISOString(),
    };
    this.statuses.set(supplier.id, { ...status, readAt: Date.now() });
    return status;
  }

  /** The status read in the last minute, or null (the supplier cards never call the supplier). */
  cachedStatus(supplierId: string): PlatformStatus | null {
    const cached = this.statuses.get(supplierId);
    if (!cached || Date.now() - cached.readAt > STATUS_TTL_MS) return null;
    const { readAt: _, ...status } = cached;
    return status;
  }

  // Helpers -----------------------------------------------------------------------------------

  private async categoryImage(supplierId: string, categoryId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ imageUrl: supplierCategories.imageUrl })
      .from(supplierCategories)
      .where(
        and(
          eq(supplierCategories.supplierId, supplierId),
          eq(supplierCategories.categoryId, categoryId),
        ),
      );
    return row?.imageUrl ?? null;
  }

  private async fetchImage(
    supplier: SupplierRef,
    url: string,
    limits: { maxBytes: number; timeoutMs: number },
  ): Promise<Uint8Array> {
    const adapter = await this.adapter(supplier, 'categories');
    return this.call(supplier, 'fetch_image', () => adapter.fetchImage(url, limits));
  }

  /** The adapter, when it has the capability (`CAPABILITY_UNSUPPORTED`) and credentials. */
  private async adapter(supplier: SupplierRef, capability: Capability): Promise<SupplierAdapter> {
    if (!supplierPanelCapabilities(supplier.code)[capability]) {
      throw new CodedException(409, 'CAPABILITY_UNSUPPORTED', `The supplier has no ${capability}`);
    }
    const adapter = await this.adapters.connect(supplier);
    if (!adapter) {
      throw new CodedException(409, 'SUPPLIER_NOT_CONFIGURED', 'Set the credentials first');
    }
    return adapter;
  }

  /** One adapter call, recorded (SF6); a failure answers `SUPPLIER_UNAVAILABLE`. */
  private async call<T>(
    supplier: SupplierRef,
    operation: SupplierCallOperation,
    work: () => Promise<T>,
  ): Promise<T> {
    const started = performance.now();
    const record = (result: 'ok' | 'refused' | 'error', error?: unknown) =>
      this.adapters.recordCall(this.db, {
        supplierId: supplier.id,
        operation,
        result,
        latencyMs: Math.max(0, Math.round(performance.now() - started)),
        error,
      });
    try {
      const value = await work();
      await record('ok');
      return value;
    } catch (error) {
      await record(
        error instanceof SupplierError && error.kind === 'definitive' ? 'refused' : 'error',
        error,
      );
      throw unavailable();
    }
  }

  /** At most one read per 5 seconds for this key (`RATE_LIMITED`). */
  private throttle(key: string): void {
    const now = Date.now();
    const last = this.lastReads.get(key);
    if (last !== undefined && now - last < STATEMENT_INTERVAL_MS) {
      throw new CodedException(429, 'RATE_LIMITED', 'One statement read per 5 seconds');
    }
    this.lastReads.set(key, now);
  }

  private async matched(supplier: SupplierRef, rows: SupplierOrderRow[]): Promise<SupplierOrder[]> {
    const matches = await supplierOrderMatches(
      this.db,
      supplier.id,
      rows.map((row) => row.supplierOrderId),
    );
    return rows.map((row) => ({
      supplierOrderId: row.supplierOrderId,
      offerId: row.offerId ?? null,
      offerName: row.offerName ?? null,
      quantity: row.quantity ?? null,
      status: row.status ?? null,
      totalUsdUnits: usdUnits(row.total),
      createdAt: row.createdAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      match: matches.get(row.supplierOrderId) ?? null,
    }));
  }
}
