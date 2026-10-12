import { createHash } from 'node:crypto';
import { parseUsd } from '@vertex-digital/contracts';
import { z } from 'zod';
import type {
  PlacedOrder,
  PlaceOrderRequest,
  PlayerValidation,
  SupplierAdapter,
  SupplierCapabilities,
  SupplierMoney,
  SupplierOffer,
  SupplierOutcome,
  SupplierWebhookEvent,
  WebhookRequest,
} from '../core/adapter.js';
import { outcomeOfOrderError, SupplierError } from '../core/errors.js';
import { verifyHmacSignature } from '../core/hmac.js';
import { SupplierHttp, type SupplierRequest } from '../core/http.js';
import { WDG_DEFINITIVE_PURCHASE_CODES, WDG_OUT_OF_STOCK, wdgErrorCode } from './errors.js';
import {
  deliveryReplySchema,
  meReplySchema,
  productSchema,
  productsPageSchema,
  purchaseReplySchema,
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
  };

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

/** A WDG product as an offer, or null when it cannot be sold through this adapter. */
function toOffer(product: WdgProduct): SupplierOffer | null {
  const kind = CATALOG_TYPES[product.type as keyof typeof CATALOG_TYPES];
  const amountUnits = usdUnits(product.price);
  if (!kind || product.currency !== 'USD' || amountUnits === null) return null;
  const fields = product.required_fields ?? [];
  // One free-text field, sent as `player_id`; a list (`select`: region, server) is not a player id.
  if (fields.length > 1 || fields.some((field) => field.type != null && field.type !== 'text')) {
    return null;
  }
  const listed = fields.map((field) => field.key);
  const requiredFields = listed.length === 0 && product.requires_player_id ? ['player_id'] : listed;
  const group = product.brand?.trim() || product.category?.trim() || undefined;
  const category = product.category?.trim();
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
    requiredFields,
  };
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
