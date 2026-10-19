import {
  chargeCheck,
  isResendRefusal,
  OPTION_UNMAPPED_REASON,
  RESEND_REFUSED_REASON,
  SUPPLIER_COST_MAX_USD_UNITS,
} from '@vertex-digital/contracts';
import {
  type AppliedOutcome,
  type AttemptOutcome,
  type AttemptRow,
  addOrderEvent,
  bossJobSender,
  type Database,
  fulfilmentAttempts,
  type JobSender,
  markOfferOutOfStock,
  type OrderContext,
  orders,
  productRoutes,
  queueTelegramMessage,
  type RoutingContext,
  recordObservedCost,
  suppliers,
  type Transaction,
} from '@vertex-digital/db';
import {
  OUT_OF_STOCK_CODE,
  outcomeOfOrderError,
  type SupplierOutcome,
} from '@vertex-digital/suppliers';
import { and, eq, inArray } from 'drizzle-orm';
import type { Env } from '../../core/config/env.js';
import type { PgBossService } from '../../core/jobs/pg-boss.service.js';
import {
  type CallVerdict,
  recordedCall,
  sanitizedMessage,
} from '../../suppliers/supplier-calls.js';
import type { SupplierRegistry } from '../../suppliers/supplier-registry.js';

/*
 * The supplier side of an attempt (S08 rules R3, F3): `placeOrder` with the attempt id as the
 * idempotency key, or `getOrder` for a pending one, each recorded in `supplier_calls`, the answer
 * classified for `applyOutcome`. Outcomes carry codes: never logged, never in an error.
 */

type Executor = Database | Transaction;

/** The order context of a job: jobs in the caller's transaction, the codes key, the time. */
export function orderContext(
  pgBoss: PgBossService,
  codesKey: Buffer,
  now = new Date(),
): OrderContext {
  return { jobs: bossJobSender(pgBoss.boss), codesKey, now };
}

/** What repricing reads from the worker: the time and the fake supplier's switch. */
export function routingContext(env: Pick<Env, 'SUPPLIER_FAKE_ENABLED'>, now = new Date()) {
  return { now, fakeEnabled: env.SUPPLIER_FAKE_ENABLED } satisfies RoutingContext;
}

/**
 * S17 rule WR8, in the transaction that failed the attempt: a send refused as out of stock marks
 * a finite-stock offer out until the next sync and reprices what it serves. Only a first send can
 * fail an attempt (S16 RS1: a refused re-send is `unknown`), so a re-send marks nothing.
 */
export async function markStockRefusal(
  tx: Transaction,
  applied: AppliedOutcome,
  outcome: AttemptOutcome,
  context: RoutingContext,
): Promise<boolean> {
  const { attempt } = applied;
  if (!applied.applied || outcome.status !== 'failed' || attempt.offerId === null) return false;
  if (outcome.supplierErrorCode !== OUT_OF_STOCK_CODE) return false;
  return markOfferOutOfStock(tx, attempt.offerId, context);
}

/**
 * How an order answer counts for health (S07 rule H1): a refusal is `refused`, an `unknown` an
 * `error` with why (S18 FK1), unless the supplier answered and only the order is not settled yet
 * (S18 HE4: still processing, not found so soon), which is `ok`. The supplier's code is kept
 * (HE6).
 */
const callVerdict = (outcome: SupplierOutcome): CallVerdict => {
  const code = 'supplierCode' in outcome ? outcome.supplierCode : undefined;
  const supplierCode = code !== undefined ? { supplierCode: code } : {};
  if (outcome.status === 'failed_definitive') return { result: 'refused', ...supplierCode };
  if (outcome.status !== 'unknown' || outcome.answered === true) {
    return { result: 'ok', ...supplierCode };
  }
  return {
    result: 'error',
    ...supplierCode,
    failure: outcome.failure ?? 'other',
    ...(outcome.httpStatus !== undefined && { httpStatus: outcome.httpStatus }),
  };
};

/**
 * The adapter's answer as the write path takes it, reasons cleaned of credentials. S16 rule RS1: a
 * refusal of a re-send is `unknown` (`resend_refused`, the supplier's code kept): the first send
 * may have bought the order, so only the first send of an attempt can fail it.
 */
export function attemptOutcome(
  outcome: SupplierOutcome,
  secrets: readonly string[],
  resend = false,
): AttemptOutcome {
  const clean = (reason: string) => sanitizedMessage(reason, secrets).slice(0, 200);
  if (outcome.status === 'failed_definitive' && isResendRefusal(outcome, resend)) {
    return {
      status: 'unknown',
      reason: RESEND_REFUSED_REASON,
      supplierErrorCode: outcome.supplierCode ?? null,
      supplierOrderId: outcome.supplierOrderId ?? null,
    };
  }
  switch (outcome.status) {
    case 'delivered':
      return {
        status: 'delivered',
        quantity: outcome.quantity,
        ...(outcome.codes && { codes: outcome.codes }),
        supplierOrderId: outcome.supplierOrderId,
        ...(outcome.chargedUsdUnits !== undefined && { chargedUsdUnits: outcome.chargedUsdUnits }),
      };
    case 'pending':
      return {
        status: 'pending',
        supplierOrderId: outcome.supplierOrderId,
        ...(outcome.chargedUsdUnits !== undefined && { chargedUsdUnits: outcome.chargedUsdUnits }),
      };
    case 'failed_definitive':
      return {
        status: 'failed',
        reason: clean(outcome.reason),
        inputRejected: outcome.inputRejected === true,
        supplierErrorCode: outcome.supplierCode ?? null,
        supplierOrderId: outcome.supplierOrderId ?? null,
      };
    default:
      return {
        status: 'unknown',
        reason: clean(outcome.reason),
        supplierOrderId: outcome.supplierOrderId ?? null,
      };
  }
}

/**
 * Asks the attempt's supplier: `place` sends the order (rule R3), `resend` sends it again with the
 * same key (rules F3, F6; S16 RS1: a refusal is then `unknown`), `get` reads a pending one. A
 * supplier with no adapter or credentials here now gives `unknown` (rule F8: the attempt stays
 * with it and is polled again).
 */
export async function askSupplier(
  db: Executor,
  registry: SupplierRegistry,
  attempt: AttemptRow,
  call: 'place' | 'resend' | 'get',
): Promise<AttemptOutcome> {
  const { routeId, supplierOfferId } = attempt;
  // S11: an `admin_fulfil` attempt is closed from its insert and never asked (edge case 17).
  if (routeId === null || supplierOfferId === null) {
    throw new Error(`Attempt ${attempt.id} has no route to ask`);
  }
  const [row] = await db
    .select({
      code: suppliers.code,
      fieldMap: productRoutes.fieldMap,
      optionMap: productRoutes.optionMap,
      fields: orders.fields,
    })
    .from(suppliers)
    .innerJoin(productRoutes, eq(productRoutes.id, routeId))
    .innerJoin(orders, eq(orders.id, attempt.orderId))
    .where(eq(suppliers.id, attempt.supplierId));
  if (!row) throw new Error(`Attempt ${attempt.id} names no supplier, route or order`);
  let connected: Awaited<ReturnType<SupplierRegistry['connect']>> = null;
  try {
    connected = await registry.connect(db, { id: attempt.supplierId, code: row.code });
  } catch {
    // Credentials that do not decrypt: the same as none (the admin is told by the health job).
  }
  if (!connected) return { status: 'unknown', reason: 'supplier_unavailable' };
  const { adapter, secrets } = connected;
  // The maps the attempt was written with (S07 rule RT3: the supplier's field name → the order's
  // input field key; S16 MF2: our option value → the supplier's), so a re-send under the same key
  // is the same request whatever the route's maps became. An attempt written before the option
  // map has none (read as `{}`); one written before the field map follows the route's maps.
  const optionMap = attempt.fieldMap ? (attempt.optionMap ?? {}) : row.optionMap;
  const unmapped: string[] = [];
  const fields = Object.fromEntries(
    Object.entries(attempt.fieldMap ?? row.fieldMap).map(([name, key]) => {
      const value = row.fields[key] ?? '';
      const options = Object.hasOwn(optionMap, name) ? optionMap[name] : undefined;
      if (!options || value === '') return [name, value];
      if (!Object.hasOwn(options, value)) unmapped.push(name);
      return [name, options[value] ?? value];
    }),
  );
  // S16 MF2: a supplier select is only ever sent a value from its own list. An order's option the
  // attempt's map lacks (renamed or removed since it was paid) is refused here, before anything is
  // sent: the attempt's map is fixed, so no earlier send of this key went out either.
  if (call !== 'get' && unmapped.length > 0) {
    return {
      status: 'failed',
      reason: OPTION_UNMAPPED_REASON,
      inputRejected: false,
      supplierErrorCode: null,
      supplierOrderId: null,
    };
  }
  const answer = await recordedCall(
    db,
    attempt.supplierId,
    call === 'get' ? 'get_order' : 'place_order',
    () =>
      call !== 'get'
        ? adapter.placeOrder({
            idempotencyKey: attempt.id,
            offerId: supplierOfferId,
            quantity: attempt.quantity,
            fields,
            resend: call === 'resend',
          })
        : adapter.getOrder(attempt.id, {
            ...(attempt.supplierOrderId !== null && { supplierOrderId: attempt.supplierOrderId }),
            quantity: attempt.quantity,
          }),
    callVerdict,
  );
  return attemptOutcome(
    answer.ok ? answer.value : outcomeOfOrderError(answer.error),
    secrets,
    call === 'resend',
  );
}

/** S18 PQ2: our codes of a first send refused on its quote: nothing was sent or bought. */
export const COST_ABOVE_PRICE_CODE = 'COST_ABOVE_PRICE';

/** S18 PQ1: what the quote before a first send found. */
export interface QuoteCheck {
  /** The offer's unit cost now, when the quote was read. */
  unitCostUsdUnits?: number;
  /** The attempt fails before anything is sent (PQ2): the next route is tried. */
  refusal?: AttemptOutcome;
}

/**
 * S18 PQ1, PQ2: before the first send of an automatic attempt whose adapter quotes offers, the
 * offer's cost and stock now (`get_offer`, recorded). A cost above the order's unit price, or no
 * stock, fails the attempt before anything is sent; a quote that fails or cannot be read lets the
 * order go as before. The quoted cost is kept on the attempt, while it is open (set once).
 */
export async function quoteBeforeSend(
  db: Executor,
  registry: SupplierRegistry,
  attempt: AttemptRow,
): Promise<QuoteCheck> {
  if (attempt.routeId === null || attempt.supplierOfferId === null) return {};
  const [row] = await db
    .select({ code: suppliers.code, unitPrice: orders.unitPriceUsdUnits })
    .from(suppliers)
    .innerJoin(orders, eq(orders.id, attempt.orderId))
    .where(eq(suppliers.id, attempt.supplierId));
  if (!row) return {};
  let connected: Awaited<ReturnType<SupplierRegistry['connect']>> = null;
  try {
    connected = await registry.connect(db, { id: attempt.supplierId, code: row.code });
  } catch {
    // Credentials that do not decrypt: the send gives `unknown` the same way (rule F8).
  }
  if (!connected?.adapter.capabilities.offerQuote) return {};
  const { adapter } = connected;
  const offerId = attempt.supplierOfferId;
  const read = await recordedCall(db, attempt.supplierId, 'get_offer', () =>
    adapter.getOfferQuote(offerId),
  );
  if (!read.ok || read.value.cost.currency !== 'USD') return {};
  const unitCostUsdUnits = read.value.cost.amountUnits;
  // A price the store could never use (zero, negative, above $10,000) is no quote: send as before.
  if (
    !Number.isSafeInteger(unitCostUsdUnits) ||
    unitCostUsdUnits < 1 ||
    unitCostUsdUnits > SUPPLIER_COST_MAX_USD_UNITS
  ) {
    return {};
  }
  await db
    .update(fulfilmentAttempts)
    .set({ costCheckedUsdUnits: unitCostUsdUnits })
    .where(
      and(
        eq(fulfilmentAttempts.id, attempt.id),
        inArray(fulfilmentAttempts.status, ['sending', 'pending', 'unknown']),
      ),
    );
  if (!read.value.inStock) {
    return {
      unitCostUsdUnits,
      refusal: {
        status: 'failed',
        reason: 'Out of stock at the supplier (quoted before sending)',
        supplierErrorCode: OUT_OF_STOCK_CODE,
        supplierOrderId: null,
      },
    };
  }
  if (unitCostUsdUnits > row.unitPrice) {
    return {
      unitCostUsdUnits,
      refusal: {
        status: 'failed',
        reason: 'The supplier cost is above the price paid (quoted before sending)',
        supplierErrorCode: COST_ABOVE_PRICE_CODE,
        supplierOrderId: null,
      },
    };
  }
  return { unitCostUsdUnits };
}

/**
 * S18 PQ3, in the transaction that applied the first send's answer: a quoted cost that differs
 * from the offer's stored one becomes its cost, and its products are repriced.
 */
export async function applyQuotedCost(
  tx: Transaction,
  attempt: AttemptRow,
  quote: QuoteCheck,
  context: RoutingContext,
): Promise<boolean> {
  if (quote.unitCostUsdUnits === undefined || attempt.offerId === null) return false;
  return recordObservedCost(tx, {
    offerId: attempt.offerId,
    unitCostUsdUnits: quote.unitCostUsdUnits,
    attemptId: attempt.id,
    context,
  });
}

/**
 * S18 CH2, CH3, in the transaction that applied an answer: once an automatic attempt is delivered
 * and knows what the supplier charged, a charge more than 2% off `unit cost × units delivered`
 * (`chargeCheck`) writes a `charge_mismatch`
 * note on the order and a `supplier_charge_mismatch` message (once per attempt), and the charged
 * unit cost becomes the offer's cost (PQ3): when it is above the order's unit price (`loss`), the
 * margin guard pauses what can no longer be sold. The delivered order is not touched.
 */
export async function checkCharge(
  tx: Transaction,
  applied: AppliedOutcome,
  context: RoutingContext & { jobs: JobSender },
): Promise<'ok' | 'mismatch' | 'loss' | null> {
  const { attempt, order } = applied;
  const charged = attempt.chargedUsdUnits;
  // A partial delivery is charged for what was delivered: only a delivered attempt is checked.
  if (charged === null || attempt.offerId === null || attempt.routeId === null) return null;
  if (attempt.status !== 'delivered' || attempt.deliveredQuantity < 1) return null;
  const check = chargeCheck({
    unitCostUsdUnits: attempt.unitCostUsdUnits,
    units: attempt.deliveredQuantity,
    chargedUsdUnits: charged,
  });
  if (!check.mismatch) return 'ok';
  const expected = check.expectedUsdUnits;
  const unitCharged = check.unitChargedUsdUnits;
  const loss = unitCharged > order.unitPriceUsdUnits;
  const [supplier] = await tx
    .select({ nameAr: suppliers.nameAr })
    .from(suppliers)
    .where(eq(suppliers.id, attempt.supplierId));
  const queued = await queueTelegramMessage(tx, context.jobs, {
    kind: 'supplier_charge_mismatch',
    params: {
      orderId: order.id,
      orderNumber: order.number,
      supplierNameAr: supplier?.nameAr ?? '',
      expectedUsdUnits: expected,
      chargedUsdUnits: charged,
      loss,
    },
    dedupeKey: `charge:${attempt.id}`,
  });
  // Told once: a later answer for the same attempt changes nothing more.
  if (queued === null) return loss ? 'loss' : 'mismatch';
  await addOrderEvent(tx, order.id, 'note', {
    actor: 'supplier',
    attemptId: attempt.id,
    reason: 'charge_mismatch',
    details: { expectedUsdUnits: expected, chargedUsdUnits: charged, loss },
  });
  if (unitCharged > 0) {
    await recordObservedCost(tx, {
      offerId: attempt.offerId,
      unitCostUsdUnits: unitCharged,
      attemptId: attempt.id,
      context,
    });
  }
  return loss ? 'loss' : 'mismatch';
}

/** Where a result for an attempt came from, for its conflict alert's dedupe key. */
export type ResultSource = { kind: 'webhook'; eventId: string } | { kind: 'poll' | 'supplier' };

/**
 * Rule F5 for every result that reached an attempt already closed (a webhook, a poll's or the
 * first call's late answer after a webhook or the admin's decision): the same result changes
 * nothing; another one (delivered after failed, or failed after delivered) changes no state or
 * money either, but writes a `note` on the order and an `order_conflict` alert, since the
 * supplier may have delivered goods the order no longer counts (edge case 11). A `pending` or
 * `unknown` answer tells nothing new.
 */
export async function reportLateResult(
  tx: Transaction,
  context: OrderContext,
  applied: AppliedOutcome,
  outcome: AttemptOutcome,
  source: ResultSource,
): Promise<'same_result' | 'conflict'> {
  const closed = applied.attempt.status;
  const reported =
    outcome.status === 'delivered' ? 'delivered' : outcome.status === 'failed' ? 'failed' : null;
  if (reported === null || reported === closed || (closed !== 'delivered' && closed !== 'failed')) {
    return 'same_result';
  }
  const attemptId = applied.attempt.id;
  await addOrderEvent(tx, applied.order.id, 'note', {
    actor: 'supplier',
    attemptId,
    reason: source.kind === 'webhook' ? 'webhook_conflict' : 'late_result_conflict',
    details: {
      source: source.kind,
      ...(source.kind === 'webhook' && { webhookEventId: source.eventId }),
      attemptStatus: closed,
      reported,
    },
  });
  const [supplier] = await tx
    .select({ nameAr: suppliers.nameAr })
    .from(suppliers)
    .where(eq(suppliers.id, applied.attempt.supplierId));
  await queueTelegramMessage(tx, context.jobs, {
    kind: 'order_conflict',
    params: {
      orderId: applied.order.id,
      orderNumber: applied.order.number,
      supplierNameAr: supplier?.nameAr ?? '',
      attemptStatus: closed,
      reported,
    },
    dedupeKey:
      source.kind === 'webhook'
        ? `conflict:${source.eventId}`
        : `conflict:${attemptId}:${source.kind}`,
  });
  return 'conflict';
}
