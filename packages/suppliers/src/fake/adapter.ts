import { randomBytes, randomUUID } from 'node:crypto';
import { USD_CENT } from '@vertex-digital/contracts';
import { z } from 'zod';
import type {
  OrderFields,
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
import { SupplierError } from '../core/errors.js';
import { hmacSha256, verifyHmacSignature } from '../core/hmac.js';

/*
 * The `fake` supplier (ADR 0005): in-process, for development, tests and E2E. Nothing leaves the
 * machine. The outcome of an order is scripted by the start of its `playerId` field:
 *
 *   delivered (anything else)  delivered at once (codes for code offers)
 *   slow…                      delivered after `slowMs`
 *   pending…                   pending; `completePending` returns the signed webhook
 *   fail…                      refused: failed_definitive (`FAKE_REFUSED`)
 *   unknown…                   unknown (as after a timeout); polling finds it delivered
 *   badsig…                    pending; its webhook carries a wrong signature
 *   invalid…                   `validatePlayer` answers invalid; an order is refused with
 *                              `inputRejected` (`PLAYER_NOT_FOUND`)
 *
 * Its catalog (S07) is about ten offers in three groups, changed by a `FakeSupplierState`: costs,
 * stock, removed offers, a failing sync, every call failing, the balance. The worker reads that
 * state from a git-ignored file the `supplier:fake` CLI writes (development and E2E only).
 *
 * S08: an offer's script (`orderScripts`, `supplier:fake --order`) decides its next orders before
 * the `playerId` prefix does (a code offer has no player): `delivered`, `pending` (until
 * resolved), `failed`, `invalid` (input rejected), `unknown` (no answer until resolved),
 * `partial:<n>` (n units delivered, the rest failed), `slow:<seconds>`. Orders are kept in the
 * state (`orders`): each change is handed to `onOrder`, which the worker persists, so a poll, a
 * repeated key and `supplier:fake --resolve` find them across calls and processes.
 */

export const FAKE_SUPPLIER_CODE = 'fake';

/** The headers of a fake webhook: Unix seconds, and HMAC-SHA256 hex of `${timestamp}.${body}`. */
export const FAKE_TIMESTAMP_HEADER = 'x-fake-timestamp';
export const FAKE_SIGNATURE_HEADER = 'x-fake-signature';

/** How an offer's next orders answer (S08, `supplier:fake --order`). */
export const fakeOrderScriptSchema = z.union([
  z.enum(['delivered', 'pending', 'failed', 'invalid', 'unknown']),
  /** 1 to 50 units. */
  z
    .templateLiteral(['partial:', z.int()])
    .refine((value) => /^partial:([1-9]|[1-4]\d|50)$/.test(value)),
  /** 1 to 600 seconds. */
  z
    .templateLiteral(['slow:', z.int()])
    .refine((value) => /^slow:([1-9]\d{0,2})$/.test(value) && Number(value.slice(5)) <= 600),
]);

export type FakeOrderScript = z.infer<typeof fakeOrderScriptSchema>;

const outcomeSchema: z.ZodType<SupplierOutcome> = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('delivered'),
    supplierOrderId: z.string(),
    quantity: z.int().positive(),
    codes: z.array(z.string()).optional(),
  }),
  z.object({ status: z.literal('pending'), supplierOrderId: z.string() }),
  z.object({
    status: z.literal('failed_definitive'),
    supplierOrderId: z.string().optional(),
    supplierCode: z.string().optional(),
    inputRejected: z.boolean().optional(),
    reason: z.string(),
  }),
  z.object({
    status: z.literal('unknown'),
    supplierOrderId: z.string().optional(),
    reason: z.string(),
  }),
]);

/** A placed order: the request, its answer, and what polling finds once it settles. */
const fakeOrderSchema = z.object({
  request: z.object({
    idempotencyKey: z.string(),
    offerId: z.string(),
    quantity: z.int().positive(),
    fields: z.record(z.string(), z.string()),
  }),
  outcome: outcomeSchema,
  settled: outcomeSchema,
});

export type FakeOrder = z.infer<typeof fakeOrderSchema>;

/** What the `supplier:fake` CLI scripts (S07): changes to the catalog and to the calls. */
export const fakeSupplierStateSchema = z.object({
  /** Offer id → cost in USD units. */
  costs: z.record(z.string(), z.int().min(1).max(Number.MAX_SAFE_INTEGER)).default({}),
  outOfStock: z.array(z.string()).default([]),
  /** Offers left out of the list (and refused when ordered). */
  removed: z.array(z.string()).default([]),
  /** `listOffers` fails; the other calls answer. */
  failSync: z.boolean().default(false),
  /** Every catalog, balance and validation call fails, as a supplier that is down. */
  errors: z.boolean().default(false),
  balanceUsdUnits: z.int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).optional(),
  /** S08: offer id → how its next orders answer. */
  orderScripts: z.record(z.string(), fakeOrderScriptSchema).default({}),
  /** S08: the orders placed so far, by idempotency key. */
  orders: z.record(z.string(), fakeOrderSchema).default({}),
});

export type FakeSupplierState = z.infer<typeof fakeSupplierStateSchema>;

export interface FakeAdapterOptions {
  webhookSecret: string;
  /**
   * Prepaid balance in USD units; an order costing more is refused. Default: the state's, else
   * 1,000 USD.
   */
  balanceUsdUnits?: number;
  /** The scripted changes (S07); none by default. */
  state?: FakeSupplierState;
  /** Delay of `slow…` orders. Default 3 seconds. */
  slowMs?: number;
  /** Called with every new or changed order, for the caller to keep (S08). */
  onOrder?: (idempotencyKey: string, order: FakeOrder) => Promise<void>;
}

const usd = (cents: number): SupplierMoney => ({ currency: 'USD', amountUnits: cents * USD_CENT });

type FakeOffer = SupplierOffer & { delivers: 'topup' | 'code' };

const topUp = (offerId: string, name: string, group: string, cents: number): FakeOffer => ({
  offerId,
  name,
  cost: usd(cents),
  inStock: true,
  group,
  kind: 'direct',
  requiredFields: ['playerId'],
  delivers: 'topup',
});

const giftCard = (offerId: string, name: string, cents: number): FakeOffer => ({
  offerId,
  name,
  cost: usd(cents),
  inStock: true,
  group: 'iTunes',
  kind: 'code',
  requiredFields: [],
  delivers: 'code',
});

/** The fake catalog: PUBG Mobile and Free Fire top-ups, and iTunes codes. */
const OFFERS: readonly FakeOffer[] = [
  topUp('fake-uc-60', 'Fake UC 60', 'PUBG Mobile', 88),
  topUp('fake-uc-325', 'Fake UC 325', 'PUBG Mobile', 440),
  topUp('fake-uc-660', 'Fake UC 660', 'PUBG Mobile', 870),
  topUp('fake-uc-1800', 'Fake UC 1800', 'PUBG Mobile', 2_190),
  topUp('fake-ff-100', 'Fake Free Fire 100', 'Free Fire', 95),
  topUp('fake-ff-310', 'Fake Free Fire 310', 'Free Fire', 290),
  topUp('fake-ff-520', 'Fake Free Fire 520', 'Free Fire', 480),
  topUp('fake-ff-1060', 'Fake Free Fire 1060', 'Free Fire', 950),
  giftCard('fake-gift-10', 'Fake gift card 10', 960),
  giftCard('fake-itunes-25', 'Fake iTunes 25', 2_400),
];

const webhookBodySchema = z.object({
  eventId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  supplierOrderId: z.string().min(1),
  status: z.enum(['delivered', 'failed']),
  /** The units delivered (S08). */
  quantity: z.int().positive().optional(),
  codes: z.array(z.string()).optional(),
});

/** A delivery of `units`, with one generated code per unit for a code offer. */
function deliveredOutcome(
  delivers: FakeOffer['delivers'],
  supplierOrderId: string,
  units: number,
): SupplierOutcome {
  return {
    status: 'delivered',
    supplierOrderId,
    quantity: units,
    ...(delivers === 'code' && {
      codes: Array.from(
        { length: units },
        () => `FAKE-${randomBytes(6).toString('hex').toUpperCase()}`,
      ),
    }),
  };
}

const sameRequest = (a: PlaceOrderRequest, b: PlaceOrderRequest) =>
  a.offerId === b.offerId &&
  a.quantity === b.quantity &&
  JSON.stringify(Object.entries(a.fields).sort()) ===
    JSON.stringify(Object.entries(b.fields).sort());

export class FakeSupplierAdapter implements SupplierAdapter {
  readonly code = FAKE_SUPPLIER_CODE;
  readonly capabilities: SupplierCapabilities = {
    validatePlayer: true,
    webhooks: true,
    balance: true,
    catalog: true,
  };

  private readonly orders: Map<string, FakeOrder>;
  private readonly state: FakeSupplierState;
  private balanceUnits: number;

  constructor(private readonly options: FakeAdapterOptions) {
    this.state = options.state ?? fakeSupplierStateSchema.parse({});
    this.orders = new Map(Object.entries(this.state.orders));
    this.balanceUnits =
      options.balanceUsdUnits ?? this.state.balanceUsdUnits ?? 1_000 * 100 * USD_CENT;
  }

  async listOffers(): Promise<SupplierOffer[]> {
    this.failIfScripted();
    if (this.state.failSync) throw new SupplierError('retryable', 'Fake catalog unavailable');
    return this.catalog().map(({ delivers: _, ...offer }) => offer);
  }

  async getBalance(): Promise<SupplierMoney> {
    this.failIfScripted();
    return { currency: 'USD', amountUnits: this.balanceUnits };
  }

  async validatePlayer(input: { offerId: string; fields: OrderFields }): Promise<PlayerValidation> {
    this.failIfScripted();
    const playerId = input.fields.playerId;
    if (!playerId) throw new SupplierError('definitive', 'playerId is required');
    if (playerId.startsWith('invalid')) return { valid: false };
    return { valid: true, playerName: `Player ${playerId.slice(-4)}` };
  }

  async placeOrder(request: PlaceOrderRequest): Promise<SupplierOutcome> {
    const existing = this.orders.get(request.idempotencyKey);
    if (existing) {
      // A supplier answers a repeated key with that order's current outcome, never a second
      // purchase; an order whose answer was lost is found as it really ended (S08 rule F3).
      if (!sameRequest(existing.request, request)) {
        return {
          status: 'failed_definitive',
          supplierCode: 'IDEMPOTENCY_KEY_REUSED',
          reason: 'Key reused for another order',
        };
      }
      return existing.outcome.status === 'unknown' ? existing.settled : existing.outcome;
    }
    const offer = this.catalog().find((candidate) => candidate.offerId === request.offerId);
    const playerId = request.fields.playerId ?? '';
    const script: FakeOrderScript | null = offer
      ? (this.state.orderScripts[offer.offerId] ?? null)
      : null;
    const as = (prefix: string, scripted: FakeOrderScript) =>
      script === null ? playerId.startsWith(prefix) : script === scripted;
    if (
      !offer ||
      (offer.delivers === 'topup' && !playerId) ||
      (script === null && playerId.startsWith('fail')) ||
      script === 'failed'
    ) {
      return this.record(request, {
        status: 'failed_definitive',
        supplierCode: 'FAKE_REFUSED',
        reason: offer ? 'Refused by the fake supplier' : 'Unknown offer',
      });
    }
    if (as('invalid', 'invalid')) {
      return this.record(request, {
        status: 'failed_definitive',
        supplierCode: 'PLAYER_NOT_FOUND',
        inputRejected: true,
        reason: 'Player not found at the fake supplier',
      });
    }
    if (!offer.inStock) {
      return this.record(request, {
        status: 'failed_definitive',
        supplierCode: 'OUT_OF_STOCK',
        reason: 'Out of stock at the fake supplier',
      });
    }
    const units = script?.startsWith('partial:')
      ? Math.min(request.quantity, Number(script.slice('partial:'.length)))
      : request.quantity;
    const cost = offer.cost.amountUnits * units;
    if (cost > this.balanceUnits) {
      return this.record(request, {
        status: 'failed_definitive',
        supplierCode: 'INSUFFICIENT_BALANCE',
        reason: 'Supplier balance too low',
      });
    }
    this.balanceUnits -= cost;
    const supplierOrderId = `fake-${randomUUID()}`;
    const delivered = deliveredOutcome(offer.delivers, supplierOrderId, units);

    if (as('pending', 'pending') || (script === null && playerId.startsWith('badsig'))) {
      return this.record(request, { status: 'pending', supplierOrderId }, delivered);
    }
    if (as('unknown', 'unknown')) {
      // A scripted `unknown` never answers until resolved (the hard limit, rule F7); the
      // `unknown…` player is found delivered by the first poll.
      return this.record(
        request,
        { status: 'unknown', reason: 'Fake supplier timed out' },
        script === 'unknown'
          ? { status: 'unknown', reason: 'Fake supplier has no answer' }
          : delivered,
      );
    }
    // Recorded before the delay, as a supplier that took the order and answers late.
    const recorded = await this.record(request, delivered);
    const slowMs = script?.startsWith('slow:')
      ? Number(script.slice('slow:'.length)) * 1_000
      : script === null && playerId.startsWith('slow')
        ? (this.options.slowMs ?? 3_000)
        : 0;
    if (slowMs > 0) await new Promise((resolve) => setTimeout(resolve, slowMs));
    return recorded;
  }

  async getOrder(idempotencyKey: string): Promise<SupplierOutcome> {
    const order = this.orders.get(idempotencyKey);
    if (!order) return { status: 'unknown', reason: 'No order with this key' };
    // Polling an unknown outcome finds what really happened; a pending one waits its webhook.
    return order.outcome.status === 'unknown' ? order.settled : order.outcome;
  }

  /**
   * Settles a pending order as delivered and returns the webhook the supplier would send, signed
   * (or, for `badsig…` orders, signed wrongly). For tests, development and E2E.
   */
  async completePending(idempotencyKey: string, now = new Date()): Promise<WebhookRequest> {
    if (this.orders.get(idempotencyKey)?.outcome.status !== 'pending') {
      throw new Error('No pending fake order with this key');
    }
    return this.resolve(idempotencyKey, 'delivered', now);
  }

  /**
   * S08 `supplier:fake --resolve`: settles a pending or unknown order as delivered or failed, so
   * the next poll finds it, and returns the signed webhook that reports it.
   */
  async resolve(
    idempotencyKey: string,
    status: 'delivered' | 'failed',
    now = new Date(),
  ): Promise<WebhookRequest> {
    const order = this.orders.get(idempotencyKey);
    const open = order?.outcome.status === 'pending' || order?.outcome.status === 'unknown';
    if (!order || !open) throw new Error('No open fake order with this key');
    const supplierOrderId =
      ('supplierOrderId' in order.outcome && order.outcome.supplierOrderId) ||
      `fake-${randomUUID()}`;
    const delivers =
      OFFERS.find((offer) => offer.offerId === order.request.offerId)?.delivers ?? 'topup';
    const result: SupplierOutcome =
      status === 'failed'
        ? { status: 'failed_definitive', supplierOrderId, reason: 'Failed by the fake supplier' }
        : order.settled.status === 'delivered'
          ? order.settled
          : deliveredOutcome(delivers, supplierOrderId, order.request.quantity);
    await this.keep(idempotencyKey, { ...order, outcome: result, settled: result });
    const rawBody = JSON.stringify({
      eventId: `evt-${randomUUID()}`,
      idempotencyKey,
      supplierOrderId,
      status,
      ...(result.status === 'delivered' && {
        quantity: result.quantity,
        ...(result.codes && { codes: result.codes }),
      }),
    });
    const timestamp = Math.floor(now.getTime() / 1000).toString();
    const secret = order.request.fields.playerId?.startsWith('badsig')
      ? 'not-the-secret'
      : this.options.webhookSecret;
    return {
      headers: {
        [FAKE_TIMESTAMP_HEADER]: timestamp,
        [FAKE_SIGNATURE_HEADER]: hmacSha256(secret, `${timestamp}.${rawBody}`),
      },
      rawBody,
    };
  }

  verifyWebhook(request: WebhookRequest, now?: Date): boolean {
    const timestamp = request.headers[FAKE_TIMESTAMP_HEADER];
    if (!timestamp || !/^\d+$/.test(timestamp)) return false;
    return verifyHmacSignature({
      secret: this.options.webhookSecret,
      signedPayload: `${timestamp}.${request.rawBody}`,
      signature: request.headers[FAKE_SIGNATURE_HEADER],
      timestamp: Number(timestamp),
      ...(now && { now }),
    });
  }

  parseWebhook(request: WebhookRequest): SupplierWebhookEvent {
    let parsed: z.infer<typeof webhookBodySchema>;
    try {
      parsed = webhookBodySchema.parse(JSON.parse(request.rawBody));
    } catch (cause) {
      throw new SupplierError('definitive', 'Malformed fake webhook', { cause });
    }
    const outcome: SupplierOutcome =
      parsed.status === 'delivered'
        ? {
            status: 'delivered',
            supplierOrderId: parsed.supplierOrderId,
            quantity: parsed.quantity ?? parsed.codes?.length ?? 1,
            ...(parsed.codes && { codes: parsed.codes }),
          }
        : {
            status: 'failed_definitive',
            supplierOrderId: parsed.supplierOrderId,
            reason: 'Failed by the fake supplier',
          };
    return { eventId: parsed.eventId, idempotencyKey: parsed.idempotencyKey, outcome };
  }

  /** The catalog with the scripted costs, stock and removals. */
  private catalog(): FakeOffer[] {
    const { costs, outOfStock, removed } = this.state;
    return OFFERS.filter((offer) => !removed.includes(offer.offerId)).map((offer) => ({
      ...offer,
      cost: { currency: 'USD', amountUnits: costs[offer.offerId] ?? offer.cost.amountUnits },
      inStock: !outOfStock.includes(offer.offerId),
    }));
  }

  /** A supplier that is down: no answer (S07 acceptance, `--errors on`). */
  private failIfScripted(): void {
    if (this.state.errors) throw new SupplierError('retryable', 'Fake supplier timed out');
  }

  private async record(
    request: PlaceOrderRequest,
    outcome: SupplierOutcome,
    settled: SupplierOutcome = outcome,
  ): Promise<SupplierOutcome> {
    await this.keep(request.idempotencyKey, { request, outcome, settled });
    return outcome;
  }

  private async keep(idempotencyKey: string, order: FakeOrder): Promise<void> {
    this.orders.set(idempotencyKey, order);
    await this.options.onOrder?.(idempotencyKey, order);
  }
}
