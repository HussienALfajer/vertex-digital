import {
  type FieldSpec,
  MAX_FIELD_SPEC_OPTIONS,
  MAX_FIELD_SPECS,
  type OfferUnsupportedReason,
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
import { FZR_DEFINITIVE_ORDER_CODES, FZR_SUBSCRIPTION_INACTIVE, fzrErrorCode } from './errors.js';
import {
  balanceReplySchema,
  categoriesPageSchema,
  categorySchema,
  deliveriesReplySchema,
  deliverySchema,
  type FzrCard,
  type FzrCategory,
  type FzrField,
  fieldSchema,
  giftCardSchema,
  giftCardsReplySchema,
  meReplySchema,
  orderReplySchema,
  orderRowSchema,
  type orderSchema,
  statementPageSchema,
  topupOfferSchema,
  topupOffersReplySchema,
  transactionRowSchema,
  validateReplySchema,
  webhookBodySchema,
  webhookReplySchema,
} from './schemas.js';

/*
 * The `fazercards` supplier (S19, ADR 0034, docs/suppliers/fazercards.md): REST under
 * `/api/v2` with an `X-API-Key` header. Top-ups and gift cards are flat lists of categories whose
 * offers are read one category at a time (FC3: the sync picks which), so ids carry the product
 * type: categories `topup.<id>` and `gift.<id>`, offers `topup:<category>:<offer>` and
 * `gift:<category>:<card>` (FC4: an offer id repeats across categories). Orders carry the attempt id
 * as `Idempotency-Key` and are polled by FazerCards' own `ord-N`; webhooks are signed with a secret
 * of FazerCards' (FC7), entered beside the key. Player checks go to its own check categories
 * (`pubg_mobile`, not the order category `pubg_mobile_auto`, seen 2026-10-20).
 */

export const FAZERCARDS_SUPPLIER_CODE = 'fazercards';

export const FAZERCARDS_BASE_URL = 'https://api.fzr.cards/api/v2/';

export const FZR_SIGNATURE_HEADER = 'x-webhook-signature';

/** FC1: 15 s per request, 30 s for an order. */
const TIMEOUT_MS = 15_000;
const ORDER_TIMEOUT_MS = 30_000;
/**
 * FC1: catalog reads at most 100 a minute, below the 120 the spec allows (the live limit was 300 a
 * minute on 2026-10-20), then a pause when few requests are left in the window.
 */
const CATALOG_GAP_MS = 600;
const RATE_LIMIT_RESERVE = 10;
/** FC1: a read that answers 429 waits for the limit (at most 61 s) and is read once more. */
const RATE_LIMIT_MAX_WAIT_MS = 61_000;
/** FC7: the signed body's `timestamp` within a day; FazerCards retries for about 36 minutes. */
const WEBHOOK_TOLERANCE_SECONDS = 24 * 60 * 60;
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
/** FazerCards' own category and offer ids (snake case), before they go into an id or a query. */
const CATEGORY_ID = /^[A-Za-z0-9_-]{1,58}$/;
const ITEM_ID = /^[A-Za-z0-9_.-]{1,60}$/;
const ORDER_ID = /^ord-\d{1,18}$/;
/** Categories per page: top-ups take up to 500 (300 listed), gift cards 200 (553 listed). */
const TOPUP_PAGE_SIZE = 500;
const GIFT_PAGE_SIZE = 200;
const MAX_CATEGORY_PAGES = 20;
const STATEMENT_PAGE_SIZE = 50;
/** FC11: the hosts FazerCards serves category covers from. */
const IMAGE_HOSTS = ['reseller.fazercards.com', 'api.fzr.cards'] as const;
/** S06's bounds of a select (S16 MF2). */
const SELECT_OPTIONS_MIN = 2;
/** S08's limit of a code's text. */
const MAX_CODE_LENGTH = 200;
const MAX_NOTE_LENGTH = 1_000;
/**
 * FC4, Q20: fields asking for an account's email or password: kept unsupported, a customer's
 * login is never asked for ("Auto Via Login" categories).
 */
const LOGIN_FIELD = /e-?mail|pass(word|wd)?/i;
/** FC4: delivered by hand at FazerCards. */
const MANUAL_CATEGORY = /\(manual\)/i;

const TYPES = { topup: 'direct', gift: 'code' } as const;
type ProductType = keyof typeof TYPES;

export interface FazercardsAdapterOptions {
  apiKey: string;
  webhookSecret: string;
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

/** A FazerCards amount (a 4-decimal string) in micro-dollars, exactly, or null. */
const usdUnits = (value: number | string): number | null =>
  parseUsd(String(value), { subCent: true });

/** `topup.<id>` or `gift.<id>` read back, or null. */
function categoryParts(categoryId: string): { type: ProductType; id: string } | null {
  const match = /^(topup|gift)\.(.+)$/.exec(categoryId);
  if (!match || !CATEGORY_ID.test(match[2] as string)) return null;
  return { type: match[1] as ProductType, id: match[2] as string };
}

/** `topup:<category>:<offer>` or `gift:<category>:<card>` read back, or null. */
function offerParts(offerId: string): { type: ProductType; category: string; item: string } | null {
  const match = /^(topup|gift):([^:]+):([^:]+)$/.exec(offerId);
  if (!match || !CATEGORY_ID.test(match[2] as string) || !ITEM_ID.test(match[3] as string)) {
    return null;
  }
  return { type: match[1] as ProductType, category: match[2] as string, item: match[3] as string };
}

export class FazercardsAdapter implements SupplierAdapter {
  readonly code = FAZERCARDS_SUPPLIER_CODE;
  readonly capabilities: SupplierCapabilities = {
    validatePlayer: true,
    webhooks: true,
    balance: true,
    catalog: true,
    categories: true,
    statement: true,
    platformStatus: false,
    offerQuote: false,
    offerWindow: true,
    account: true,
  };

  readonly imageHosts: readonly string[] = IMAGE_HOSTS;

  private readonly http: SupplierHttp;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private lastCatalogReadAt = 0;

  constructor(private readonly options: FazercardsAdapterOptions) {
    this.http = new SupplierHttp({
      baseUrl: options.baseUrl ?? FAZERCARDS_BASE_URL,
      headers: { 'x-api-key': options.apiKey },
      ...(options.fetch && { fetch: options.fetch }),
      timeoutMs: options.timeoutMs ?? TIMEOUT_MS,
    });
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** FC3: never the whole catalog at once; the sync reads it through `listOffersIn`. */
  listOffers(): Promise<SupplierOffer[]> {
    return notSupported('FazerCards', 'list its whole catalog at once');
  }

  /**
   * FC3, FC4: each category's offers in turn. A category FazerCards no longer knows (404) is read
   * with no offers; one that fails otherwise is left out of `readCategoryIds`, and the read throws
   * only when every category failed.
   */
  async listOffersIn(categoryIds: readonly string[]): Promise<SupplierOfferWindow> {
    const offers: SupplierOffer[] = [];
    const readCategoryIds: string[] = [];
    let failure: unknown = null;
    for (const categoryId of categoryIds) {
      const parts = categoryParts(categoryId);
      if (!parts) continue;
      try {
        offers.push(...(await this.categoryOffers(parts)));
        readCategoryIds.push(categoryId);
      } catch (error) {
        if (error instanceof SupplierError && error.details.status === 404) {
          readCategoryIds.push(categoryId);
        } else {
          failure = error;
        }
      }
    }
    if (readCategoryIds.length === 0 && failure !== null) throw failure;
    return { offers, readCategoryIds };
  }

  private async categoryOffers(parts: { type: ProductType; id: string }): Promise<SupplierOffer[]> {
    const query = `category_id=${encodeURIComponent(parts.id)}`;
    if (parts.type === 'topup') {
      const reply = await this.catalogRead({
        method: 'GET',
        path: `topups/offers?${query}`,
        schema: topupOffersReplySchema,
        errorCode: fzrErrorCode,
      });
      const fields = fieldSpecsOf(reply.fields ?? []);
      const name = reply.name?.trim().slice(0, 200) || parts.id;
      const unsupported: OfferUnsupportedReason | undefined = MANUAL_CATEGORY.test(name)
        ? 'manual_delivery'
        : fields === null || !fields.sendable
          ? 'fields_unsupported'
          : undefined;
      return reply.offers.flatMap((item): SupplierOffer[] => {
        const offer = topupOfferSchema.safeParse(item);
        if (!offer.success || !ITEM_ID.test(offer.data.offer_id)) return [];
        const amountUnits = usdUnits(offer.data.price_usd);
        if (amountUnits === null) return [];
        const specs = fields?.specs ?? [];
        return [
          {
            offerId: `topup:${parts.id}:${offer.data.offer_id}`,
            name: offer.data.name.trim().slice(0, 200),
            cost: { currency: 'USD', amountUnits },
            inStock: true,
            group: name,
            kind: TYPES.topup,
            requiredFields: specs.map((spec) => spec.key),
            categoryId: `topup.${parts.id}`,
            fieldSpecs: specs,
            ...(unsupported && { unsupportedReason: unsupported }),
          },
        ];
      });
    }
    const reply = await this.catalogRead({
      method: 'GET',
      path: `giftcards/cards?${query}`,
      schema: giftCardsReplySchema,
      errorCode: fzrErrorCode,
    });
    const name = reply.name?.trim().slice(0, 200) || parts.id;
    return reply.offers.flatMap((item): SupplierOffer[] => {
      const card = giftCardSchema.safeParse(item);
      if (!card.success || !ITEM_ID.test(card.data.card_id)) return [];
      const amountUnits = usdUnits(card.data.price_usd);
      if (amountUnits === null) return [];
      const stock = card.data.stock;
      const min = card.data.min_order_quantity;
      const max = card.data.max_order_quantity;
      const bounded = min != null && max != null && min >= 1 && min <= max;
      return [
        {
          offerId: `gift:${parts.id}:${card.data.card_id}`,
          name: card.data.name.trim().slice(0, 200),
          cost: { currency: 'USD', amountUnits },
          inStock: stock == null || stock > 0,
          group: name,
          kind: TYPES.gift,
          requiredFields: [],
          categoryId: `gift.${parts.id}`,
          ...(stock != null && stock >= 0 && { stock }),
          ...(bounded && { minQuantity: min, maxQuantity: max }),
          fieldSpecs: [],
        },
      ];
    });
  }

  /** FC3: the top-up and gift-card categories, page by page; flat (no parent). */
  async listCategories(): Promise<SupplierCategory[]> {
    const categories: SupplierCategory[] = [];
    for (const [type, path, size] of [
      ['topup', 'topups', TOPUP_PAGE_SIZE],
      ['gift', 'giftcards', GIFT_PAGE_SIZE],
    ] as const) {
      let cursor: string | null = null;
      for (let page = 1; ; page += 1) {
        const reply: z.infer<typeof categoriesPageSchema> = await this.catalogRead({
          method: 'GET',
          path: `${path}?limit=${size}&include_ui=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          schema: categoriesPageSchema,
          errorCode: fzrErrorCode,
        });
        for (const item of reply.items) {
          const node = categorySchema.safeParse(item);
          const category = node.success ? this.toCategory(type, node.data) : null;
          if (category) categories.push(category);
        }
        cursor = reply.meta?.has_more ? (reply.meta.next_cursor ?? null) : null;
        if (cursor === null || reply.items.length === 0) break;
        if (page >= MAX_CATEGORY_PAGES) {
          throw new SupplierError('retryable', 'FazerCards catalog is larger than expected');
        }
      }
    }
    return categories;
  }

  private toCategory(type: ProductType, node: FzrCategory): SupplierCategory | null {
    const name = node.name.trim().slice(0, 200);
    if (!name || !CATEGORY_ID.test(node.category_id)) return null;
    const imageUrl = (node.imageurl ?? node.icon_url)?.trim();
    const imageOk =
      imageUrl !== undefined &&
      imageUrl.length <= 500 &&
      imageUrlAllowed(imageUrl, this.imageHosts);
    const note = node.note?.trim().slice(0, MAX_NOTE_LENGTH);
    return {
      categoryId: `${type}.${node.category_id}`,
      name,
      kind: TYPES[type],
      ...(imageOk && { imageUrl }),
      ...(note && { note }),
    };
  }

  async getBalance(): Promise<SupplierMoney> {
    const reply = await this.http.request({
      method: 'GET',
      path: 'balance',
      schema: balanceReplySchema,
      errorCode: fzrErrorCode,
    });
    const amountUnits = usdUnits(reply.balance);
    if (reply.currency !== 'USD' || amountUnits === null) {
      throw new SupplierError(
        'retryable',
        'FazerCards balance has an unexpected amount or currency',
      );
    }
    return { currency: 'USD', amountUnits };
  }

  /** FC9: `GET /me`, the plan only. */
  async getAccount(): Promise<SupplierAccount> {
    const reply = await this.http.request({
      method: 'GET',
      path: 'me',
      schema: meReplySchema,
      errorCode: fzrErrorCode,
    });
    const expiresAt = dateOf(reply.planExpiresAt);
    return {
      plan: reply.plan,
      active: reply.subscriptionActive,
      ...(expiresAt && { expiresAt }),
      ...(reply.planAutoRenew != null && { autoRenew: reply.planAutoRenew }),
    };
  }

  /** FC8: the settings and the last 50 deliveries. */
  async getWebhook(): Promise<{
    state: SupplierWebhookState;
    deliveries: SupplierWebhookDeliveryRow[];
  }> {
    const state = await this.webhookState({ method: 'GET', path: 'account/webhook' });
    const reply = await this.http.request({
      method: 'GET',
      path: 'account/webhook/deliveries',
      schema: deliveriesReplySchema,
      errorCode: fzrErrorCode,
    });
    const deliveries = reply.deliveries.flatMap((item): SupplierWebhookDeliveryRow[] => {
      const row = deliverySchema.safeParse(item);
      if (!row.success) return [];
      const { data } = row;
      const createdAt = dateOf(data.created_at);
      return [
        {
          id: String(data.id).slice(0, 64),
          event: data.event,
          status: data.status,
          ...(data.attempt != null && data.attempt >= 0 && { attempt: data.attempt }),
          ...(data.response_status != null && { responseStatus: data.response_status }),
          ...(data.duration_ms != null &&
            data.duration_ms >= 0 && { durationMs: data.duration_ms }),
          ...(createdAt && { createdAt }),
        },
      ];
    });
    return { state, deliveries };
  }

  /** FC8: `PUT /account/webhook { url, enabled: true }`. */
  setWebhook(url: string): Promise<SupplierWebhookState> {
    return this.webhookState({
      method: 'PUT',
      path: 'account/webhook',
      body: { url, enabled: true },
    });
  }

  /** FC8: `POST /account/webhook/test`; the event arrives at the webhook. */
  async testWebhook(): Promise<void> {
    await this.http.request({
      method: 'POST',
      path: 'account/webhook/test',
      body: {},
      schema: z.unknown(),
      errorCode: fzrErrorCode,
    });
  }

  private async webhookState(request: {
    method: 'GET' | 'PUT';
    path: string;
    body?: unknown;
  }): Promise<SupplierWebhookState> {
    const reply = await this.http.request({
      ...request,
      schema: webhookReplySchema,
      errorCode: fzrErrorCode,
    });
    const hook = reply.webhook;
    if (!hook) return { enabled: false };
    const lastSuccessAt = dateOf(hook.last_success_at);
    const lastFailureAt = dateOf(hook.last_failure_at);
    const reason = hook.last_failure_reason?.trim().slice(0, 200);
    return {
      enabled: hook.enabled === true,
      ...(hook.url && { url: hook.url.slice(0, 500) }),
      ...(hook.consecutive_failures != null &&
        hook.consecutive_failures >= 0 && { consecutiveFailures: hook.consecutive_failures }),
      ...(lastSuccessAt && { lastSuccessAt }),
      ...(lastFailureAt && { lastFailureAt }),
      ...(reason && { lastFailureReason: reason }),
    };
  }

  /** FC10: `GET /transactions`, newest first; a debit is negative. */
  async listTransactions(page: number): Promise<SupplierStatementPage<SupplierTransactionRow>> {
    const reply = await this.http.request({
      method: 'GET',
      path: `transactions?page=${page}&limit=${STATEMENT_PAGE_SIZE}`,
      schema: statementPageSchema,
      errorCode: fzrErrorCode,
    });
    const items = reply.items.flatMap((item): SupplierTransactionRow[] => {
      const row = transactionRowSchema.safeParse(item);
      if (!row.success) return [];
      const { data } = row;
      const debit = data.type?.toLowerCase() === 'debit';
      const amount = signedUsd(data.amount, debit);
      const balanceAfter = signedUsd(data.balanceAfter, false);
      const createdAt = dateOf(data.createdAt);
      const reference = data.note?.trim().slice(0, 200);
      const supplierOrderId = /\bord-\d{1,18}\b/.exec(data.note ?? '')?.[0];
      return [
        {
          id: data.id,
          ...(data.type && { type: data.type.slice(0, 64) }),
          ...(amount && { amount }),
          ...(balanceAfter && { balanceAfter }),
          ...(reference && { reference }),
          ...(supplierOrderId && { supplierOrderId }),
          ...(createdAt && { createdAt }),
        },
      ];
    });
    return { items, hasMore: hasMore(page, reply) };
  }

  /** FC10: `GET /orders`, newest first, matched to attempts by `ord-N`. */
  async listOrders(page: number): Promise<SupplierStatementPage<SupplierOrderRow>> {
    const reply = await this.http.request({
      method: 'GET',
      path: `orders?page=${page}&limit=${STATEMENT_PAGE_SIZE}`,
      schema: statementPageSchema,
      errorCode: fzrErrorCode,
    });
    const items = reply.items.flatMap((item): SupplierOrderRow[] => {
      const row = orderRowSchema.safeParse(item);
      if (!row.success) return [];
      const { data } = row;
      const total = signedUsd(data.total_usd, false);
      const createdAt = dateOf(data.created_at);
      const completedAt = dateOf(data.completed_at);
      const item_ = data.card_id ?? data.offer_id;
      const type = data.card_id ? 'gift' : 'topup';
      const offerId =
        data.category_id && item_
          ? `${type}:${data.category_id}:${item_}`.slice(0, 128)
          : undefined;
      return [
        {
          supplierOrderId: data.id,
          ...(offerId && { offerId }),
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

  /** FC12: no status endpoint. */
  getPlatformStatus(): Promise<SupplierPlatformStatus> {
    return notSupported('FazerCards', 'report its status');
  }

  /** No single-offer read: the order is sent without a quote (S18 PQ1). */
  getOfferQuote(): Promise<SupplierOfferQuote> {
    return notSupported('FazerCards', 'quote one offer');
  }

  /** FC11: without the API key, from FazerCards' image hosts only. */
  fetchImage(url: string, limits: ImageLimits): Promise<Uint8Array> {
    return fetchImageFromHosts(url, this.imageHosts, limits, this.options.fetch);
  }

  /**
   * PC2: `POST /topups/validate-id` on FazerCards' own check category. `valid: false` is "not
   * found"; any other failure throws (the check is then unavailable, PC5).
   */
  async validatePlayer(input: {
    categoryId?: string;
    fields: Record<string, string>;
  }): Promise<PlayerValidation> {
    if (!input.categoryId || !CATEGORY_ID.test(input.categoryId)) {
      throw new SupplierError('definitive', 'FazerCards checks players by its check category');
    }
    const reply = await this.http.request({
      method: 'POST',
      path: 'topups/validate-id',
      body: { category_id: input.categoryId, fields: input.fields },
      schema: validateReplySchema,
      errorCode: fzrErrorCode,
    });
    const playerName = reply.player_name?.trim().slice(0, 200);
    const region = reply.region?.trim().toUpperCase().slice(0, 16);
    return {
      valid: reply.valid,
      ...(reply.valid && playerName && { playerName }),
      ...(reply.valid && region && { region }),
    };
  }

  /** FC5: one top-up (FazerCards takes no quantity for them) or up to 100 gift cards. */
  async placeOrder(request: PlaceOrderRequest): Promise<SupplierOutcome> {
    // Refused before anything is sent: nothing was bought.
    const parts = offerParts(request.offerId);
    if (!parts) return refused('PRODUCT_NOT_FOUND', 'Not a FazerCards offer id');
    if (request.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      return refused('IDEMPOTENCY_KEY_TOO_LONG', 'Idempotency key longer than FazerCards takes');
    }
    if (parts.type === 'topup' && request.quantity !== 1) {
      return refused('QUANTITY_UNSUPPORTED', 'FazerCards top-ups are one at a time');
    }
    if (parts.type === 'gift' && (request.quantity < 1 || request.quantity > 100)) {
      return refused('QUANTITY_UNSUPPORTED', 'FazerCards gift cards are 1 to 100 a time');
    }
    try {
      const reply = await this.http.request({
        method: 'POST',
        path: parts.type === 'topup' ? 'topups/order' : 'giftcards/order',
        headers: { 'idempotency-key': request.idempotencyKey },
        body:
          parts.type === 'topup'
            ? { category_id: parts.category, offer_id: parts.item, fields: request.fields }
            : { category_id: parts.category, card_id: parts.item, quantity: request.quantity },
        schema: orderReplySchema,
        errorCode: fzrErrorCode,
        definitiveCodes: FZR_DEFINITIVE_ORDER_CODES,
        timeoutMs: this.options.timeoutMs ?? ORDER_TIMEOUT_MS,
      });
      return orderOutcome(reply.order, request.quantity, parts.type === 'gift');
    } catch (error) {
      const outcome = outcomeOfOrderError(error);
      return outcome.status === 'failed_definitive' &&
        outcome.supplierCode === FZR_SUBSCRIPTION_INACTIVE
        ? { ...outcome, reason: 'FazerCards plan inactive: refused before charging' }
        : outcome;
    }
  }

  /** FC6: `GET /orders/{ord-N}`; without it, the poll re-sends the order with its key. */
  async getOrder(_idempotencyKey: string, placed?: PlacedOrder): Promise<SupplierOutcome> {
    const supplierOrderId = placed?.supplierOrderId;
    if (!placed || !supplierOrderId || !ORDER_ID.test(supplierOrderId)) {
      return { status: 'unknown', reason: 'No FazerCards order id to look up' };
    }
    try {
      const reply = await this.http.request({
        method: 'GET',
        path: `orders/${supplierOrderId}`,
        schema: orderReplySchema,
        errorCode: fzrErrorCode,
      });
      return orderOutcome(reply.order, placed.quantity, reply.order.kind === 'gift_card');
    } catch (error) {
      // No poll refusal is definitive: the order may exist whatever the reply says.
      const outcome = outcomeOfOrderError(error);
      // S18 HE4: an order FazerCards does not list (yet) is an answer, not a fault.
      const notFound = outcome.status === 'unknown' && outcome.httpStatus === 404;
      return {
        ...outcome,
        supplierOrderId,
        ...(notFound && { answered: true }),
      } as SupplierOutcome;
    }
  }

  /** FC7: `sha256=<hex>` (or the bare hex) over the raw body, its `timestamp` within a day. */
  verifyWebhook(request: WebhookRequest, now?: Date): boolean {
    const header = request.headers[FZR_SIGNATURE_HEADER];
    if (!header) return false;
    let at: number | null;
    try {
      at = instantOf(webhookBodySchema.parse(JSON.parse(request.rawBody)).timestamp);
    } catch {
      return false;
    }
    if (at === null) return false;
    return verifyHmacSignature({
      secret: this.options.webhookSecret,
      signedPayload: request.rawBody,
      signature: header.startsWith('sha256=') ? header.slice('sha256='.length) : header,
      timestamp: at / 1000,
      toleranceSeconds: WEBHOOK_TOLERANCE_SECONDS,
      now: now ?? this.now(),
    });
  }

  /**
   * FC7: `order.status_changed` as an outcome by `ord-N`; a completed gift card is `pending` so the
   * poll reads its codes. Every other event, or a status this build does not know, is ignored.
   */
  parseWebhook(request: WebhookRequest): SupplierWebhookEvent {
    let body: z.infer<typeof webhookBodySchema>;
    try {
      body = webhookBodySchema.parse(JSON.parse(request.rawBody));
    } catch (cause) {
      throw new SupplierError('definitive', 'Malformed FazerCards webhook', { cause });
    }
    const eventId = body.event_id;
    const supplierOrderId = body.data?.order_id ?? undefined;
    const status = body.data?.status?.toLowerCase();
    const ignored = (): SupplierWebhookEvent => ({
      eventId,
      ignored: true,
      outcome: { status: 'unknown', reason: `FazerCards event ${body.event}`, answered: true },
    });
    if (
      body.event !== 'order.status_changed' ||
      !supplierOrderId ||
      !ORDER_ID.test(supplierOrderId)
    ) {
      return ignored();
    }
    if (status === 'completed') {
      return {
        eventId,
        supplierOrderId,
        outcome:
          body.data?.type === 'gift_card'
            ? { status: 'pending', supplierOrderId }
            : { status: 'delivered', supplierOrderId, quantity: 1 },
      };
    }
    if (status === 'created' || status === 'processing') {
      return { eventId, supplierOrderId, outcome: { status: 'pending', supplierOrderId } };
    }
    if (status === 'failed' || status === 'refund') {
      return {
        eventId,
        supplierOrderId,
        outcome: {
          status: 'failed_definitive',
          supplierOrderId,
          supplierCode: status.toUpperCase(),
          reason: body.data?.fail_reason?.trim().slice(0, 200) || 'Failed by FazerCards',
        },
      };
    }
    return ignored();
  }

  /**
   * FC1: a catalog read at most every 600 ms, a pause when few requests are left in the window,
   * and once more after a 429 when the limit lifts.
   */
  private async catalogRead<T>(request: SupplierRequest<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      const wait = this.lastCatalogReadAt + CATALOG_GAP_MS - this.now().getTime();
      if (wait > 0) await this.sleep(wait);
      this.lastCatalogReadAt = this.now().getTime();
      try {
        const reply = await this.http.send(request);
        const remaining = headerNumber(reply.headers, 'x-ratelimit-remaining');
        const reset = headerNumber(reply.headers, 'x-ratelimit-reset');
        if (remaining !== undefined && reset !== undefined && remaining <= RATE_LIMIT_RESERVE) {
          // FazerCards' reset is the seconds left in the window.
          await this.sleep(Math.min((reset + 1) * 1000, RATE_LIMIT_MAX_WAIT_MS));
        }
        return reply.data;
      } catch (error) {
        if (
          attempt > 0 ||
          !(error instanceof SupplierError) ||
          error.details.failure !== 'rate_limited'
        ) {
          throw error;
        }
        // `retryAt` is on the real clock, as `SupplierHttp` read it.
        const retryAt = error.details.retryAt ?? 0;
        await this.sleep(
          Math.min(Math.max(retryAt - Date.now() + 1000, CATALOG_GAP_MS), RATE_LIMIT_MAX_WAIT_MS),
        );
      }
    }
  }
}

/**
 * FazerCards' fields as field specs (S16 SC3), bounded; null when unreadable. Not `sendable` when
 * one asks for a login (Q20) or a select cannot be mapped whole (S16 MF2).
 */
function fieldSpecsOf(items: readonly unknown[]): { specs: FieldSpec[]; sendable: boolean } | null {
  if (items.length > MAX_FIELD_SPECS) return null;
  const specs: FieldSpec[] = [];
  let sendable = true;
  for (const item of items) {
    const parsed = fieldSchema.safeParse(item);
    if (!parsed.success || !/^[A-Za-z0-9_.-]{1,32}$/.test(parsed.data.key)) return null;
    const field: FzrField = parsed.data;
    const label = (field.label ?? field.key).trim().slice(0, 64);
    if (LOGIN_FIELD.test(field.key) || LOGIN_FIELD.test(label)) sendable = false;
    const type = field.type == null || field.type === 'text' ? 'text' : 'select';
    const raw = (field.options ?? []).map((option) => ({
      label: (option.label ?? String(option.value)).trim().slice(0, 64),
      value: String(option.value),
    }));
    const values = new Set(raw.map((option) => option.value));
    if (
      (field.type != null && field.type !== 'text' && field.type !== 'select') ||
      (type === 'select' &&
        (raw.length < SELECT_OPTIONS_MIN ||
          raw.length > MAX_FIELD_SPEC_OPTIONS ||
          values.size !== raw.length ||
          raw.some((option) => option.value === '' || option.value.length > 64)))
    ) {
      sendable = false;
    }
    const options = raw
      .filter((option) => option.value !== '' && option.value.length <= 64)
      .slice(0, MAX_FIELD_SPEC_OPTIONS);
    specs.push({ key: field.key, label, type, ...(type === 'select' && { options }) });
  }
  return { specs, sendable };
}

/** FC5, FC6: an order's state as an outcome for `quantity` units. */
function orderOutcome(
  order: z.infer<typeof orderSchema>,
  quantity: number,
  gift: boolean,
): SupplierOutcome {
  const supplierOrderId = order.id;
  const charged = chargedUnits(order.total_usd);
  const status = order.status.toLowerCase();
  if (status === 'created' || status === 'processing') {
    return { status: 'pending', supplierOrderId, ...charged };
  }
  if (status === 'failed' || status === 'refund') {
    return {
      status: 'failed_definitive',
      supplierOrderId,
      supplierCode: status.toUpperCase(),
      reason: order.fail_reason?.trim().slice(0, 200) || 'Failed by FazerCards',
    };
  }
  if (status !== 'completed') {
    return {
      status: 'unknown',
      supplierOrderId,
      reason: 'FazerCards order state unexpected',
      answered: true,
    };
  }
  if (!gift) return { status: 'delivered', supplierOrderId, quantity, ...charged };
  const codes = codeTexts(order.cards ?? []);
  if (codes === null || codes.length !== quantity) {
    return {
      status: 'unknown',
      supplierOrderId,
      reason:
        codes === null
          ? 'FazerCards delivered an unreadable code'
          : 'FazerCards delivered other units',
      answered: true,
    };
  }
  return { status: 'delivered', supplierOrderId, quantity, codes, ...charged };
}

/** A card as a code text, a pin kept as `<code> · PIN: <pin>`; null when one is unusable. */
function codeTexts(cards: readonly FzrCard[]): string[] | null {
  const codes = cards.map((card) => {
    if (typeof card === 'string') return card.trim();
    const code = card.code.trim();
    const pin = card.pin?.trim();
    return code && pin ? `${code} · PIN: ${pin}` : code;
  });
  return codes.every((code) => code !== '' && code.length <= MAX_CODE_LENGTH) ? codes : null;
}

/** S18 CH1: the order's total as `chargedUsdUnits`; nothing when unreadable. */
function chargedUnits(value: number | string | null | undefined): { chargedUsdUnits?: number } {
  if (value == null) return {};
  const units = usdUnits(value);
  return units === null ? {} : { chargedUsdUnits: units };
}

/** A FazerCards amount in USD, negative for a debit, or null. */
function signedUsd(
  value: number | string | null | undefined,
  debit: boolean,
): SupplierMoney | null {
  if (value == null) return null;
  const text = String(value).trim();
  const negative = text.startsWith('-');
  const units = usdUnits(negative ? text.slice(1) : text);
  if (units === null) return null;
  return { currency: 'USD', amountUnits: negative || debit ? -units : units };
}

/** An ISO time, or null. */
function dateOf(value: string | null | undefined): Date | null {
  if (!value) return null;
  const time = Date.parse(value.trim());
  return Number.isFinite(time) ? new Date(time) : null;
}

/** FC7: the body's `timestamp` in milliseconds: an ISO time, or Unix seconds or milliseconds. */
function instantOf(value: string | number): number | null {
  if (typeof value === 'number' || /^\d{9,13}$/.test(value)) {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) return null;
    return number < 1e12 ? number * 1000 : number;
  }
  return dateOf(value)?.getTime() ?? null;
}

/** Whether a statement page has a next one: by its total, else by a full page. */
function hasMore(page: number, reply: { items: unknown[]; total?: number | null }): boolean {
  return reply.total != null
    ? page * STATEMENT_PAGE_SIZE < reply.total
    : reply.items.length >= STATEMENT_PAGE_SIZE;
}

function refused(supplierCode: string, reason: string): SupplierOutcome {
  return { status: 'failed_definitive', supplierCode, reason };
}
