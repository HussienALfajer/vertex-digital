import type {
  Currency,
  FailureKind,
  FieldSpec,
  OfferUnsupportedReason,
  ProductKind,
} from '@vertex-digital/contracts';

/*
 * The one interface every supplier adapter implements (ADR 0005). Adapters are pure HTTP
 * clients: injected `fetch`, timeouts, Zod parsing of every response; no database, no Nest, no
 * environment. The worker routes orders and stores attempts; the adapter only talks to its
 * supplier and classifies the answer.
 */

/** What a supplier's API offers; routing and the store check these before calling. */
export interface SupplierCapabilities {
  /** Checks a player ID and returns the in-game name. */
  validatePlayer: boolean;
  /** Pushes order results by HMAC-signed webhook; otherwise polling only. */
  webhooks: boolean;
  /** Reports the prepaid balance (A07). */
  balance: boolean;
  /** Lists offers with costs (price sync, A06). */
  catalog: boolean;
  /** S16 SC1: lists its category tree (`listCategories`). */
  categories: boolean;
  /** S16 SF3: reads its wallet transactions and order history (`listTransactions`, `listOrders`). */
  statement: boolean;
  /** S16 SF5: reports its own status (`getPlatformStatus`). */
  platformStatus: boolean;
  /** S18 PQ1: reads one offer's current cost (`getOfferQuote`), before a purchase. */
  offerQuote: boolean;
  /**
   * S19 FC3: offers are read one category at a time (`listOffersIn`), for the categories the sync
   * picks; `listOffers` is not used.
   */
  offerWindow: boolean;
  /** S19 FC8, FC9: reads its plan (`getAccount`) and sets its webhook (`setWebhook`, …). */
  account: boolean;
}

/** A money amount in integer units of a currency (ADR 0003). */
export interface SupplierMoney {
  currency: Currency;
  amountUnits: number;
}

export interface SupplierOffer {
  /** The supplier's own id for the pack. */
  offerId: string;
  name: string;
  cost: SupplierMoney;
  inStock: boolean;
  /** The supplier's game or category, when it gives one (for the panel's filters). */
  group?: string;
  /** Top-up or code, when the supplier says (S07 rule RT2). */
  kind?: ProductKind;
  /** The supplier's own names of the order fields, when it publishes them (rule RT3). */
  requiredFields?: string[];
  /** S16 SC3: the supplier's leaf category id. */
  categoryId?: string;
  /** S16 SF2: units in stock; absent when unlimited or not reported. */
  stock?: number;
  /** S16 SF1: the supplier's price before its discount. */
  originalCost?: SupplierMoney;
  /** S16 SC3: the account fields with labels, types and options. */
  fieldSpecs?: FieldSpec[];
  /** S16 SC3: kept in the catalog but not usable by this build (two fields, a select). */
  unsupportedReason?: OfferUnsupportedReason;
  /** S18 DC1: the supplier's own discount on this offer, in basis points (2% = 200). */
  discountBp?: number;
  /** S19: the units one order may take, when the supplier bounds them (gift cards). */
  minQuantity?: number;
  maxQuantity?: number;
}

/** S18 PQ1: one offer's cost and availability now. */
export interface SupplierOfferQuote {
  cost: SupplierMoney;
  inStock: boolean;
}

/** S16 SC1: one node of the supplier's category tree. */
export interface SupplierCategory {
  categoryId: string;
  parentCategoryId?: string;
  name: string;
  kind?: ProductKind;
  productCount?: number;
  inStockCount?: number;
  /** HTTPS on one of the adapter's `imageHosts`; left out otherwise (rule IM1). */
  imageUrl?: string;
  /** S19: the supplier's own text on the category (FazerCards' region and delivery note). */
  note?: string;
}

/** S19 FC3: the offers of the categories read, and which were read (a failed one is not). */
export interface SupplierOfferWindow {
  offers: SupplierOffer[];
  readCategoryIds: string[];
}

/** S19 FC9: the supplier's plan. */
export interface SupplierAccount {
  plan: string;
  expiresAt?: Date;
  active: boolean;
  autoRenew?: boolean;
}

/** S19 FC8: one delivery in the supplier's webhook log. */
export interface SupplierWebhookDeliveryRow {
  id: string;
  event: string;
  attempt?: number;
  status: string;
  responseStatus?: number;
  durationMs?: number;
  createdAt?: Date;
}

/** S19 FC8: the supplier's webhook settings, never its secret. */
export interface SupplierWebhookState {
  url?: string;
  enabled: boolean;
  consecutiveFailures?: number;
  lastSuccessAt?: Date;
  lastFailureAt?: Date;
  lastFailureReason?: string;
}

/** S16 SF3: a page of the supplier's statement, newest first. */
export interface SupplierStatementPage<Item> {
  items: Item[];
  hasMore: boolean;
}

/** S16 SF3: one movement of the supplier's wallet; what it does not say is left out. */
export interface SupplierTransactionRow {
  id: string;
  type?: string;
  amount?: SupplierMoney;
  balanceAfter?: SupplierMoney;
  reference?: string;
  supplierOrderId?: string;
  createdAt?: Date;
}

/** S16 SF3: one order of the supplier's history; what it does not say is left out. */
export interface SupplierOrderRow {
  supplierOrderId: string;
  offerId?: string;
  offerName?: string;
  quantity?: number;
  status?: string;
  total?: SupplierMoney;
  createdAt?: Date;
  /** S18 ST1: when the supplier completed it. */
  completedAt?: Date;
}

/** S16 SF5. */
export interface SupplierPlatformStatus {
  status: string;
  catalogUpdatedAt?: Date;
}

/** S16 IM1, IM2: how much of an image is read, and for how long. */
export interface ImageLimits {
  maxBytes: number;
  timeoutMs: number;
}

export interface PlayerValidation {
  valid: boolean;
  /** The in-game name, when the supplier returns it. */
  playerName?: string;
  /** S19 PC3: the account's region, when the supplier returns it. */
  region?: string;
}

/** Input field values of an order, keyed by the supplier's own field names (ADR 0005). */
export type OrderFields = Record<string, string>;

export interface PlaceOrderRequest {
  /**
   * One key per fulfilment attempt, sent to the supplier as its idempotency key or order id:
   * sending the same request again can never buy twice (ADR 0004).
   */
  idempotencyKey: string;
  offerId: string;
  quantity: number;
  fields: OrderFields;
  /**
   * S16 rule RS1: the attempt was sent before. Adapters classify answers as usual; the engine
   * treats a refusal of a re-send as unknown.
   */
  resend?: boolean;
}

/**
 * The result of an order call, classified for the order state machine (ADR 0004):
 * - `delivered`: done for `quantity` units (1 to the units asked; fewer means the rest failed
 *   definitively, S08); one code per unit for code products (kept encrypted by the caller);
 * - `pending`: accepted, the result comes later by webhook or poll;
 * - `failed_definitive`: refused, nothing was bought; the next route may be tried, unless
 *   `inputRejected` says the supplier refused the account fields (every route would);
 * - `unknown`: no trustworthy answer (timeout, lost connection, unexpected reply). Never retried
 *   elsewhere until it is resolved by polling, then by the admin.
 *
 * A repeated `placeOrder` with the same key answers that order's current outcome, never a
 * duplicate error (S08).
 */
/**
 * The code an adapter gives a refusal for stock (S17 rule WR8: a finite-stock offer is then marked
 * out until the next sync); WDGZone's own code, which the fake supplier uses too.
 */
export const OUT_OF_STOCK_CODE = 'OUT_OF_STOCK';

/**
 * S19 FC5, FC9: the code an adapter gives a refusal for an inactive plan (FazerCards' own): the
 * worker then treats the supplier's plan as inactive, so it takes no order or check until renewed.
 */
export const SUBSCRIPTION_INACTIVE_CODE = 'subscription_inactive';

export type SupplierOutcome =
  | {
      status: 'delivered';
      supplierOrderId: string;
      quantity: number;
      codes?: string[];
      /** S18 CH1: what the supplier says it charged for the order, in USD units. */
      chargedUsdUnits?: number;
    }
  | { status: 'pending'; supplierOrderId: string; chargedUsdUnits?: number }
  | {
      status: 'failed_definitive';
      supplierOrderId?: string;
      /** The supplier's own error code, kept for the admin and the error mapping. */
      supplierCode?: string;
      /** The supplier refused the account fields (player not found, wrong zone). */
      inputRejected?: boolean;
      reason: string;
    }
  | {
      status: 'unknown';
      supplierOrderId?: string;
      reason: string;
      /**
       * S18 HE4: the supplier answered and the answer was read, but it does not settle the order
       * yet (still processing, not found so soon): not a fault of the supplier.
       */
      answered?: boolean;
      /** S18 HE6, FK1: the supplier's code, why there was no answer, and the reply's status. */
      supplierCode?: string;
      failure?: FailureKind;
      httpStatus?: number;
    };

export type SupplierOutcomeStatus = SupplierOutcome['status'];

/**
 * What the caller knows of an order it placed, for suppliers that look orders up by their own id
 * and do not report the units (WDGZone): the supplier's order id from an earlier answer, and the
 * units asked.
 */
export interface PlacedOrder {
  supplierOrderId?: string;
  quantity: number;
}

/** A webhook as the API received it: the raw body is what the signature covers. */
export interface WebhookRequest {
  headers: Record<string, string | undefined>;
  rawBody: string;
}

/** Names its order by the idempotency key, the supplier's order id, or both. */
export interface SupplierWebhookEvent {
  /** Unique per supplier: stored once against replays (ADR 0005). */
  eventId: string;
  /** The idempotency key the order was placed with, when the supplier sends it back. */
  idempotencyKey?: string;
  /** The supplier's own order id, for suppliers whose webhooks carry only that (WDGZone). */
  supplierOrderId?: string;
  outcome: SupplierOutcome;
  /** S19 FC7: an event that names no order result (a test, a creation): stored, never applied. */
  ignored?: boolean;
}

export interface SupplierAdapter {
  /** The supplier code (`wdgzone`, `fake`). */
  readonly code: string;
  readonly capabilities: SupplierCapabilities;
  listOffers(): Promise<SupplierOffer[]>;
  getBalance(): Promise<SupplierMoney>;
  /** `categoryId`: the supplier's own check category, for suppliers that check by one (S19 PC2). */
  validatePlayer(input: {
    offerId: string;
    categoryId?: string;
    fields: OrderFields;
  }): Promise<PlayerValidation>;
  /** Never throws: every failure is classified into the outcome. */
  placeOrder(request: PlaceOrderRequest): Promise<SupplierOutcome>;
  /**
   * The current result of an order placed with `idempotencyKey`; never throws. `placed` is what
   * the caller kept of it, for suppliers that need their own order id to find it.
   */
  getOrder(idempotencyKey: string, placed?: PlacedOrder): Promise<SupplierOutcome>;
  /** HMAC with a timing-safe compare and a timestamp tolerance. */
  verifyWebhook(request: WebhookRequest, now?: Date): boolean;
  /** Parses a verified webhook; throws a definitive `SupplierError` on a malformed one. */
  parseWebhook(request: WebhookRequest): SupplierWebhookEvent;
  /** S16 IM1: the HTTPS hosts its category images may be fetched from. */
  readonly imageHosts: readonly string[];
  /** S16 SC1, behind `categories`. */
  listCategories(): Promise<SupplierCategory[]>;
  /** S16 SF3, behind `statement`: pages from 1, newest first. */
  listTransactions(page: number): Promise<SupplierStatementPage<SupplierTransactionRow>>;
  listOrders(page: number): Promise<SupplierStatementPage<SupplierOrderRow>>;
  /** S16 SF5, behind `platformStatus`. */
  getPlatformStatus(): Promise<SupplierPlatformStatus>;
  /** S18 PQ1, behind `offerQuote`: one offer's current cost; throws a `SupplierError`. */
  getOfferQuote(offerId: string): Promise<SupplierOfferQuote>;
  /**
   * S16 IM1, IM2: a category image's bytes, only from `imageHosts` over HTTPS, never through a
   * redirect to another host, within the limits; throws a `SupplierError` otherwise.
   */
  fetchImage(url: string, limits: ImageLimits): Promise<Uint8Array>;
  /** S19 FC3, behind `offerWindow`: the offers of these categories; throws when none was read. */
  listOffersIn(categoryIds: readonly string[]): Promise<SupplierOfferWindow>;
  /** S19 FC9, behind `account`. */
  getAccount(): Promise<SupplierAccount>;
  /** S19 FC8, behind `account`: the settings and the last deliveries. */
  getWebhook(): Promise<{ state: SupplierWebhookState; deliveries: SupplierWebhookDeliveryRow[] }>;
  /** S19 FC8: points the supplier's webhook at `url`, enabled. */
  setWebhook(url: string): Promise<SupplierWebhookState>;
  /** S19 FC8: asks the supplier to send its test event. */
  testWebhook(): Promise<void>;
}
