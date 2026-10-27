import { createHash } from 'node:crypto';
import {
  type FailureKind,
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
  WebhookRequest,
} from '../core/adapter.js';
import { notSupported, outcomeOfOrderError, SupplierError } from '../core/errors.js';
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
  orderStateReplySchema,
  productReplySchema,
  productSchema,
  productsPageSchema,
  purchaseReplySchema,
  refundedReplySchema,
  statementReplySchema,
  transactionRowSchema,
  type WdgCategory,
  type WdgDeliveryItem,
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
/** S18 PQ1: a quote that takes longer is skipped and the order sent as before. */
const QUOTE_TIMEOUT_MS = 5_000;
/** S18 SY1: a catalog page is read at most this many more times, after these waits. */
const PAGE_RETRY_DELAYS_MS = [2_000, 5_000] as const;
/** S18 SY1: failures a page is read again after; a refusal (401, 403, 404) is not. */
const PAGE_RETRY_FAILURES: ReadonlySet<FailureKind> = new Set([
  'timeout',
  'dns',
  'connect',
  'tls',
  'rate_limited',
  'http_5xx',
  'unreadable',
  'other',
]);
/** S18 SY1: at most this long for a rate limit to lift. */
const RATE_LIMIT_MAX_WAIT_MS = 61_000;
/**
 * S18 TZ1: WDG writes times without an offset in UTC+4 (`/health` gives `catalog_updated_at` 4
 * hours ahead of its own UTC `time`; order 3940's `00:53:16` was our attempt at `20:53:16Z`).
 */
const WDG_TIME_OFFSET = '+04:00';
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
/**
 * S16 MF1: with several fields, `player_id` carries the account field: the field keyed
 * `player_id`, else the first of these present (a field map's key order is not kept, so "first"
 * is this list's order).
 */
const ACCOUNT_FIELD_KEYS = ['player_id', 'user_id', 'uid', 'role_id', 'riot_id', 'id'] as const;
/** S06's bounds of a select (S16 MF2): a supplier select outside them cannot be mapped. */
const SELECT_OPTIONS_MIN = 2;
/** S08's limit of a code's text (S16 MF4: a pin is kept in it). */
const MAX_CODE_LENGTH = 200;
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
  /** S18 SY2: told of each catalog page read again, for the caller's log. */
  onRetry?: (retry: PageRetry) => void;
}

/** S18 SY2: a catalog page read again, and why. */
export interface PageRetry {
  path: string;
  attempt: number;
  failure: FailureKind;
  status?: number;
  waitMs: number;
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
    offerQuote: true,
    offerWindow: false,
    account: false,
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

  /** S19: the catalog is read whole (`listOffers`), with no account reads. */
  listOffersIn(): Promise<SupplierOfferWindow> {
    return notSupported('WDGZone', 'read offers by category');
  }

  getAccount(): Promise<SupplierAccount> {
    return notSupported('WDGZone', 'report its plan');
  }

  getWebhook(): Promise<{ state: SupplierWebhookState; deliveries: SupplierWebhookDeliveryRow[] }> {
    return notSupported('WDGZone', 'report its webhook');
  }

  setWebhook(): Promise<SupplierWebhookState> {
    return notSupported('WDGZone', 'set its webhook');
  }

  testWebhook(): Promise<void> {
    return notSupported('WDGZone', 'test its webhook');
  }

  listCheckCategories(): Promise<SupplierCheckCategory[]> {
    return notSupported('WDGZone', 'check player ids');
  }

  async listOffers(): Promise<SupplierOffer[]> {
    const offers: SupplierOffer[] = [];
    for (const type of Object.keys(CATALOG_TYPES) as (keyof typeof CATALOG_TYPES)[]) {
      for (let page = 1; ; page += 1) {
        const reply = await this.pagedRead({
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
      const reply = await this.pagedRead({
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
      if (
        !row.success ||
        (row.data.currency != null && row.data.currency.toUpperCase() !== 'USD')
      ) {
        return [];
      }
      const { data } = row;
      const amount = signedUsd(data.amount);
      const balanceAfter = signedUsd(data.balance_after);
      const createdAt = dateOf(data.created_at);
      const reference = (data.reference ?? data.description)?.trim().slice(0, 200);
      // S18 ST2: the live rows name their order by `reference_type` and `reference_id`.
      const supplierOrderId =
        data.reference_type === 'order' && data.reference_id ? data.reference_id : data.order_id;
      return [
        {
          id: data.id.slice(0, 64),
          ...(data.type && { type: data.type.slice(0, 64) }),
          ...(amount && { amount }),
          ...(balanceAfter && { balanceAfter }),
          ...(reference && { reference }),
          ...(supplierOrderId && { supplierOrderId: supplierOrderId.slice(0, 64) }),
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
      const total =
        data.currency == null || data.currency.toUpperCase() === 'USD'
          ? signedUsd(data.total_price ?? data.total)
          : null;
      const createdAt = dateOf(data.created_at);
      const completedAt = dateOf(data.completed_at);
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
          ...(completedAt && { completedAt }),
        },
      ];
    });
    return { items, hasMore: hasMore(page, reply) };
  }

  /** S16 SF5: `GET /health`, with the key like every request (it answers 401 without one). */
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

  /** S18 PQ1: `GET /products/{id}`, within 5 seconds; throws a `SupplierError`. */
  async getOfferQuote(offerId: string): Promise<SupplierOfferQuote> {
    if (!WDG_ID_PATTERN.test(offerId)) {
      throw new SupplierError('definitive', 'Not a WDGZone product id', {
        supplierCode: 'PRODUCT_NOT_FOUND',
      });
    }
    const reply = await this.http.request({
      method: 'GET',
      path: `products/${offerId}`,
      schema: productReplySchema,
      errorCode: wdgErrorCode,
      timeoutMs: Math.min(this.options.timeoutMs ?? QUOTE_TIMEOUT_MS, QUOTE_TIMEOUT_MS),
    });
    const product = reply.data;
    const amountUnits = usdUnits(product.price);
    if (product.currency !== 'USD' || amountUnits === null) {
      throw new SupplierError('retryable', 'WDGZone product has an unexpected price', {
        failure: 'unreadable',
      });
    }
    return {
      cost: { currency: 'USD', amountUnits },
      inStock: product.available && (product.stock == null || product.stock > 0),
    };
  }

  async validatePlayer(): Promise<PlayerValidation> {
    throw new SupplierError('definitive', 'WDGZone does not check player ids');
  }

  async placeOrder(request: PlaceOrderRequest): Promise<SupplierOutcome> {
    // Refused before anything is sent: nothing was bought.
    if (!WDG_ID_PATTERN.test(request.offerId)) {
      return refused('PRODUCT_NOT_FOUND', 'Not a WDGZone product id');
    }
    if (request.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      return refused('IDEMPOTENCY_KEY_TOO_LONG', 'Idempotency key longer than WDGZone takes');
    }
    const fields = accountFields(request.fields);
    if (fields === null) {
      return refused('FIELDS_UNSUPPORTED', 'Several WDGZone fields without an account field');
    }
    try {
      const reply = await this.http.request({
        method: 'POST',
        path: `products/${request.offerId}/purchase`,
        headers: { 'x-idempotency-key': request.idempotencyKey },
        // Ours last: no account field can stand in for the quantity or the callback.
        body: {
          ...fields,
          quantity: request.quantity,
          ...(this.options.callbackUrl && { callback_url: this.options.callbackUrl }),
        },
        schema: purchaseReplySchema,
        errorCode: wdgErrorCode,
        definitiveCodes: WDG_DEFINITIVE_PURCHASE_CODES,
        // A shorter client timeout never cuts the purchase's own (audit A05-53).
        timeoutMs: Math.max(this.options.timeoutMs ?? 0, PURCHASE_TIMEOUT_MS),
      });
      const supplierOrderId = String(reply.data.order_id);
      const charged = chargedUnits(reply.data.total);
      if (reply.data.status.toLowerCase() !== 'completed') {
        // Any other state is followed by polling, whose 200 and 410 are the documented ends.
        return { status: 'pending', supplierOrderId, ...charged };
      }
      return delivered(supplierOrderId, request.quantity, reply.data.delivery_items, charged);
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
        // S16 MF4: a 410's body has `data.status` and no `error` object.
        errorCode: (body) =>
          refundedReplySchema.safeParse(body).data?.data.status ?? wdgErrorCode(body),
      });
      // A 202 is also a delivered direct top-up (no code): the order's state decides (MF4).
      if (reply.status === 202) return await this.orderState(supplierOrderId, placed.quantity);
      const ready = deliveryReplySchema.safeParse(reply.data);
      if (reply.status !== 200 || !ready.success) {
        return {
          status: 'unknown',
          supplierOrderId,
          reason: 'WDGZone delivery reply unexpected',
          failure: 'unreadable',
          httpStatus: reply.status,
        };
      }
      const { quantity, status, delivery_items: items } = ready.data.data;
      // S18 HE4: read answers that do not settle the order yet are no fault of WDG's.
      if (status != null && status.toLowerCase() !== 'completed') {
        return {
          status: 'unknown',
          supplierOrderId,
          reason: 'WDGZone delivery is not completed',
          answered: true,
        };
      }
      if (quantity !== undefined && quantity !== placed.quantity) {
        return {
          status: 'unknown',
          supplierOrderId,
          reason: 'WDGZone delivered other units',
          answered: true,
        };
      }
      return delivered(supplierOrderId, placed.quantity, items);
    } catch (error) {
      // A 410 is a refund only with WDG's own body (its code or refund reply): a proxy's or an
      // error page's 410 may stand in front of a delivered order (audit A05-18).
      if (
        error instanceof SupplierError &&
        error.details.status === 410 &&
        error.details.supplierCode !== undefined
      ) {
        return {
          status: 'failed_definitive',
          supplierOrderId,
          supplierCode: error.details.supplierCode,
          reason: 'Failed and refunded by WDGZone',
        };
      }
      // Not found, a timeout or an error page: never a failure (the order may exist).
      const outcome = outcomeOfOrderError(error);
      if (outcome.status !== 'unknown') return { ...outcome, supplierOrderId };
      // S18 HE4: "not found" is an answer (an order WDG has not listed yet), not a fault.
      const notFound = outcome.supplierCode === 'ORDER_NOT_FOUND';
      return { ...outcome, supplierOrderId, ...(notFound && { answered: true }) };
    }
  }

  /**
   * S16 MF4: `GET /orders/{id}` after a poll's 202. `completed` is delivered without codes (a
   * `code` pack without codes stays unknown by S08 F1), `refunded`, `failed`, `cancelled` failed,
   * `pending`, `processing` pending; anything else, or no readable reply, unknown.
   */
  private async orderState(supplierOrderId: string, quantity: number): Promise<SupplierOutcome> {
    const reply = await this.http.request({
      method: 'GET',
      path: `orders/${supplierOrderId}`,
      schema: orderStateReplySchema,
      errorCode: wdgErrorCode,
    });
    const status = reply.data.status.toLowerCase();
    const charged = chargedUnits(reply.data.total_price);
    if (status === 'completed') {
      return { status: 'delivered', supplierOrderId, quantity, ...charged };
    }
    if (status === 'pending' || status === 'processing') {
      return { status: 'pending', supplierOrderId, ...charged };
    }
    if (status === 'refunded' || status === 'failed' || status === 'cancelled') {
      // S18 DD1: the supplier's own reason, so the admin sees why it failed the order.
      const message = reply.data.error_message?.trim().slice(0, 200);
      return {
        status: 'failed_definitive',
        supplierOrderId,
        supplierCode: reply.data.status.toUpperCase(),
        reason: message || 'Failed by WDGZone',
      };
    }
    return {
      status: 'unknown',
      supplierOrderId,
      reason: 'WDGZone order state unexpected',
      answered: true,
    };
  }

  verifyWebhook(request: WebhookRequest, now?: Date): boolean {
    const header = request.headers[WDG_SIGNATURE_HEADER];
    if (!header?.startsWith('sha256=')) return false;
    let createdAt: number;
    try {
      createdAt =
        dateOf(webhookTimeSchema.parse(JSON.parse(request.rawBody)).created_at)?.getTime() ??
        Number.NaN;
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
      const usd = body.data.currency == null || body.data.currency.toUpperCase() === 'USD';
      return {
        eventId: body.id,
        supplierOrderId,
        outcome: delivered(
          supplierOrderId,
          body.data.quantity,
          body.data.delivery_items,
          usd ? chargedUnits(body.data.total) : {},
        ),
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

  /**
   * S18 SY1: a catalog page through `paced`, read up to twice more when it fails without a
   * refusal: after 2 s and 5 s, or once a rate limit lifts (at most 61 s).
   */
  private async pagedRead<T>(request: SupplierRequest<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.paced(request);
      } catch (error) {
        const failure = error instanceof SupplierError ? error.details.failure : undefined;
        const delay = PAGE_RETRY_DELAYS_MS[attempt];
        if (
          !(error instanceof SupplierError) ||
          error.kind === 'definitive' ||
          failure === undefined ||
          !PAGE_RETRY_FAILURES.has(failure) ||
          delay === undefined
        ) {
          throw error;
        }
        const retryAt = error.details.retryAt;
        const waitMs =
          failure === 'rate_limited' && retryAt !== undefined
            ? Math.min(
                Math.max(retryAt - this.now().getTime() + 1000, delay),
                RATE_LIMIT_MAX_WAIT_MS,
              )
            : delay;
        this.options.onRetry?.({
          path: request.path.split('?')[0] ?? request.path,
          attempt: attempt + 1,
          failure,
          ...(error.details.status !== undefined && { status: error.details.status }),
          waitMs,
        });
        await this.sleep(waitMs);
      }
    }
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

/**
 * A WDG product's account fields as field specs (S16 SC3), bounded; null when unreadable. `sendable`
 * is false when a select cannot be mapped whole (S16 MF2: fewer than 2 or more than 50 options, or
 * an option value that is empty or longer than 64): its stored options are then cut to the bound.
 */
function fieldSpecsOf(product: WdgProduct): { specs: FieldSpec[]; sendable: boolean } | null {
  const fields = product.required_fields ?? [];
  if (fields.length === 0) {
    return {
      specs: product.requires_player_id
        ? [{ key: 'player_id', label: 'Player ID', type: 'text' }]
        : [],
      sendable: true,
    };
  }
  if (fields.length > MAX_FIELD_SPECS) return null;
  const specs: FieldSpec[] = [];
  let sendable = true;
  for (const field of fields) {
    if (!/^[A-Za-z0-9_.-]{1,32}$/.test(field.key)) return null;
    const type = field.type == null || field.type === 'text' ? 'text' : 'select';
    const raw = (field.options ?? []).map((option) => ({
      label: (option.label ?? String(option.value)).trim().slice(0, 64),
      value: String(option.value),
    }));
    const values = new Set(raw.map((option) => option.value));
    if (
      type === 'select' &&
      (raw.length < SELECT_OPTIONS_MIN ||
        raw.length > MAX_FIELD_SPEC_OPTIONS ||
        values.size !== raw.length ||
        raw.some((option) => option.value === '' || option.value.length > 64))
    ) {
      sendable = false;
    }
    const options = raw
      .filter((option) => option.value !== '' && option.value.length <= 64)
      .slice(0, MAX_FIELD_SPEC_OPTIONS);
    specs.push({
      key: field.key,
      label: (field.label ?? field.key).trim().slice(0, 64),
      type,
      ...(type === 'select' && { options }),
    });
  }
  return { specs, sendable };
}

/** Body keys of ours that an account field must never take (the purchase's own). */
const RESERVED_KEYS = new Set(['quantity', 'callback_url']);
/**
 * Fields asking for an account's password: kept unsupported until the owner decides whether to
 * sell such packs (`docs/open-questions.md` Q20): a customer's password is never asked for.
 */
const PASSWORD_KEY = /pass(word|wd)?/i;

/**
 * S16 MF1: the field keys WDG can be sent; several fields need an account field; none may take
 * one of the body's own keys or ask for a password.
 */
function sendableFields(specs: readonly FieldSpec[]): boolean {
  if (specs.some((spec) => RESERVED_KEYS.has(spec.key) || PASSWORD_KEY.test(spec.key))) {
    return false;
  }
  if (specs.length <= 1) return true;
  return specs.some((spec) => (ACCOUNT_FIELD_KEYS as readonly string[]).includes(spec.key));
}

/**
 * S16 MF1: the purchase body's account fields. One field goes as `player_id` whatever its key;
 * several go each under its own key, plus `player_id` with the account field's value (WDG's
 * delimiter forms are never sent). Null when several fields have no account field. Empty values
 * are left out (WDG refuses a missing `player_id` before anything is bought).
 */
function accountFields(fields: Readonly<Record<string, string>>): Record<string, string> | null {
  const entries = Object.entries(fields);
  if (entries.length <= 1) {
    const value = entries[0]?.[1];
    return value ? { player_id: value } : {};
  }
  const account = ACCOUNT_FIELD_KEYS.find((key) => Object.hasOwn(fields, key));
  if (account === undefined) return null;
  const body = Object.fromEntries(
    entries.filter(([key, value]) => value !== '' && !RESERVED_KEYS.has(key)),
  );
  const playerId = fields[account];
  return { ...body, ...(playerId && { player_id: playerId }) };
}

/** A WDG product as an offer, or null when it cannot be listed through this adapter. */
function toOffer(product: WdgProduct): SupplierOffer | null {
  const kind = CATALOG_TYPES[product.type as keyof typeof CATALOG_TYPES];
  const amountUnits = usdUnits(product.price);
  if (!kind || product.currency !== 'USD' || amountUnits === null) return null;
  const fields = fieldSpecsOf(product);
  if (fields === null) return null;
  const { specs: fieldSpecs } = fields;
  // S16 MF1, MF2: kept, but unsupported, when its fields cannot be sent.
  const unsupported = !fields.sendable || !sendableFields(fieldSpecs);
  const group = product.brand?.trim() || product.category?.trim() || undefined;
  const category = product.category?.trim();
  const original = product.original_price == null ? null : usdUnits(product.original_price);
  const discountBp = percentBp(product.discount_percent);
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
    ...(discountBp !== null && discountBp > 0 && { discountBp }),
  };
}

/** S18 DC1: a percent with up to 2 decimals (`2`, `2.5`, `"1.25"`) in basis points, or null. */
function percentBp(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(String(value).trim());
  if (!match) return null;
  const bp = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return bp <= 10_000 ? bp : null;
}

/** S18 CH1: a WDG total as an outcome's `chargedUsdUnits`; nothing when unreadable. */
function chargedUnits(value: number | string | null | undefined): { chargedUsdUnits?: number } {
  if (value == null) return {};
  const units = usdUnits(value);
  return units === null ? {} : { chargedUsdUnits: units };
}

/** A signed WDG amount in USD (a purchase is negative on the statement), or null. */
function signedUsd(value: number | string | null | undefined): SupplierMoney | null {
  if (value == null) return null;
  const text = String(value).trim();
  const negative = text.startsWith('-');
  const units = usdUnits(negative ? text.slice(1) : text);
  return units === null ? null : { currency: 'USD', amountUnits: negative ? -units : units };
}

/**
 * A WDG time, or null when it does not parse. S18 TZ1: `2026-10-19 00:53:16` (no offset) is in
 * UTC+4; a time with `Z` or an offset is read as given.
 */
function dateOf(value: string | null | undefined): Date | null {
  if (!value) return null;
  const text = value.trim();
  const local = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?)$/.exec(text);
  const time = Date.parse(local ? `${local[1]}T${local[2]}${WDG_TIME_OFFSET}` : text);
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

/**
 * S16 MF4: delivered items as code texts, a pin kept as `<code> · PIN: <pin>`; null when one is
 * empty or beyond S08's code limit.
 */
function codeTexts(items: readonly WdgDeliveryItem[]): string[] | null {
  const codes = items.map((item) => {
    if (typeof item === 'string') return item.trim();
    const code = item.code.trim();
    const pin = item.pin?.trim();
    return code && pin ? `${code} · PIN: ${pin}` : code;
  });
  return codes.every((code) => code !== '' && code.length <= MAX_CODE_LENGTH) ? codes : null;
}

function delivered(
  supplierOrderId: string,
  quantity: number,
  items: readonly WdgDeliveryItem[] | null | undefined,
  charged: { chargedUsdUnits?: number } = {},
): SupplierOutcome {
  const codes = codeTexts(items ?? []);
  if (codes === null) {
    return {
      status: 'unknown',
      supplierOrderId,
      reason: 'WDGZone delivered an unreadable code',
      answered: true,
    };
  }
  return {
    status: 'delivered',
    supplierOrderId,
    quantity,
    ...(codes.length > 0 && { codes }),
    ...charged,
  };
}

function refused(supplierCode: string, reason: string): SupplierOutcome {
  return { status: 'failed_definitive', supplierCode, reason };
}
