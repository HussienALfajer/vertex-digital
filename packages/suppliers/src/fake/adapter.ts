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
 */

export const FAKE_SUPPLIER_CODE = 'fake';

/** The headers of a fake webhook: Unix seconds, and HMAC-SHA256 hex of `${timestamp}.${body}`. */
export const FAKE_TIMESTAMP_HEADER = 'x-fake-timestamp';
export const FAKE_SIGNATURE_HEADER = 'x-fake-signature';

export interface FakeAdapterOptions {
  webhookSecret: string;
  /** Prepaid balance in USD units; an order costing more is refused. Default 1,000 USD. */
  balanceUsdUnits?: number;
  /** Delay of `slow…` orders. Default 3 seconds. */
  slowMs?: number;
}

const usd = (cents: number): SupplierMoney => ({ currency: 'USD', amountUnits: cents * USD_CENT });

/** The fake catalog: two direct top-ups and one code product. */
const OFFERS: (SupplierOffer & { delivers: 'topup' | 'code' })[] = [
  { offerId: 'fake-uc-60', name: 'Fake UC 60', cost: usd(88), inStock: true, delivers: 'topup' },
  { offerId: 'fake-uc-325', name: 'Fake UC 325', cost: usd(440), inStock: true, delivers: 'topup' },
  {
    offerId: 'fake-gift-10',
    name: 'Fake gift card 10',
    cost: usd(960),
    inStock: true,
    delivers: 'code',
  },
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
  private balanceUnits: number;

  constructor(private readonly options: FakeAdapterOptions) {
    this.balanceUnits = options.balanceUsdUnits ?? 1_000 * 100 * USD_CENT;
  }

  async listOffers(): Promise<SupplierOffer[]> {
    return OFFERS.map(({ delivers: _, ...offer }) => offer);
  }

  async getBalance(): Promise<SupplierMoney> {
    return { currency: 'USD', amountUnits: this.balanceUnits };
  }

  async validatePlayer(input: { offerId: string; fields: OrderFields }): Promise<PlayerValidation> {
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
    const offer = OFFERS.find((candidate) => candidate.offerId === request.offerId);
    const playerId = request.fields.playerId ?? '';
    if (!offer || !playerId || playerId.startsWith('fail')) {
      return this.record(request, {
        status: 'failed_definitive',
        supplierCode: 'FAKE_REFUSED',
        reason: offer ? 'Refused by the fake supplier' : 'Unknown offer',
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

  private record(
    request: PlaceOrderRequest,
    outcome: SupplierOutcome,
    settled: SupplierOutcome = outcome,
  ): SupplierOutcome {
    this.orders.set(request.idempotencyKey, { request, outcome, settled });
    return outcome;
  }
}
