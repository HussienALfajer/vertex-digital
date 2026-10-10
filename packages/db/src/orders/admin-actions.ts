import {
  type CandidateRoute,
  fulfilIsLoss,
  orderCandidates,
  orderDecisions,
  type RerouteOptions,
  type SupplierCode,
} from '@vertex-digital/contracts';
import { and, eq, isNotNull } from 'drizzle-orm';
import type { Database, Transaction } from '../client.js';
import { newId } from '../id.js';
import { productRoutingStates, type RouteState, type RoutingContext } from '../pricing/routing.js';
import {
  catalogGames,
  catalogProducts,
  fulfilmentAttempts,
  storedFiles,
  suppliers,
} from '../schema/index.js';
import { queueTelegramMessage } from '../telegram/index.js';
import { applyOutcome, orderAfterDelivery, postCostOfGoods, storeCodes } from './outcome.js';
import { OrderError } from './purchase.js';
import { openAttempt } from './reads.js';
import {
  type AttemptRow,
  addOrderEvent,
  lockOrder,
  type OrderContext,
  type OrderRow,
  queuePoll,
  transitionOrder,
} from './transition.js';

/*
 * The admin's actions on a held or manual order (S11 rules RR1–RR5, MF1–MF5, RF1): each locks the
 * order, then its open attempt, rechecks what it may do under the locks and writes in the
 * caller's transaction. The caller writes the audit entry; its `Idempotency-Key` is kept on the
 * attempt the action closed (reroute) or delivered (manual fulfil).
 */

type Executor = Database | Transaction;

/** The admin deciding, with the reason and the request's key. */
export interface AdminDecision {
  id: string;
  reason: string;
  idempotencyKey: string;
}

/** `failure_reason` of an attempt the admin closed for a reroute, a manual fulfil, a refund. */
export const ADMIN_CLOSE_REASONS = {
  reroute: 'Rerouted by the admin',
  fulfil: 'Fulfilled manually by the admin',
  refund: 'Refunded by the admin',
} as const;

export type AdminCloseKind = keyof typeof ADMIN_CLOSE_REASONS;

/**
 * Closes an open attempt `failed` by the admin, without routing the rest (S08 D5, S11 RR3, MF5,
 * RF1): never `input_rejected`. The caller holds the order lock.
 */
export async function closeAttemptByAdmin(
  tx: Transaction,
  orderId: string,
  attemptId: string,
  kind: AdminCloseKind,
  admin: { id: string; reason: string; idempotencyKey: string | null },
  now: Date,
): Promise<void> {
  await tx
    .update(fulfilmentAttempts)
    .set({
      status: 'failed',
      nextPollAt: null,
      failureReason: ADMIN_CLOSE_REASONS[kind],
      resolvedAt: now,
      resolvedBy: 'admin',
      adminReason: admin.reason,
      decisionIdempotencyKey: admin.idempotencyKey,
      result: { status: 'failed', inputRejected: false },
    })
    .where(eq(fulfilmentAttempts.id, attemptId));
  await addOrderEvent(tx, orderId, 'attempt', {
    actor: 'admin',
    actorId: admin.id,
    attemptId,
    reason: `admin_${kind}`,
    details: { status: 'failed' },
  });
}

/** The order and its open attempt, both locked (the order first), with what may be decided. */
async function lockDecidable(tx: Transaction, orderId: string) {
  const order = await lockOrder(tx, orderId);
  if (!order) throw new OrderError('NOT_FOUND', 'No such order');
  const open = await openAttempt(tx, orderId);
  if (open) {
    await tx
      .select({ id: fulfilmentAttempts.id })
      .from(fulfilmentAttempts)
      .where(eq(fulfilmentAttempts.id, open.attempt.id))
      .for('update');
  }
  const decisions = orderDecisions(
    order.status,
    open ? { id: open.attempt.id, supplierCode: open.supplierCode } : null,
  );
  return { order, open, decisions };
}

const remainingUnits = (order: OrderRow) =>
  order.quantity - order.deliveredQuantity - order.refundedQuantity;

/**
 * Rule RR2's facts: the order's product's unarchived routes and how the router judges each for the
 * order's remaining units (S08 R2, R4), every route it already tried counted, the open one too.
 */
async function judgedRoutes(db: Executor, order: OrderRow, context: RoutingContext) {
  const [states, tried] = await Promise.all([
    productRoutingStates(db, [order.productId], context),
    db
      .select({ routeId: fulfilmentAttempts.routeId })
      .from(fulfilmentAttempts)
      .where(and(eq(fulfilmentAttempts.orderId, order.id), isNotNull(fulfilmentAttempts.routeId))),
  ]);
  const routes = (states.get(order.productId)?.routes ?? []).filter(
    (route) => route.archivedAt === null,
  );
  const remaining = remainingUnits(order);
  const candidates = orderCandidates(routes.map(candidateRoute), {
    unitPriceUsdUnits: order.unitPriceUsdUnits,
    minMarginUsdUnits: order.minMarginUsdUnits,
    remainingUnits: remaining,
    isTestCustomer: order.isTest,
    triedRouteIds: tried.map((row) => row.routeId as string),
  });
  return { remaining, candidates, routeOf: new Map(routes.map((route) => [route.id, route])) };
}

/** Rule RR2: every unarchived route with its eligibility for the order now. */
export async function rerouteOptions(
  db: Executor,
  order: OrderRow,
  context: RoutingContext,
): Promise<RerouteOptions> {
  const { remaining, candidates, routeOf } = await judgedRoutes(db, order, context);
  return {
    orderId: order.id,
    remainingUnits: remaining,
    unitPriceUsdUnits: order.unitPriceUsdUnits,
    minMarginUsdUnits: order.minMarginUsdUnits,
    routes: candidates.map((candidate) => {
      const route = routeOf.get(candidate.routeId) as RouteState;
      const balance = route.supplier.balance;
      const usd = route.supplierCode !== 'manual' && balance?.currency === 'USD';
      return {
        routeId: route.id,
        supplierCode: route.supplierCode,
        supplierNameAr: route.supplier.nameAr,
        health: route.health,
        balanceUsdUnits: usd ? (balance?.amountUnits ?? null) : null,
        balanceAt: usd ? (balance?.createdAt.toISOString() ?? null) : null,
        offerId: route.offer.offerId,
        offerName: route.offer.name,
        tier: candidate.tier,
        unitCostUsdUnits: route.costUsdUnits,
        marginUsdUnits:
          route.costUsdUnits === null ? null : order.unitPriceUsdUnits - route.costUsdUnits,
        eligible: candidate.rank !== null,
        skipReason: candidate.skipReason,
      };
    }),
  };
}

/** What the router reads of a route (S08 R2): its USD balance only. */
function candidateRoute(route: RouteState): CandidateRoute {
  return {
    id: route.id,
    supplierCode: route.supplierCode,
    health: route.health,
    costUsdUnits: route.costUsdUnits,
    priority: route.priority,
    unusableReason: route.unusableReason,
    balanceUsdUnits:
      route.supplier.balance?.currency === 'USD' ? route.supplier.balance.amountUnits : null,
  };
}

/** Rule MN1: the manual order's Telegram card for the admin; never field values or codes. */
export async function queueManualCard(
  tx: Transaction,
  context: Pick<OrderContext, 'jobs'>,
  order: OrderRow,
  attemptId: string,
  sentAt: Date,
): Promise<void> {
  const [names] = await tx
    .select({ productNameAr: catalogProducts.nameAr, gameNameAr: catalogGames.nameAr })
    .from(catalogProducts)
    .innerJoin(catalogGames, eq(catalogGames.id, catalogProducts.gameId))
    .where(eq(catalogProducts.id, order.productId));
  await queueTelegramMessage(tx, context.jobs, {
    kind: 'manual_order',
    params: {
      orderId: order.id,
      orderNumber: order.number,
      gameNameAr: names?.gameNameAr ?? '',
      productNameAr: names?.productNameAr ?? '',
      quantity: remainingUnits(order),
      sentAt: sentAt.toISOString(),
    },
    dedupeKey: `manual:${attemptId}`,
  });
}

export interface RerouteResult {
  order: OrderRow;
  closedAttemptId: string;
  attempt: AttemptRow;
  supplierCode: SupplierCode;
}

/**
 * Rule RR3: closes the open attempt and sends the remaining units to the route the admin chose,
 * rechecked under the locks (`ROUTE_NOT_ELIGIBLE` with its reason). An automatic route's attempt
 * is written `sending` and its poll queued at once (the poll sends it with its key, S08 F3); a
 * manual one waits `pending` with its Telegram card. No money moves (MF-M2).
 */
export async function rerouteOrder(
  tx: Transaction,
  context: OrderContext & { routing: RoutingContext },
  input: { orderId: string; routeId: string; admin: AdminDecision },
): Promise<RerouteResult> {
  const { order, open, decisions } = await lockDecidable(tx, input.orderId);
  if (!decisions.reroute || !open) {
    throw new OrderError('ORDER_NOT_DECIDABLE', 'The order cannot be rerouted now');
  }
  const { remaining, candidates, routeOf } = await judgedRoutes(tx, order, context.routing);
  const chosen = candidates.find((candidate) => candidate.routeId === input.routeId);
  const route = routeOf.get(input.routeId);
  if (!chosen || chosen.rank === null || !route || route.costUsdUnits === null) {
    throw new OrderError('ROUTE_NOT_ELIGIBLE', 'The route cannot take this order now', {
      reason: chosen?.skipReason ?? 'archived',
    });
  }

  const { admin } = input;
  const { now } = context;
  await closeAttemptByAdmin(tx, order.id, open.attempt.id, 'reroute', admin, now);
  const event = { actor: 'admin' as const, actorId: admin.id, reason: 'admin_reroute' };
  let current = order;
  if (current.status === 'sent_to_supplier') {
    current = (await transitionOrder(tx, current, 'failed', event)) as OrderRow;
  }
  const manual = route.supplierCode === 'manual';
  const attemptId = newId();
  const [attempt] = await tx
    .insert(fulfilmentAttempts)
    .values({
      id: attemptId,
      orderId: order.id,
      routeId: route.id,
      supplierId: route.supplier.id,
      offerId: route.offer.id,
      supplierOfferId: route.offer.offerId,
      fieldMap: route.fieldMap,
      quantity: remaining,
      unitCostUsdUnits: route.costUsdUnits,
      status: manual ? 'pending' : 'sending',
      candidates,
      chosenByAdmin: true,
      sentAt: now,
    })
    .returning();
  const moved = await transitionOrder(tx, current, 'sent_to_supplier', {
    ...event,
    attemptId,
    details: { supplier: route.supplierCode, units: remaining },
  });
  if (!moved) throw new Error(`Order ${order.id} changed under its lock`);
  if (manual) await queueManualCard(tx, context, moved, attemptId, now);
  else await queuePoll(tx, context.jobs, attemptId, now);
  return {
    order: moved,
    closedAttemptId: open.attempt.id,
    attempt: attempt as AttemptRow,
    supplierCode: route.supplierCode,
  };
}

export interface ManualFulfilInput {
  orderId: string;
  quantity: number;
  codes: readonly string[];
  unitCostUsdUnits: number;
  acceptLoss: boolean;
  proofFileId: string;
  reference: string | null;
  admin: AdminDecision;
}

export interface ManualFulfilResult {
  order: OrderRow;
  attemptId: string;
  /** The open manual attempt delivered, or an order held for review fulfilled elsewhere. */
  case: 'manual_attempt' | 'review';
  lossAccepted: boolean;
}

/**
 * Rules MF1–MF5: the admin delivered `quantity` units from another source, with a proof and the
 * actual unit cost. An open manual attempt takes the cost, proof and reference and is delivered
 * (S08 F1); an order in `needs_review` has its open attempt closed and an `admin_fulfil` attempt
 * inserted delivered. The cost of goods is posted when above zero (MF-M1); the rest of the units
 * follow S08 (routed again or refunded).
 */
export async function fulfilOrderManually(
  tx: Transaction,
  context: OrderContext,
  input: ManualFulfilInput,
): Promise<ManualFulfilResult> {
  const { order, open, decisions } = await lockDecidable(tx, input.orderId);
  if (!decisions.fulfil) {
    throw new OrderError('ORDER_NOT_DECIDABLE', 'The order cannot be fulfilled manually now');
  }
  const manualAttempt = open?.supplierCode === 'manual' ? open.attempt : null;
  const max = manualAttempt ? manualAttempt.quantity : remainingUnits(order);
  if (input.quantity > max) {
    throw new OrderError('VALIDATION_FAILED', `At most ${max} units were asked`, [
      { path: ['quantity'], message: `Expected at most ${max}` },
    ]);
  }
  if (input.codes.length !== (order.kind === 'code' ? input.quantity : 0)) {
    throw new OrderError('CODES_COUNT_MISMATCH', 'Expected one code per unit delivered');
  }
  const loss = fulfilIsLoss(input.unitCostUsdUnits, order.unitPriceUsdUnits);
  if (loss && !input.acceptLoss) {
    throw new OrderError('LOSS_NOT_CONFIRMED', 'The cost is above the price paid', {
      unitCostUsdUnits: input.unitCostUsdUnits,
      unitPriceUsdUnits: order.unitPriceUsdUnits,
    });
  }
  const [proof] = await tx
    .select({ id: storedFiles.id, usedBy: fulfilmentAttempts.id })
    .from(storedFiles)
    .leftJoin(fulfilmentAttempts, eq(fulfilmentAttempts.proofFileId, storedFiles.id))
    .where(and(eq(storedFiles.id, input.proofFileId), eq(storedFiles.kind, 'delivery_proof')));
  if (!proof || proof.usedBy !== null) {
    throw new OrderError('PROOF_INVALID', 'The delivery proof is missing or already used');
  }
  const { admin } = input;
  const resolution = { by: 'admin' as const, admin };

  if (manualAttempt) {
    await tx
      .update(fulfilmentAttempts)
      .set({
        unitCostUsdUnits: input.unitCostUsdUnits,
        proofFileId: input.proofFileId,
        deliveryReference: input.reference,
      })
      .where(eq(fulfilmentAttempts.id, manualAttempt.id));
    const applied = await applyOutcome(
      tx,
      context,
      manualAttempt.id,
      { status: 'delivered', quantity: input.quantity, codes: input.codes },
      resolution,
    );
    return {
      order: applied.order,
      attemptId: manualAttempt.id,
      case: 'manual_attempt',
      lossAccepted: loss,
    };
  }

  if (open)
    await closeAttemptByAdmin(
      tx,
      order.id,
      open.attempt.id,
      'fulfil',
      {
        ...admin,
        idempotencyKey: null,
      },
      context.now,
    );
  const [manualSupplier] = await tx
    .select({ id: suppliers.id })
    .from(suppliers)
    .where(eq(suppliers.code, 'manual'));
  if (!manualSupplier) throw new Error('The manual supplier is not seeded');
  const attemptId = newId();
  const journalId = await postCostOfGoods(tx, order.id, attemptId, {
    supplierCode: 'manual',
    unitCostUsdUnits: input.unitCostUsdUnits,
    units: input.quantity,
    adminId: admin.id,
  });
  await tx.insert(fulfilmentAttempts).values({
    id: attemptId,
    orderId: order.id,
    kind: 'admin_fulfil',
    supplierId: manualSupplier.id,
    quantity: input.quantity,
    unitCostUsdUnits: input.unitCostUsdUnits,
    status: 'delivered',
    deliveredQuantity: input.quantity,
    candidates: [],
    result: { status: 'delivered', quantity: input.quantity, codeCount: input.codes.length },
    resolvedAt: context.now,
    resolvedBy: 'admin',
    adminReason: admin.reason,
    decisionIdempotencyKey: admin.idempotencyKey,
    costJournalId: journalId,
    proofFileId: input.proofFileId,
    deliveryReference: input.reference,
  });
  await storeCodes(tx, context, order.id, attemptId, input.codes);
  const event = { actor: 'admin' as const, actorId: admin.id, attemptId };
  await addOrderEvent(tx, order.id, 'attempt', {
    ...event,
    reason: 'admin_fulfil',
    details: { status: 'delivered', units: input.quantity },
  });
  const changed = await orderAfterDelivery(tx, context, order, input.quantity, event);
  return { order: changed, attemptId, case: 'review', lossAccepted: loss };
}

/**
 * Rule RF1 (S08 D5 extended): an order in `needs_review`, or with an open manual attempt, is
 * refunded by the admin: the open attempt closed, the order through `failed` when it was with the
 * supplier, then its remaining units refunded (M3) without another route. The caller refunds and
 * audits; this answers the order ready for `refundRemaining`.
 */
export async function closeForAdminRefund(
  tx: Transaction,
  orderId: string,
  admin: { id: string; reason: string },
  now: Date,
): Promise<{ order: OrderRow; closedAttemptId: string | null }> {
  const { order, open, decisions } = await lockDecidable(tx, orderId);
  if (!decisions.refund)
    throw new OrderError('ORDER_NOT_DECIDABLE', 'The order cannot be refunded');
  if (!open) return { order, closedAttemptId: null };
  await closeAttemptByAdmin(
    tx,
    order.id,
    open.attempt.id,
    'refund',
    {
      ...admin,
      idempotencyKey: null,
    },
    now,
  );
  const changed =
    order.status === 'sent_to_supplier'
      ? ((await transitionOrder(tx, order, 'failed', {
          actor: 'admin',
          actorId: admin.id,
          reason: 'admin_refund',
        })) as OrderRow)
      : order;
  return { order: changed, closedAttemptId: open.attempt.id };
}
