import { createHash } from 'node:crypto';
import type { FieldSpec } from '@vertex-digital/contracts';
import type {
  ImageLimits,
  PlacedOrder,
  PlaceOrderRequest,
  PlayerValidation,
  SupplierAccount,
  SupplierAdapter,
  SupplierCapabilities,
  SupplierCategory,
  SupplierCheckCategory,
  SupplierMoney,
  SupplierOffer,
  SupplierOfferQuote,
  SupplierOfferWindow,
  SupplierOrderRow,
  SupplierOutcome,
  SupplierPlatformStatus,
  SupplierStatementPage,
  SupplierTransactionRow,
  SupplierWebhookDeliveryRow,
  SupplierWebhookEvent,
  SupplierWebhookState,
} from '../core/adapter.js';
import { notSupported, outcomeOfOrderError, SupplierError } from '../core/errors.js';
import { SupplierHttp } from '../core/http.js';
import { fetchImageFromHosts, imageUrlAllowed } from '../core/image.js';
import { usdUnitsOf } from './decimal.js';
import {
  checkReplySchema,
  newOrderReplySchema,
  productSchema,
  productsReplySchema,
  profileReplySchema,
  type ZddkProduct,
} from './schemas.js';

/*
 * A store on the zddk platform (S25, ADR 0039, docs/suppliers/jneedcontur.md): a reseller API
 * under `https://api.<store>/client/api/` with an `api-token` header, every call a `GET`. One
 * adapter serves every zddk store; the store's host lives in code per supplier code (ZD1), never
 * typed in the panel. Offer ids (ZD4): `<product>` for a package, `<product>:<value>` for one value
 * of a fixed value list, `<product>@100` for an amount product (one unit of ours is 100 of the
 * supplier's). Orders carry a UUID derived from the attempt id as `order_uuid` (ZD5), and are read
 * back by it (ZD7). No player check, webhook (unsigned: never used), statement or status.
 *
 * Until the supplier answers Q31, Q32 and Q34 (docs/open-questions.md) the adapter is on the safe
 * side: only offers with one field (sent as `playerId`) are sold, every reply outside the
 * documented success shape is `unknown`, and a key the supplier does not know stays `unknown`.
 */

/** ZD1: the zddk stores this build talks to, by supplier code. */
export const ZDDK_STORES = {
  jneedcontur: { host: 'api.jneedcontur.net' },
} as const;

export type ZddkStore = keyof typeof ZDDK_STORES;

/** ZD1: 15 s per request, 30 s for an order. */
const TIMEOUT_MS = 15_000;
const ORDER_TIMEOUT_MS = 30_000;
/** ZD4: one unit of an amount offer is 100 of the supplier's (100 SYP). */
const AMOUNT_STEP = 100;
const PRODUCT_ID = /^\d{1,10}$/;
/** A value of a fixed value list as the supplier writes it (`1000`, `96.15`). */
const LIST_VALUE = /^\d{1,9}(?:\.\d{1,6})?$/;
const OFFER_ID = /^(\d{1,10})(?:(:)(\d{1,9}(?:\.\d{1,6})?)|(@100))?$/;
const ORDER_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** A category image: a path on the store's host (`images/category/1710948113.webp`). */
const IMAGE_PATH = /^\/?[A-Za-z0-9_-][A-Za-z0-9_./-]{0,299}$/;
/** ZD8: the delivery text kept on the attempt for the admin. */
const MAX_REFERENCE_LENGTH = 200;
/** The quantity the supplier takes, at most (an amount order's value, a value list's value). */
const MAX_SUPPLIER_QUANTITY = 1_000_000_000;
/** The most units an offer may bound (the sync drops larger bounds, which would leave none). */
const MAX_OFFER_QUANTITY = 1_000_000;
/** A package or one value of a value list is one unit a time (RT4 skips the route for more). */
const ONE_UNIT = { minQuantity: 1, maxQuantity: 1 } as const;
/** RN3: the one field every sold offer takes, under the key the documentation names. */
const PLAYER_ID = 'playerId';
const MAX_FIELD_VALUE_LENGTH = 128;

export interface ZddkAdapterOptions {
  /** The zddk store, which is the supplier code (`jneedcontur`). */
  store: ZddkStore;
  apiToken: string;
  /** For tests (the local fake server); the store's URL lives in code (ZD1). */
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * ZD5: the `order_uuid` of an attempt: a UUID with the version 4 layout derived from the attempt
 * id (SHA-256, the version and variant bits set), so every send of the attempt carries the same
 * key; computed, never stored.
 */
export function zddkOrderUuid(idempotencyKey: string): string {
  const bytes = createHash('sha256').update(idempotencyKey, 'utf8').digest().subarray(0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type OfferShape =
  | { kind: 'package'; productId: string }
  | { kind: 'value'; productId: string; value: string }
  | { kind: 'amount'; productId: string };

/** An offer id read back, or null. */
function offerShape(offerId: string): OfferShape | null {
  const match = OFFER_ID.exec(offerId);
  if (!match) return null;
  const productId = match[1] as string;
  if (match[2]) return { kind: 'value', productId, value: match[3] as string };
  if (match[4]) return { kind: 'amount', productId };
  return { kind: 'package', productId };
}

export class ZddkAdapter implements SupplierAdapter {
  readonly code: ZddkStore;
  readonly capabilities: SupplierCapabilities = {
    validatePlayer: false,
    webhooks: false,
    balance: true,
    catalog: true,
    categories: true,
    statement: false,
    platformStatus: false,
    offerQuote: true,
    offerWindow: false,
    account: false,
  };

  readonly imageHosts: readonly string[];

  private readonly http: SupplierHttp;

  constructor(private readonly options: ZddkAdapterOptions) {
    const { host } = ZDDK_STORES[options.store];
    this.code = options.store;
    this.imageHosts = [host];
    this.http = new SupplierHttp({
      baseUrl: options.baseUrl ?? `https://${host}/client/api/`,
      headers: { 'api-token': options.apiToken },
      ...(options.fetch && { fetch: options.fetch }),
      timeoutMs: options.timeoutMs ?? TIMEOUT_MS,
    });
  }

  /** ZD3, ZD4: one `GET products`; a product that cannot be read is left out. */
  async listOffers(): Promise<SupplierOffer[]> {
    return (await this.products()).flatMap((product) => this.offersOf(product));
  }

  /**
   * ZD3: the categories the products are listed in (`parent_id`, `category_name`,
   * `category_img`), flat: `content/<id>`'s reply is not documented, so the tree's own parents are
   * not read (docs/suppliers/jneedcontur.md).
   */
  async listCategories(): Promise<SupplierCategory[]> {
    const categories = new Map<string, SupplierCategory>();
    for (const product of await this.products()) {
      const categoryId = categoryIdOf(product);
      const name = product.category_name?.trim().slice(0, 200);
      if (!categoryId || !name) continue;
      const known = categories.get(categoryId);
      const productCount = (known?.productCount ?? 0) + 1;
      const inStockCount = (known?.inStockCount ?? 0) + (product.available ? 1 : 0);
      const imageUrl = known?.imageUrl ?? this.imageUrlOf(product.category_img);
      categories.set(categoryId, {
        categoryId,
        name: known?.name ?? name,
        productCount,
        inStockCount,
        ...(imageUrl && { imageUrl }),
      });
    }
    return [...categories.values()];
  }

  /** ZD9: `GET profile`; the balance is read as USD until Q35 says otherwise. */
  async getBalance(): Promise<SupplierMoney> {
    const reply = await this.http.request({
      method: 'GET',
      path: 'profile',
      schema: profileReplySchema,
    });
    const amountUnits = usdUnitsOf(reply.balance);
    if (amountUnits === null) {
      throw new SupplierError('retryable', `${this.code} balance is not an exact amount`, {
        failure: 'unreadable',
      });
    }
    return { currency: 'USD', amountUnits };
  }

  /** S18 PQ1: `GET products?products_id=<id>`, the offer's cost and availability now. */
  async getOfferQuote(offerId: string): Promise<SupplierOfferQuote> {
    const shape = offerShape(offerId);
    if (!shape) {
      throw new SupplierError('definitive', `Not a ${this.code} offer id`, {
        supplierCode: 'PRODUCT_NOT_FOUND',
      });
    }
    const products = await this.products(`products?products_id=${shape.productId}`);
    const offer = products
      .filter((product) => String(product.id) === shape.productId)
      .flatMap((product) => this.offersOf(product))
      .find((candidate) => candidate.offerId === offerId);
    if (!offer) {
      throw new SupplierError('definitive', `${this.code} no longer lists this offer`, {
        supplierCode: 'PRODUCT_NOT_FOUND',
      });
    }
    if (offer.unsupportedReason === 'cost_precision') {
      throw new SupplierError('retryable', `${this.code} cost is not an exact amount`, {
        failure: 'unreadable',
      });
    }
    return { cost: offer.cost, inStock: offer.inStock };
  }

  /**
   * ZD6: `GET newOrder/<product>/params?qty=…&playerId=…&order_uuid=…`. The URL is never logged
   * (the recipient is in it); every reply outside the documented success shape is `unknown` (Q32).
   */
  async placeOrder(request: PlaceOrderRequest): Promise<SupplierOutcome> {
    // Refused before anything is sent: nothing was bought.
    const shape = offerShape(request.offerId);
    if (!shape) return refused('PRODUCT_NOT_FOUND', `Not a ${this.code} offer id`);
    const qty = supplierQuantity(shape, request.quantity);
    if (qty === null) {
      return refused('QUANTITY_UNSUPPORTED', `${this.code} takes other units for this offer`);
    }
    const keys = Object.keys(request.fields);
    if (keys.some((key) => key !== PLAYER_ID)) {
      return refused('FIELDS_UNSUPPORTED', `${this.code} takes one field, ${PLAYER_ID}`);
    }
    const playerId = request.fields[PLAYER_ID];
    if (
      playerId !== undefined &&
      (playerId.trim() === '' || playerId.length > MAX_FIELD_VALUE_LENGTH)
    ) {
      return refused(
        'FIELDS_UNSUPPORTED',
        `${this.code} takes a ${PLAYER_ID} of 1 to 128 characters`,
      );
    }
    const query = new URLSearchParams({ qty });
    if (playerId !== undefined) query.set(PLAYER_ID, playerId);
    query.set('order_uuid', zddkOrderUuid(request.idempotencyKey));
    try {
      const reply = await this.http.request({
        method: 'GET',
        path: `newOrder/${shape.productId}/params?${query}`,
        schema: newOrderReplySchema,
        timeoutMs: this.options.timeoutMs ?? ORDER_TIMEOUT_MS,
      });
      return this.outcomeOf(reply.data, request.quantity, shape.kind !== 'amount');
    } catch (error) {
      return outcomeOfOrderError(error);
    }
  }

  /**
   * ZD7: `GET check?orders=[<key>]&uuid=1`. A key the supplier does not know is `unknown`, answered
   * (Q34: whether that means no order was made is not confirmed); the poll then re-sends the order
   * with the same key, which the supplier documents as returning the original order.
   */
  async getOrder(idempotencyKey: string, placed?: PlacedOrder): Promise<SupplierOutcome> {
    const supplierOrderId = placed?.supplierOrderId;
    const kept = supplierOrderId ? { supplierOrderId } : {};
    try {
      const reply = await this.http.request({
        method: 'GET',
        path: `check?orders=[${zddkOrderUuid(idempotencyKey)}]&uuid=1`,
        schema: checkReplySchema,
      });
      if (reply.data.length === 0) {
        return {
          status: 'unknown',
          reason: `${this.code} knows no order with this key`,
          answered: true,
          ...kept,
        };
      }
      const [order] = reply.data;
      if (reply.data.length > 1 || !order || !placed) {
        return {
          status: 'unknown',
          reason: placed ? `${this.code} listed several orders for one key` : 'No units to settle',
          answered: true,
          ...kept,
        };
      }
      return this.outcomeOf(order, placed.quantity, placed.quantity === 1);
    } catch (error) {
      // No poll refusal is definitive (no code is mapped): the order may exist whatever the reply.
      return { ...outcomeOfOrderError(error), ...kept } as SupplierOutcome;
    }
  }

  /** ZD3, IM1: a category image, without the token, from the store's host only. */
  fetchImage(url: string, limits: ImageLimits): Promise<Uint8Array> {
    return fetchImageFromHosts(url, this.imageHosts, limits, this.options.fetch);
  }

  validatePlayer(): Promise<PlayerValidation> {
    return notSupported(this.code, 'check player ids');
  }

  listCheckCategories(): Promise<SupplierCheckCategory[]> {
    return notSupported(this.code, 'check player ids');
  }

  /** The store's webhook is unsigned (S25 Out): never accepted. */
  verifyWebhook(): boolean {
    return false;
  }

  parseWebhook(): SupplierWebhookEvent {
    throw new SupplierError('definitive', `${this.code} webhooks are not accepted`);
  }

  listTransactions(): Promise<SupplierStatementPage<SupplierTransactionRow>> {
    return notSupported(this.code, 'list its statement');
  }

  listOrders(): Promise<SupplierStatementPage<SupplierOrderRow>> {
    return notSupported(this.code, 'list its orders');
  }

  getPlatformStatus(): Promise<SupplierPlatformStatus> {
    return notSupported(this.code, 'report its status');
  }

  listOffersIn(): Promise<SupplierOfferWindow> {
    return notSupported(this.code, 'read its catalog by category');
  }

  getAccount(): Promise<SupplierAccount> {
    return notSupported(this.code, 'report a plan');
  }

  getWebhook(): Promise<{ state: SupplierWebhookState; deliveries: SupplierWebhookDeliveryRow[] }> {
    return notSupported(this.code, 'manage its webhook');
  }

  setWebhook(): Promise<SupplierWebhookState> {
    return notSupported(this.code, 'manage its webhook');
  }

  testWebhook(): Promise<void> {
    return notSupported(this.code, 'manage its webhook');
  }

  private async products(path = 'products'): Promise<ZddkProduct[]> {
    const items = await this.http.request({ method: 'GET', path, schema: productsReplySchema });
    return items.flatMap((item) => {
      const product = productSchema.safeParse(item);
      return product.success ? [product.data] : [];
    });
  }

  /**
   * ZD4: a product's offers: one package (no value list), one offer per value of a value list, or
   * one `@100` offer for a range. Kept unsupported: several fields, or none (Q31: a product without
   * a field may deliver codes, which this build cannot tell before buying), and a cost that is not
   * a whole number of micro-dollars after its multiplier.
   */
  private offersOf(product: ZddkProduct): SupplierOffer[] {
    const productId = String(product.id);
    if (!PRODUCT_ID.test(productId)) return [];
    const name = product.name.trim().slice(0, 200);
    const labels = (product.params ?? []).map((label) =>
      typeof label === 'string' ? label.trim().slice(0, 64) : null,
    );
    const label = labels.length === 1 ? labels[0] : null;
    const fieldSpecs: FieldSpec[] = label ? [{ key: PLAYER_ID, label, type: 'text' }] : [];
    const categoryId = categoryIdOf(product);
    const group = product.category_name?.trim().slice(0, 200);
    const common = {
      inStock: product.available,
      requiredFields: fieldSpecs.map((spec) => spec.key),
      fieldSpecs,
      ...(group && { group }),
      ...(categoryId && { categoryId }),
    };
    const offer = (
      offerId: string,
      offerName: string,
      multiplier: number | string,
      extra: Partial<SupplierOffer>,
    ): SupplierOffer[] => {
      const exact = usdUnitsOf(product.price, multiplier);
      const shown = exact ?? usdUnitsOf(product.price, multiplier, { roundUp: true });
      if (shown === null) return [];
      const original =
        product.base_price == null ? null : usdUnitsOf(product.base_price, multiplier);
      const unsupportedReason =
        exact === null ? 'cost_precision' : label ? undefined : 'fields_unsupported';
      return [
        {
          offerId,
          name: offerName.slice(0, 200),
          cost: { currency: 'USD', amountUnits: shown },
          ...common,
          ...extra,
          ...(original !== null && { originalCost: { currency: 'USD', amountUnits: original } }),
          ...(unsupportedReason && { unsupportedReason }),
        },
      ];
    };

    const values = product.qty_values;
    if (values == null) return offer(productId, name, 1, { kind: 'direct', ...ONE_UNIT });
    if (Array.isArray(values)) {
      const seen = new Set<string>();
      return values.flatMap((value) => {
        const text = String(value).trim();
        if (!LIST_VALUE.test(text) || seen.has(text) || Number(text) <= 0) return [];
        seen.add(text);
        return offer(`${productId}:${text}`, `${name} · ${text}`, text, {
          kind: 'direct',
          ...ONE_UNIT,
        });
      });
    }
    // A range: one unit of ours is 100 of the supplier's, within its bounds.
    const min = Number(String(values.min).trim());
    const max = Number(String(values.max).trim());
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 1) return [];
    const minQuantity = Math.ceil(min / AMOUNT_STEP);
    const maxQuantity = Math.min(Math.floor(max / AMOUNT_STEP), MAX_OFFER_QUANTITY);
    // A range that holds no whole unit of 100 is not an offer (AM3: never routed unbounded).
    if (maxQuantity < minQuantity) return [];
    return offer(`${productId}@100`, name, AMOUNT_STEP, {
      kind: 'amount',
      minQuantity,
      maxQuantity,
    });
  }

  /** ZD6, ZD7: an order's state as an outcome for the attempt's `quantity` units. */
  private outcomeOf(
    order: {
      order_id: string;
      status: string;
      price?: number | string | null;
      replay_api?: unknown;
    },
    quantity: number,
    /**
     * Whether `price` is read as the charge: not for an amount order until the pilot shows whether
     * it is the order's total or one SYP's price (a unit price read as the total would reprice the
     * offer far too low through S18's charge check). The poll, which does not know the offer, reads
     * it for one-unit orders only: an amount order is at least 10 units (1,000 SYP, D12).
     */
    readCharge: boolean,
  ): SupplierOutcome {
    if (!ORDER_ID.test(order.order_id)) {
      return { status: 'unknown', reason: `${this.code} order id unexpected`, answered: true };
    }
    const supplierOrderId = order.order_id;
    const charged = !readCharge || order.price == null ? null : usdUnitsOf(order.price);
    const chargedUsdUnits = charged === null ? {} : { chargedUsdUnits: charged };
    switch (order.status.toLowerCase()) {
      case 'accept': {
        const reference = referenceOf(order.replay_api);
        return {
          status: 'delivered',
          supplierOrderId,
          quantity,
          ...chargedUsdUnits,
          ...(reference && { reference }),
        };
      }
      case 'wait':
        return { status: 'pending', supplierOrderId, ...chargedUsdUnits };
      case 'reject':
        return {
          status: 'failed_definitive',
          supplierOrderId,
          supplierCode: 'reject',
          reason: `Rejected by ${this.code}`,
        };
      default:
        return {
          status: 'unknown',
          supplierOrderId,
          reason: `${this.code} order state unexpected`,
          answered: true,
        };
    }
  }

  /** IM1: the category image on the store's host, from a relative path or an HTTPS URL. */
  private imageUrlOf(image: string | null | undefined): string | undefined {
    const text = image?.trim();
    if (!text) return undefined;
    if (/^https:\/\//i.test(text)) {
      return text.length <= 500 && imageUrlAllowed(text, this.imageHosts) ? text : undefined;
    }
    if (!IMAGE_PATH.test(text) || text.split('/').includes('..')) return undefined;
    return new URL(text.replace(/^\//, ''), `https://${this.imageHosts[0]}/`).href;
  }
}

/** S16 SC3: `category.<parent_id>`; a product on the store's home page (0) has none. */
function categoryIdOf(product: ZddkProduct): string | undefined {
  return product.parent_id ? `category.${product.parent_id}` : undefined;
}

/**
 * ZD6, AM3: the `qty` the supplier takes: 1 for a package, the value for a value list (one unit at
 * a time), `quantity × 100` for an amount offer; null for units the offer cannot take.
 */
function supplierQuantity(shape: OfferShape, quantity: number): string | null {
  if (!Number.isSafeInteger(quantity) || quantity < 1) return null;
  if (shape.kind === 'amount') {
    return quantity * AMOUNT_STEP <= MAX_SUPPLIER_QUANTITY ? String(quantity * AMOUNT_STEP) : null;
  }
  if (quantity !== 1) return null;
  return shape.kind === 'value' ? shape.value : '1';
}

/**
 * ZD8: the provider's texts in `replay_api` (`[{ replay: [...] }]` or `[...]`), joined, without
 * control characters, at most 200 characters; undefined when there is none.
 */
function referenceOf(replay: unknown): string | undefined {
  const texts: string[] = [];
  const collect = (value: unknown, depth: number): void => {
    if (depth > 3 || texts.length >= 10) return;
    if (typeof value === 'string' || typeof value === 'number') {
      const text = String(value)
        .replace(/\p{Cc}+/gu, ' ')
        .trim();
      if (text) texts.push(text);
    } else if (Array.isArray(value)) {
      for (const item of value) collect(item, depth + 1);
    } else if (value && typeof value === 'object' && 'replay' in value) {
      collect((value as { replay: unknown }).replay, depth + 1);
    }
  };
  collect(replay, 0);
  const reference = texts.join(' · ').slice(0, MAX_REFERENCE_LENGTH).trim();
  return reference || undefined;
}

function refused(supplierCode: string, reason: string): SupplierOutcome {
  return { status: 'failed_definitive', supplierCode, reason };
}
