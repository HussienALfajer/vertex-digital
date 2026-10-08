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
 *   invalid…                   `validatePlayer` answers invalid
 *
 * Its catalog (S07) is about ten offers in three groups, changed by a `FakeSupplierState`: costs,
 * stock, removed offers, a failing sync, every call failing, the balance. The worker reads that
 * state from a git-ignored file the `supplier:fake` CLI writes (development and E2E only).
 */

export const FAKE_SUPPLIER_CODE = 'fake';

/** The headers of a fake webhook: Unix seconds, and HMAC-SHA256 hex of `${timestamp}.${body}`. */
export const FAKE_TIMESTAMP_HEADER = 'x-fake-timestamp';
export const FAKE_SIGNATURE_HEADER = 'x-fake-signature';

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

interface FakeOrder {
  request: PlaceOrderRequest;
  outcome: SupplierOutcome;
  /** What polling finds once the order settles (pending and unknown orders). */
  settled: SupplierOutcome;
}

const webhookBodySchema = z.object({
  eventId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  supplierOrderId: z.string().min(1),
  status: z.enum(['delivered', 'failed']),
  codes: z.array(z.string()).optional(),
});

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

  private readonly orders = new Map<string, FakeOrder>();
  private readonly state: FakeSupplierState;
  private balanceUnits: number;

  constructor(private readonly options: FakeAdapterOptions) {
    this.state = options.state ?? fakeSupplierStateSchema.parse({});
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
      // A supplier answers a repeated key with the first order, never a second purchase.
      return sameRequest(existing.request, request)
        ? existing.outcome
        : {
            status: 'failed_definitive',
            supplierCode: 'IDEMPOTENCY_KEY_REUSED',
            reason: 'Key reused for another order',
          };
    }
    const offer = this.catalog().find((candidate) => candidate.offerId === request.offerId);
    const playerId = request.fields.playerId ?? '';
    if (!offer || !playerId || playerId.startsWith('fail')) {
      return this.record(request, {
        status: 'failed_definitive',
        supplierCode: 'FAKE_REFUSED',
        reason: offer ? 'Refused by the fake supplier' : 'Unknown offer',
      });
    }
    if (!offer.inStock) {
      return this.record(request, {
        status: 'failed_definitive',
        supplierCode: 'OUT_OF_STOCK',
        reason: 'Out of stock at the fake supplier',
      });
    }
    const cost = offer.cost.amountUnits * request.quantity;
    if (cost > this.balanceUnits) {
      return this.record(request, {
        status: 'failed_definitive',
        supplierCode: 'INSUFFICIENT_BALANCE',
        reason: 'Supplier balance too low',
      });
    }
    this.balanceUnits -= cost;
    const supplierOrderId = `fake-${randomUUID()}`;
    const delivered: SupplierOutcome = {
      status: 'delivered',
      supplierOrderId,
      ...(offer.delivers === 'code' && {
        codes: Array.from(
          { length: request.quantity },
          () => `FAKE-${randomBytes(6).toString('hex').toUpperCase()}`,
        ),
      }),
    };

    if (playerId.startsWith('slow')) {
      await new Promise((resolve) => setTimeout(resolve, this.options.slowMs ?? 3_000));
    }
    if (playerId.startsWith('pending') || playerId.startsWith('badsig')) {
      return this.record(request, { status: 'pending', supplierOrderId }, delivered);
    }
    if (playerId.startsWith('unknown')) {
      return this.record(
        request,
        { status: 'unknown', reason: 'Fake supplier timed out' },
        delivered,
      );
    }
    return this.record(request, delivered);
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
  completePending(idempotencyKey: string, now = new Date()): WebhookRequest {
    const order = this.orders.get(idempotencyKey);
    if (order?.outcome.status !== 'pending') throw new Error('No pending fake order with this key');
    order.outcome = order.settled;
    const settled = order.settled as Extract<SupplierOutcome, { status: 'delivered' }>;
    const rawBody = JSON.stringify({
      eventId: `evt-${randomUUID()}`,
      idempotencyKey,
      supplierOrderId: settled.supplierOrderId,
      status: 'delivered',
      ...(settled.codes && { codes: settled.codes }),
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

  private record(
    request: PlaceOrderRequest,
    outcome: SupplierOutcome,
    settled: SupplierOutcome = outcome,
  ): SupplierOutcome {
    this.orders.set(request.idempotencyKey, { request, outcome, settled });
    return outcome;
  }
}
