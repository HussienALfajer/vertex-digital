import { createHash } from 'node:crypto';
import {
  type FieldSpec,
  MAX_FIELD_SPEC_OPTIONS,
  MAX_FIELD_SPECS,
  parseUsd,
} from '@vertex-digital/contracts';
import { z } from 'zod';
import type {
  ImageLimits,
  PlacedOrder,
  PlaceOrderRequest,
  PlayerValidation,
  SupplierAdapter,
  SupplierCapabilities,
  SupplierCategory,
  SupplierMoney,
  SupplierOffer,
  SupplierOrderRow,
  SupplierOutcome,
  SupplierPlatformStatus,
  SupplierStatementPage,
  SupplierTransactionRow,
  SupplierWebhookEvent,
  WebhookRequest,
} from '../core/adapter.js';
import { outcomeOfOrderError, SupplierError } from '../core/errors.js';
import { verifyHmacSignature } from '../core/hmac.js';
import { SupplierHttp, type SupplierRequest } from '../core/http.js';
import { fetchImageFromHosts, imageUrlAllowed } from '../core/image.js';
import { WDG_DEFINITIVE_PURCHASE_CODES, WDG_OUT_OF_STOCK, wdgErrorCode } from './errors.js';
import {
  categoriesReplySchema,
  categorySchema,
  deliveryReplySchema,
  healthReplySchema,
  meReplySchema,
  orderRowSchema,
  productSchema,
  productsPageSchema,
  purchaseReplySchema,
  statementReplySchema,
  transactionRowSchema,
  type WdgCategory,
  type WdgProduct,
  webhookBodySchema,
  webhookTimeSchema,
} from './schemas.js';

/*
 * The `wdgzone` supplier (ADR 0005, docs/suppliers/wdgzone.md): REST with an `X-API-Key` header,
 * idempotent purchases by `X-Idempotency-Key` (the attempt id), polling by WDG's own order id, and
 * webhooks signed with HMAC-SHA256 whose secret is the SHA-256 hex of the API key. It does not
 * check player ids. Its catalog is the `topup` and `voucher` products (WDG's `manual` ones are
 * fulfilled by hand at WDG and left out), read 100 a page within the key's rate limit.
 */

export const WDGZONE_SUPPLIER_CODE = 'wdgzone';

export const WDGZONE_BASE_URL = 'https://wdgzone.tech/api/v1/';

export const WDG_SIGNATURE_HEADER = 'x-wdg-signature';

/** The key's limit is 60 requests a minute: a catalog read leaves this many for orders. */
const RATE_LIMIT_RESERVE = 20;
/** At most this many pages of 100 per product type (5,602 top-ups and 5,975 vouchers listed). */
const MAX_PAGES_PER_TYPE = 300;
const PAGE_SIZE = 100;
/** WDG takes the order and reserves stock before it answers: longer than the default 15 s. */
const PURCHASE_TIMEOUT_MS = 30_000;
/**
 * Webhooks carry no signed timestamp header; the signed body's `created_at` is checked instead.
 * WDG retries a failed delivery 6 times with exponential backoff, keeping the event: a day covers
 * that, the event id stops replays, and polling covers anything later.
 */
const WEBHOOK_TOLERANCE_SECONDS = 24 * 60 * 60;
/** WDG's numeric ids, before they go into a path. */
const WDG_ID_PATTERN = /^[1-9]\d{0,17}$/;
const MAX_IDEMPOTENCY_KEY_LENGTH = 100;

const CATALOG_TYPES = { topup: 'direct', voucher: 'code' } as const;
/** WDG writes unlimited stock as 999999 (S16 SF2). */
const UNLIMITED_STOCK = 999_999;
/** At most this many pages of categories, should WDG ever page them (3,573 on 2026-10-12). */
const MAX_CATEGORY_PAGES = 100;
/** Statement rows per page (S16 SF3). */
const STATEMENT_PAGE_SIZE = 50;
/** The hosts WDG serves category images from (S16 IM1). */
const IMAGE_HOSTS = ['wdgzone.tech'] as const;

export interface WdgzoneAdapterOptions {
  apiKey: string;
  /**
   * The public HTTPS URL of this store's webhook endpoint, sent with every purchase so WDG reports
   * the result; without it the result comes by polling only.
   */
  callbackUrl?: string;
  /** For tests (the local fake server); the supplier's URL lives in code (ADR 0021). */
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

/** A header's whole number, or undefined when it is missing or not one. */
const headerNumber = (headers: Headers, name: string): number | undefined => {
  const value = headers.get(name);
  return value !== null && /^\d{1,12}$/.test(value) ? Number(value) : undefined;
};

/** A WDG amount (a JSON number or decimal string, up to 6 decimals) in micro-dollars, or null. */
const usdUnits = (value: number | string): number | null =>
  parseUsd(String(value), { subCent: true });

export class WdgzoneAdapter implements SupplierAdapter {
  readonly code = WDGZONE_SUPPLIER_CODE;
  readonly capabilities: SupplierCapabilities = {
    validatePlayer: false,
    webhooks: true,
    balance: true,
    catalog: true,
    categories: true,
    statement: true,
    platformStatus: true,
  };

  readonly imageHosts: readonly string[] = IMAGE_HOSTS;

  private readonly http: SupplierHttp;
  private readonly webhookSecret: string;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: WdgzoneAdapterOptions) {
    this.http = new SupplierHttp({
      baseUrl: options.baseUrl ?? WDGZONE_BASE_URL,
      headers: { 'x-api-key': options.apiKey },
      ...(options.fetch && { fetch: options.fetch }),
      ...(options.timeoutMs !== undefined && { timeoutMs: options.timeoutMs }),
    });
    this.webhookSecret = options.apiKey
      ? createHash('sha256').update(options.apiKey, 'utf8').digest('hex')
      : '';
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async listOffers(): Promise<SupplierOffer[]> {
    const offers: SupplierOffer[] = [];
    for (const type of Object.keys(CATALOG_TYPES) as (keyof typeof CATALOG_TYPES)[]) {
      for (let page = 1; ; page += 1) {
        const reply = await this.paced({
          method: 'GET',
          path: `products?type=${type}&limit=${PAGE_SIZE}&page=${page}`,
          schema: productsPageSchema,
          errorCode: wdgErrorCode,
        });
        for (const item of reply.data) {
          const product = productSchema.safeParse(item);
          const offer = product.success ? toOffer(product.data) : null;
          if (offer) offers.push(offer);
        }
        if (reply.data.length === 0 || page >= reply.pagination.total_pages) break;
        if (page >= MAX_PAGES_PER_TYPE) {
          throw new SupplierError('retryable', 'WDGZone catalog is larger than expected');
        }
      }
    }
    return offers;
  }

  /** S16 SC1: the tree of `topup` and `voucher` categories (WDG's `manual` ones are left out). */
  async listCategories(): Promise<SupplierCategory[]> {
    const categories: SupplierCategory[] = [];
    for (let page = 1; ; page += 1) {
      const reply = await this.paced({
        method: 'GET',
        path: page === 1 ? 'categories' : `categories?page=${page}`,
        schema: categoriesReplySchema,
        errorCode: wdgErrorCode,
      });
      for (const item of reply.data) {
        const node = categorySchema.safeParse(item);
        const category = node.success ? this.toCategory(node.data) : null;
        if (category) categories.push(category);
      }
      const pages = reply.pagination;
      if (!pages || reply.data.length === 0 || page >= pages.total_pages) break;
      if (page >= MAX_CATEGORY_PAGES) {
        throw new SupplierError('retryable', 'WDGZone category tree is larger than expected');
      }
    }
    return categories;
  }

  /** S16 SF3: `GET /transactions`, newest first. */
  async listTransactions(page: number): Promise<SupplierStatementPage<SupplierTransactionRow>> {
    const reply = await this.http.request({
      method: 'GET',
      path: `transactions?limit=${STATEMENT_PAGE_SIZE}&page=${page}`,
      schema: statementReplySchema,
      errorCode: wdgErrorCode,
    });
    const items = reply.data.flatMap((item): SupplierTransactionRow[] => {
      const row = transactionRowSchema.safeParse(item);
      if (!row.success || (row.data.currency != null && row.data.currency !== 'USD')) return [];
      const { data } = row;
      const amount = signedUsd(data.amount);
      const balanceAfter = signedUsd(data.balance_after);
      const createdAt = dateOf(data.created_at);
      const reference = (data.reference ?? data.description)?.trim().slice(0, 200);
      return [
        {
          id: data.id.slice(0, 64),
          ...(data.type && { type: data.type.slice(0, 64) }),
          ...(amount && { amount }),
          ...(balanceAfter && { balanceAfter }),
          ...(reference && { reference }),
          ...(data.order_id && { supplierOrderId: data.order_id.slice(0, 64) }),
          ...(createdAt && { createdAt }),
        },
      ];
    });
    return { items, hasMore: hasMore(page, reply) };
  }

  /** S16 SF3: `GET /orders`, newest first. */
  async listOrders(page: number): Promise<SupplierStatementPage<SupplierOrderRow>> {
    const reply = await this.http.request({
      method: 'GET',
      path: `orders?limit=${STATEMENT_PAGE_SIZE}&page=${page}`,
      schema: statementReplySchema,
      errorCode: wdgErrorCode,
    });
    const items = reply.data.flatMap((item): SupplierOrderRow[] => {
      const row = orderRowSchema.safeParse(item);
      if (!row.success) return [];
      const { data } = row;
      const total = data.currency == null || data.currency === 'USD' ? signedUsd(data.total) : null;
      const createdAt = dateOf(data.created_at);
      const offerName = (data.product_name ?? data.product)?.trim().slice(0, 200);
      return [
        {
          supplierOrderId: data.id.slice(0, 64),
          ...(data.product_id && { offerId: data.product_id.slice(0, 64) }),
          ...(offerName && { offerName }),
          ...(data.quantity != null && { quantity: data.quantity }),
          ...(data.status && { status: data.status.slice(0, 64) }),
          ...(total && { total }),
          ...(createdAt && { createdAt }),
        },
      ];
    });
    return { items, hasMore: hasMore(page, reply) };
  }

  /** S16 SF5: `GET /health`, which needs no key. */
  async getPlatformStatus(): Promise<SupplierPlatformStatus> {
    const reply = await this.http.request({
      method: 'GET',
      path: 'health',
      schema: healthReplySchema,
      errorCode: wdgErrorCode,
    });
    const catalogUpdatedAt = dateOf(reply.catalog_updated_at);
    return { status: reply.status, ...(catalogUpdatedAt && { catalogUpdatedAt }) };
  }

  /** S16 IM1: without the API key, from `wdgzone.tech` only. */
  fetchImage(url: string, limits: ImageLimits): Promise<Uint8Array> {
    return fetchImageFromHosts(url, this.imageHosts, limits, this.options.fetch);
  }

  /** A node as a category; WDG's `manual` ones are left out, as their products are. */
  private toCategory(node: WdgCategory): SupplierCategory | null {
    if (node.type === 'manual') return null;
    const kind = node.type ? CATALOG_TYPES[node.type as keyof typeof CATALOG_TYPES] : undefined;
    const name = node.name.trim().slice(0, 200);
    if (!name) return null;
    const imageUrl = node.image_url?.trim();
    const imageOk =
      imageUrl !== undefined &&
      imageUrl.length <= 500 &&
      imageUrlAllowed(imageUrl, this.imageHosts);
    return {
      categoryId: String(node.id),
      ...(node.parent_id != null && { parentCategoryId: String(node.parent_id) }),
      name,
      ...(kind && { kind }),
      ...(node.product_count != null && { productCount: node.product_count }),
      ...(node.in_stock_products != null && { inStockCount: node.in_stock_products }),
      ...(imageOk && { imageUrl }),
    };
  }

  async getBalance(): Promise<SupplierMoney> {
    const reply = await this.http.request({
      method: 'GET',
      path: 'me',
      schema: meReplySchema,
      errorCode: wdgErrorCode,
    });
    const amountUnits = usdUnits(reply.data.balance);
    if (reply.data.currency !== 'USD' || amountUnits === null) {
      throw new SupplierError('retryable', 'WDGZone balance has an unexpected amount or currency');
    }
    return { currency: 'USD', amountUnits };
  }

  async validatePlayer(): Promise<PlayerValidation> {
    throw new SupplierError('definitive', 'WDGZone does not check player ids');
  }

  async placeOrder(request: PlaceOrderRequest): Promise<SupplierOutcome> {
    const fields = Object.values(request.fields);
    // Refused before anything is sent: nothing was bought.
    if (!WDG_ID_PATTERN.test(request.offerId)) {
      return refused('PRODUCT_NOT_FOUND', 'Not a WDGZone product id');
    }
    if (request.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      return refused('IDEMPOTENCY_KEY_TOO_LONG', 'Idempotency key longer than WDGZone takes');
    }
    // WDG takes one account field, as `player_id`; how it takes a second one is not documented.
    if (fields.length > 1) {
      return refused('FIELDS_UNSUPPORTED', 'WDGZone takes one account field per order');
    }
    const playerId = fields[0];
    try {
      const reply = await this.http.request({
        method: 'POST',
        path: `products/${request.offerId}/purchase`,
        headers: { 'x-idempotency-key': request.idempotencyKey },
        body: {
          quantity: request.quantity,
          ...(playerId !== undefined && playerId !== '' && { player_id: playerId }),
          ...(this.options.callbackUrl && { callback_url: this.options.callbackUrl }),
        },
        schema: purchaseReplySchema,
        errorCode: wdgErrorCode,
        definitiveCodes: WDG_DEFINITIVE_PURCHASE_CODES,
        timeoutMs: this.options.timeoutMs ?? PURCHASE_TIMEOUT_MS,
      });
      const supplierOrderId = String(reply.data.order_id);
      if (reply.data.status.toLowerCase() !== 'completed') {
        // Any other state is followed by polling, whose 200 and 410 are the documented ends.
        return { status: 'pending', supplierOrderId };
      }
      return delivered(supplierOrderId, request.quantity, reply.data.delivery_items);
    } catch (error) {
      if (
        error instanceof SupplierError &&
        error.details.status === 409 &&
        error.details.supplierCode === WDG_OUT_OF_STOCK
      ) {
        // Stock is reserved with the order: out of stock means no order was made.
        return refused(WDG_OUT_OF_STOCK, 'Out of stock at WDGZone');
      }
      return outcomeOfOrderError(error);
    }
  }

  async getOrder(_idempotencyKey: string, placed?: PlacedOrder): Promise<SupplierOutcome> {
    const supplierOrderId = placed?.supplierOrderId;
    if (!placed || !supplierOrderId || !WDG_ID_PATTERN.test(supplierOrderId)) {
      // WDG finds orders by its own id only; a re-sent purchase with the key finds it instead.
      return { status: 'unknown', reason: 'No WDGZone order id to look up' };
    }
    try {
      const reply = await this.http.send({
        method: 'GET',
        path: `orders/${supplierOrderId}/delivery`,
        schema: z.unknown(),
        errorCode: wdgErrorCode,
      });
      if (reply.status === 202) return { status: 'pending', supplierOrderId };
      const ready = deliveryReplySchema.safeParse(reply.data);
      if (reply.status !== 200 || !ready.success) {
        return { status: 'unknown', supplierOrderId, reason: 'WDGZone delivery reply unexpected' };
      }
      const { quantity, delivery_items: items } = ready.data.data;
      if (quantity !== undefined && quantity !== placed.quantity) {
        return { status: 'unknown', supplierOrderId, reason: 'WDGZone delivered other units' };
      }
      return delivered(supplierOrderId, placed.quantity, items);
    } catch (error) {
      if (error instanceof SupplierError && error.details.status === 410) {
        return {
          status: 'failed_definitive',
          supplierOrderId,
          supplierCode: error.details.supplierCode ?? 'ORDER_FAILED',
          reason: 'Failed and refunded by WDGZone',
        };
      }
      // Not found, a timeout or an error page: never a failure (the order may exist).
      const reason = error instanceof Error ? error.message : String(error);
      return { status: 'unknown', supplierOrderId, reason };
    }
  }

  verifyWebhook(request: WebhookRequest, now?: Date): boolean {
    const header = request.headers[WDG_SIGNATURE_HEADER];
    if (!header?.startsWith('sha256=')) return false;
    let createdAt: number;
    try {
      createdAt = Date.parse(webhookTimeSchema.parse(JSON.parse(request.rawBody)).created_at);
    } catch {
      return false;
    }
    if (!Number.isFinite(createdAt)) return false;
    return verifyHmacSignature({
      secret: this.webhookSecret,
      signedPayload: request.rawBody,
      signature: header.slice('sha256='.length),
      timestamp: createdAt / 1000,
      toleranceSeconds: WEBHOOK_TOLERANCE_SECONDS,
      now: now ?? this.now(),
    });
  }

  parseWebhook(request: WebhookRequest): SupplierWebhookEvent {
    let body: z.infer<typeof webhookBodySchema>;
    try {
      body = webhookBodySchema.parse(JSON.parse(request.rawBody));
    } catch (cause) {
      throw new SupplierError('definitive', 'Malformed WDGZone webhook', { cause });
    }
    const supplierOrderId = String(body.data.order_id);
    if (body.event === 'order.completed') {
      if (body.data.refunded === true) {
        throw new SupplierError('definitive', 'WDGZone webhook is completed and refunded');
      }
      return {
        eventId: body.id,
        supplierOrderId,
        outcome: delivered(supplierOrderId, body.data.quantity, body.data.delivery_items),
      };
    }
    return {
      eventId: body.id,
      supplierOrderId,
      outcome: {
        status: 'failed_definitive',
        supplierOrderId,
        supplierCode: body.event,
        reason: 'Failed by WDGZone',
      },
    };
  }

  /** A catalog page, then a pause until the window resets when few requests are left in it. */
  private async paced<T>(request: SupplierRequest<T>): Promise<T> {
    const reply = await this.http.send(request);
    const remaining = headerNumber(reply.headers, 'x-ratelimit-remaining');
    const reset = headerNumber(reply.headers, 'x-ratelimit-reset');
    if (remaining !== undefined && reset !== undefined && remaining <= RATE_LIMIT_RESERVE) {
      const waitMs = Math.min(reset * 1000 - this.now().getTime() + 1000, 61_000);
      if (waitMs > 0) await this.sleep(waitMs);
    }
    return reply.data;
  }
}

/** A WDG product's account fields as field specs (S16 SC3), bounded; null when unreadable. */
function fieldSpecsOf(product: WdgProduct): FieldSpec[] | null {
  const fields = product.required_fields ?? [];
  if (fields.length === 0) {
    return product.requires_player_id
      ? [{ key: 'player_id', label: 'Player ID', type: 'text' }]
      : [];
  }
  if (fields.length > MAX_FIELD_SPECS) return null;
  const specs: FieldSpec[] = [];
  for (const field of fields) {
    if (!/^[A-Za-z0-9_.-]{1,32}$/.test(field.key)) return null;
    const type = field.type == null || field.type === 'text' ? 'text' : 'select';
    const options = (field.options ?? []).slice(0, MAX_FIELD_SPEC_OPTIONS).flatMap((option) => {
      const value = String(option.value).slice(0, 64);
      return value ? [{ label: (option.label ?? value).slice(0, 64), value }] : [];
    });
    specs.push({
      key: field.key,
      label: (field.label ?? field.key).trim().slice(0, 64),
      type,
      ...(type === 'select' && { options }),
    });
  }
  return specs;
}

/** A WDG product as an offer, or null when it cannot be listed through this adapter. */
function toOffer(product: WdgProduct): SupplierOffer | null {
  const kind = CATALOG_TYPES[product.type as keyof typeof CATALOG_TYPES];
  const amountUnits = usdUnits(product.price);
  if (!kind || product.currency !== 'USD' || amountUnits === null) return null;
  const fieldSpecs = fieldSpecsOf(product);
  if (fieldSpecs === null) return null;
  // One free-text field, sent as `player_id`. Two fields or a list (`select`: region, server) are
  // kept, but unsupported until WDG says how they are sent (S16 SC3, Q19).
  const unsupported = fieldSpecs.length > 1 || fieldSpecs.some((field) => field.type !== 'text');
  const group = product.brand?.trim() || product.category?.trim() || undefined;
  const category = product.category?.trim();
  const original = product.original_price == null ? null : usdUnits(product.original_price);
  const stock =
    product.stock == null || product.stock < 0 || product.stock >= UNLIMITED_STOCK
      ? undefined
      : product.stock;
  return {
    offerId: String(product.id),
    name:
      category && category !== group && category !== product.name
        ? `${category} · ${product.name}`
        : product.name,
    cost: { currency: 'USD', amountUnits },
    inStock: product.available && (product.stock == null || product.stock > 0),
    ...(group && { group }),
    kind,
    requiredFields: fieldSpecs.map((field) => field.key),
    ...(product.category_id != null && { categoryId: String(product.category_id) }),
    ...(stock !== undefined && { stock }),
    ...(original !== null &&
      original > 0 && { originalCost: { currency: 'USD', amountUnits: original } }),
    fieldSpecs,
    ...(unsupported && { unsupportedReason: 'fields_unsupported' as const }),
  };
}

/** A signed WDG amount in USD (a purchase is negative on the statement), or null. */
function signedUsd(value: number | string | null | undefined): SupplierMoney | null {
  if (value == null) return null;
  const text = String(value).trim();
  const negative = text.startsWith('-');
  const units = usdUnits(negative ? text.slice(1) : text);
  return units === null ? null : { currency: 'USD', amountUnits: negative ? -units : units };
}

/** A WDG time, or null when it does not parse. */
function dateOf(value: string | null | undefined): Date | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time) : null;
}

/** Whether a statement page has a next one: by `pagination`, else by a full page. */
function hasMore(
  page: number,
  reply: { data: unknown[]; pagination?: { total_pages: number } | null | undefined },
): boolean {
  return reply.pagination
    ? page < reply.pagination.total_pages
    : reply.data.length >= STATEMENT_PAGE_SIZE;
}

function delivered(
  supplierOrderId: string,
  quantity: number,
  items: readonly string[] | null | undefined,
): SupplierOutcome {
  return {
    status: 'delivered',
    supplierOrderId,
    quantity,
    ...(items && items.length > 0 && { codes: [...items] }),
  };
}

function refused(supplierCode: string, reason: string): SupplierOutcome {
  return { status: 'failed_definitive', supplierCode, reason };
}
