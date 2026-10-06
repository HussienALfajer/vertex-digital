import type { Currency } from '@vertex-digital/contracts';

/*
 * The one interface every supplier adapter implements (ADR 0005). Adapters are pure HTTP
 * clients: injected `fetch`, timeouts, Zod parsing of every response; no database, no Nest, no
 * environment. The worker routes orders and stores attempts; the adapter only talks to its
 * supplier and classifies the answer.
 */

/** What a supplier's API offers; routing and the store check these before calling. */
export interface SupplierCapabilities {
  /** Checks a player ID and returns the in-game name (SHOP2TOPUP). */
  validatePlayer: boolean;
  /** Pushes order results by HMAC-signed webhook; otherwise polling only. */
  webhooks: boolean;
  /** Reports the prepaid balance (A07). */
  balance: boolean;
  /** Lists offers with costs (price sync, A06). */
  catalog: boolean;
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
}

export interface PlayerValidation {
  valid: boolean;
  /** The in-game name, when the supplier returns it. */
  playerName?: string;
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
}

/**
 * The result of an order call, classified for the order state machine (ADR 0004):
 * - `delivered`: done; codes for code products (kept encrypted by the caller);
 * - `pending`: accepted, the result comes later by webhook or poll;
 * - `failed_definitive`: refused, nothing was bought; the next route may be tried;
 * - `unknown`: no trustworthy answer (timeout, lost connection, unexpected reply). Never retried
 *   elsewhere until it is resolved by polling, then by staff.
 */
export type SupplierOutcome =
  | { status: 'delivered'; supplierOrderId: string; codes?: string[] }
  | { status: 'pending'; supplierOrderId: string }
  | {
      status: 'failed_definitive';
      supplierOrderId?: string;
      /** The supplier's own error code, kept for staff and the error mapping. */
      supplierCode?: string;
      reason: string;
    }
  | { status: 'unknown'; supplierOrderId?: string; reason: string };

export type SupplierOutcomeStatus = SupplierOutcome['status'];

/** A webhook as the API received it: the raw body is what the signature covers. */
export interface WebhookRequest {
  headers: Record<string, string | undefined>;
  rawBody: string;
}

export interface SupplierWebhookEvent {
  /** Unique per supplier: stored once against replays (ADR 0005). */
  eventId: string;
  /** The idempotency key the order was placed with. */
  idempotencyKey: string;
  outcome: SupplierOutcome;
}

export interface SupplierAdapter {
  /** The supplier code (`shop2topup`, `wdgzone`, `fake`). */
  readonly code: string;
  readonly capabilities: SupplierCapabilities;
  listOffers(): Promise<SupplierOffer[]>;
  getBalance(): Promise<SupplierMoney>;
  validatePlayer(input: { offerId: string; fields: OrderFields }): Promise<PlayerValidation>;
  /** Never throws: every failure is classified into the outcome. */
  placeOrder(request: PlaceOrderRequest): Promise<SupplierOutcome>;
  /** The current result of an order placed with `idempotencyKey`; never throws. */
  getOrder(idempotencyKey: string): Promise<SupplierOutcome>;
  /** HMAC with a timing-safe compare and a timestamp tolerance. */
  verifyWebhook(request: WebhookRequest, now?: Date): boolean;
  /** Parses a verified webhook; throws a definitive `SupplierError` on a malformed one. */
  parseWebhook(request: WebhookRequest): SupplierWebhookEvent;
}
