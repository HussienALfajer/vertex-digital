import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  type CandidateRoute,
  type OrdersFulfilPayload,
  orderCandidates,
  ordersFulfilPayloadSchema,
  QUEUES,
} from '@vertex-digital/contracts';
import {
  type AttemptRow,
  applyOutcome,
  type Database,
  fulfilmentAttempts,
  lockOrder,
  newId,
  type OrderRow,
  openAttempt,
  orderCodesKey,
  productRoutingStates,
  queueManualCard,
  refundRemaining,
  type Transaction,
  transitionOrder,
} from '@vertex-digital/db';
import { eq } from 'drizzle-orm';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';
import { SupplierRegistry } from '../../suppliers/supplier-registry.js';
import { askSupplier, orderContext, reportLateResult } from './order-calls.js';

type Executor = Database | Transaction;

/** What one run decided, for the logs and the tests. */
export type FulfilResult =
  | { kind: 'skipped' }
  | { kind: 'refunded'; order: OrderRow }
  | { kind: 'sent'; attempt: AttemptRow; manual: boolean };

/**
 * `orders.fulfil` (S08 rules R1–R6), one job per order (`stately`): under the order lock, acts
 * only on `paid`, `failed`, or `needs_review` with no open attempt; picks the first candidate of
 * `orderCandidates` (tiers, the margin guard against the order's minimum margin, the supplier's
 * balance, routes already tried, test customers) for the remaining units, writes the attempt and
 * `sent_to_supplier`, commits, then calls the supplier with the attempt id as the key and applies
 * the answer (rule F1). A manual attempt makes no call: it waits for the admin with its Telegram
 * card (rule MN1). No candidate: the remaining units are refunded (rule R5).
 */
@Injectable()
export class OrdersFulfilJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(OrdersFulfilJob.name);
  private readonly codesKey: Buffer;

  constructor(
    private readonly pgBoss: PgBossService,
    private readonly registry: SupplierRegistry,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.codesKey = orderCodesKey(env.ORDER_CODES_SECRET);
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work<OrdersFulfilPayload>(QUEUES.ordersFulfil, async (data) => {
      const { orderId } = ordersFulfilPayloadSchema.parse(data);
      const result = await this.fulfil(orderId);
      if (result.kind === 'refunded') {
        this.logger.log(`Order ${orderId} refunded: ${result.order.refundReason}`);
      }
    });
  }

  async fulfil(orderId: string, db: Executor = this.db): Promise<FulfilResult> {
    const now = new Date();
    const decided = await db.transaction((tx) => this.route(tx, orderId, now));
    if (decided.kind !== 'sent' || decided.manual) return decided;
    const attempt = decided.attempt;
    const outcome = await askSupplier(db, this.registry, attempt, 'place');
    const applied = await db.transaction(async (tx) => {
      const context = orderContext(this.pgBoss, this.codesKey);
      const result = await applyOutcome(tx, context, attempt.id, outcome, { by: 'supplier' });
      // Closed while the call was out (a webhook): a different answer is a conflict (rule F5).
      if (!result.applied) {
        await reportLateResult(tx, context, result, outcome, { kind: 'supplier' });
      }
      return result;
    });
    return { kind: 'sent', attempt: applied.attempt, manual: false };
  }

  /** Rules R1–R5 in one transaction: the attempt and its status, or the refund. */
  private async route(tx: Transaction, orderId: string, now: Date): Promise<FulfilResult> {
    const order = await lockOrder(tx, orderId);
    if (!order) return { kind: 'skipped' };
    const routable =
      order.status === 'paid' || order.status === 'failed' || order.status === 'needs_review';
    if (!routable || (await openAttempt(tx, orderId))) return { kind: 'skipped' };
    const remainingUnits = order.quantity - order.deliveredQuantity - order.refundedQuantity;
    if (remainingUnits <= 0) return { kind: 'skipped' };

    const context = orderContext(this.pgBoss, this.codesKey, now);
    const states = await productRoutingStates(tx, [order.productId], {
      now,
      fakeEnabled: this.env.SUPPLIER_FAKE_ENABLED,
    });
    const routes = states.get(order.productId)?.routes ?? [];
    const tried = await tx
      .select({ routeId: fulfilmentAttempts.routeId })
      .from(fulfilmentAttempts)
      .where(eq(fulfilmentAttempts.orderId, orderId));
    // S11: an `admin_fulfil` attempt has no route; it still counts as an attempt for R5's reason.
    const triedRouteIds = tried.flatMap((row) => (row.routeId ? [row.routeId] : []));
    const candidates = orderCandidates(
      routes.map(
        (route): CandidateRoute => ({
          id: route.id,
          supplierCode: route.supplierCode,
          health: route.health,
          costUsdUnits: route.costUsdUnits,
          priority: route.priority,
          unusableReason: route.unusableReason,
          balanceUsdUnits:
            route.supplier.balance?.currency === 'USD' ? route.supplier.balance.amountUnits : null,
        }),
      ),
      {
        unitPriceUsdUnits: order.unitPriceUsdUnits,
        minMarginUsdUnits: order.minMarginUsdUnits,
        remainingUnits,
        isTestCustomer: order.isTest,
        triedRouteIds,
      },
    );
    const chosen = candidates.find((candidate) => candidate.rank === 1);
    const route = chosen && routes.find((candidate) => candidate.id === chosen.routeId);
    if (!route) {
      const refunded = await refundRemaining(
        tx,
        context,
        order,
        tried.length === 0 ? 'no_route' : 'routes_exhausted',
        { actor: 'system', actorId: null },
      );
      return { kind: 'refunded', order: refunded };
    }

    const manual = route.supplierCode === 'manual';
    const id = newId();
    const [attempt] = await tx
      .insert(fulfilmentAttempts)
      .values({
        id,
        orderId,
        routeId: route.id,
        supplierId: route.supplier.id,
        offerId: route.offer.id,
        supplierOfferId: route.offer.offerId,
        fieldMap: route.fieldMap,
        quantity: remainingUnits,
        unitCostUsdUnits: route.costUsdUnits as number,
        // A manual attempt waits for the admin at once; it is never polled (rule MN2).
        status: manual ? 'pending' : 'sending',
        candidates,
        sentAt: now,
      })
      .returning();
    const moved = await transitionOrder(tx, order, 'sent_to_supplier', {
      actor: 'system',
      attemptId: id,
      details: { supplier: route.supplierCode, units: remainingUnits },
    });
    if (!moved) throw new Error(`Order ${orderId} changed under its lock`);
    if (manual) await queueManualCard(tx, context, moved, id, now);
    return { kind: 'sent', attempt: attempt as AttemptRow, manual };
  }
}
