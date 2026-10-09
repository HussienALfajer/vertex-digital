import { Inject, Injectable } from '@nestjs/common';
import {
  type AdminOrder,
  type AdminOrderCounts,
  type AdminOrderListQuery,
  type AdminOrderPage,
  type AdminRevealedCode,
  type OrderPolicy,
  orderDecisions,
  QUEUES,
  type resolveAttemptSchema,
} from '@vertex-digital/contracts';
import {
  addOrderEvent,
  adminOrder,
  adminOrderCounts,
  adminOrderPage,
  applyOutcome,
  currentOrderPolicy,
  type Database,
  fulfilmentAttempts,
  lockOrder,
  newId,
  type OrderRow,
  openAttempt,
  orderCodesKey,
  orderPolicy,
  orders,
  recordAudit,
  refundRemaining,
  revealCode,
  type Transaction,
} from '@vertex-digital/db';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import { isUniqueViolation } from '../../core/database/unique-violation.js';
import type { RequestMeta } from '../../core/http/request-meta.js';
import { JobsService } from '../../core/jobs/index.js';
import { asCodedException, orderRefusals } from './order-errors.js';

const isUuid = (value: string) => z.uuid().safeParse(value).success;

type ResolveBody = z.output<typeof resolveAttemptSchema>;

/** The admin and the request a decision comes from, for its audit entry. */
export interface DecisionActor {
  adminId: string;
  meta: RequestMeta;
}

/**
 * The admin's view of orders and decisions (S08 rules D1–D6, C3): each decision locks the order,
 * then its attempt, in one transaction with its event and audit entry, so it and a late supplier
 * result apply one after the other (edge case 12). Resolving and refunding take an
 * `Idempotency-Key`: the same key returns the order as the first decision left it.
 */
@Injectable()
export class OrderDecisionsService {
  private readonly codesKey: Buffer;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) env: Env,
    private readonly jobs: JobsService,
  ) {
    this.codesKey = orderCodesKey(env.ORDER_CODES_SECRET as string);
  }

  async list(query: AdminOrderListQuery): Promise<AdminOrderPage> {
    const page = await adminOrderPage(this.db, query);
    return { ...page, page: query.page, pageSize: query.pageSize };
  }

  counts(): Promise<AdminOrderCounts> {
    return adminOrderCounts(this.db);
  }

  async order(id: string): Promise<AdminOrder> {
    const order = isUuid(id) ? await adminOrder(this.db, id) : null;
    if (!order) throw orderRefusals.notFound();
    return order;
  }

  private context() {
    return { jobs: this.jobs, codesKey: this.codesKey, now: new Date() };
  }

  /** The order locked, and its open attempt when it is `attemptId`; refusals otherwise. */
  private async lockFor(tx: Transaction, orderId: string, attemptId: string) {
    const order = isUuid(orderId) ? await lockOrder(tx, orderId) : null;
    if (!order) throw orderRefusals.notFound();
    const [attempt] = isUuid(attemptId)
      ? await tx
          .select()
          .from(fulfilmentAttempts)
          .where(and(eq(fulfilmentAttempts.id, attemptId), eq(fulfilmentAttempts.orderId, orderId)))
      : [];
    if (!attempt) throw orderRefusals.notFound();
    const open = await openAttempt(tx, orderId);
    const decisions = orderDecisions(
      order.status,
      open ? { id: open.attempt.id, supplierCode: open.supplierCode } : null,
    );
    return { order, attempt, decisions };
  }

  /** Rule D4: asks the supplier again now; nothing changes until a result comes. */
  async poll(
    actor: DecisionActor,
    orderId: string,
    attemptId: string,
    reason: string,
  ): Promise<AdminOrder> {
    await this.db.transaction(async (tx) => {
      const { order, decisions } = await this.lockFor(tx, orderId, attemptId);
      if (!decisions.poll || decisions.attemptId !== attemptId) throw orderRefusals.notResolvable();
      // Its own key: a poll already queued for later must not swallow this one (F3 is safe twice).
      await this.jobs.send(
        tx,
        QUEUES.ordersPoll,
        { attemptId },
        { singletonKey: `admin:${attemptId}`, retryLimit: 3, retryDelay: 10, retryBackoff: true },
      );
      await addOrderEvent(tx, order.id, 'note', {
        actor: 'admin',
        actorId: actor.adminId,
        attemptId,
        reason: 'poll_requested',
      });
      await recordAudit(tx, {
        action: 'order.poll_requested',
        actorKind: 'admin',
        actorId: actor.adminId,
        channel: 'admin',
        entityType: 'order',
        entityId: order.id,
        reason,
        details: { attemptId },
        ...actor.meta,
      });
    });
    return this.order(orderId);
  }

  /**
   * Rules D2, D3: confirms an open attempt delivered (the units, and one code per unit for a code
   * product) or failed; applied as the supplier's result would be (rule F1), by the admin.
   */
  async resolve(
    actor: DecisionActor,
    orderId: string,
    attemptId: string,
    idempotencyKey: string,
    body: ResolveBody,
  ): Promise<{ order: AdminOrder; created: boolean }> {
    if (await this.replayedResolve(orderId, attemptId, idempotencyKey)) {
      return { order: await this.order(orderId), created: false };
    }
    try {
      const created = await this.db.transaction(async (tx) => {
        const { order, attempt, decisions } = await this.lockFor(tx, orderId, attemptId);
        // The same key waited on the lock behind its first request: a replay.
        if (attempt.decisionIdempotencyKey === idempotencyKey) return false;
        if (!decisions.resolve || decisions.attemptId !== attemptId) {
          throw orderRefusals.notResolvable();
        }
        if (body.outcome === 'delivered') {
          if (body.quantity > attempt.quantity) throw orderRefusals.tooManyUnits(attempt.quantity);
          const expected = order.kind === 'code' ? body.quantity : 0;
          if (body.codes.length !== expected) throw orderRefusals.codesCount();
        }
        await applyOutcome(
          tx,
          this.context(),
          attemptId,
          body.outcome === 'delivered'
            ? { status: 'delivered', quantity: body.quantity, codes: body.codes }
            : { status: 'failed', reason: 'Confirmed failed by the admin' },
          { by: 'admin', admin: { id: actor.adminId, reason: body.reason, idempotencyKey } },
        );
        await recordAudit(tx, {
          action: 'order.attempt_resolved',
          actorKind: 'admin',
          actorId: actor.adminId,
          channel: 'admin',
          entityType: 'order',
          entityId: order.id,
          reason: body.reason,
          details: {
            attemptId,
            outcome: body.outcome,
            units: body.outcome === 'delivered' ? body.quantity : 0,
            items: body.outcome === 'delivered' ? body.codes.length : 0,
          },
          ...actor.meta,
        });
        return true;
      });
      return { order: await this.order(orderId), created };
    } catch (error) {
      // The same key committed first in parallel: answer as its replay.
      if (
        isUniqueViolation(error) &&
        (await this.replayedResolve(orderId, attemptId, idempotencyKey))
      ) {
        return { order: await this.order(orderId), created: false };
      }
      throw asCodedException(error);
    }
  }

  /** True when the key already resolved this attempt; refused when it was used elsewhere. */
  private async replayedResolve(orderId: string, attemptId: string, key: string): Promise<boolean> {
    const [[attempt], [order]] = await Promise.all([
      this.db
        .select({ id: fulfilmentAttempts.id, orderId: fulfilmentAttempts.orderId })
        .from(fulfilmentAttempts)
        .where(eq(fulfilmentAttempts.decisionIdempotencyKey, key)),
      this.db.select({ id: orders.id }).from(orders).where(eq(orders.refundIdempotencyKey, key)),
    ]);
    if (order) throw orderRefusals.keyReused();
    if (!attempt) return false;
    if (attempt.id !== attemptId || attempt.orderId !== orderId) throw orderRefusals.keyReused();
    return true;
  }

  /**
   * Rule D5: an order in `needs_review` is refunded: its open attempt closed `failed` by the admin
   * and the remaining units returned to the wallet, without another route.
   */
  async refund(
    actor: DecisionActor,
    orderId: string,
    idempotencyKey: string,
    reason: string,
  ): Promise<{ order: AdminOrder; created: boolean }> {
    if (await this.replayedRefund(orderId, idempotencyKey)) {
      return { order: await this.order(orderId), created: false };
    }
    try {
      const created = await this.db.transaction(async (tx) => {
        const order = isUuid(orderId) ? await lockOrder(tx, orderId) : null;
        if (!order) throw orderRefusals.notFound();
        // The same key waited on the lock behind its first request: a replay.
        if (order.refundIdempotencyKey === idempotencyKey) return false;
        if (order.status !== 'needs_review') throw orderRefusals.notDecidable();
        const open = await openAttempt(tx, orderId);
        if (open) await this.closeForRefund(tx, actor, order, open.attempt.id, reason);
        const units = order.quantity - order.deliveredQuantity - order.refundedQuantity;
        const refunded = await refundRemaining(tx, this.context(), order, 'admin', {
          actor: 'admin',
          actorId: actor.adminId,
          reason,
          idempotencyKey,
        });
        await recordAudit(tx, {
          action: 'order.refund_decided',
          actorKind: 'admin',
          actorId: actor.adminId,
          channel: 'admin',
          entityType: 'order',
          entityId: order.id,
          reason,
          details: {
            attemptId: open?.attempt.id ?? null,
            units,
            amountUsdUnits: refunded.refundedUsdUnits,
          },
          ...actor.meta,
        });
        return true;
      });
      return { order: await this.order(orderId), created };
    } catch (error) {
      if (isUniqueViolation(error) && (await this.replayedRefund(orderId, idempotencyKey))) {
        return { order: await this.order(orderId), created: false };
      }
      throw asCodedException(error);
    }
  }

  private async replayedRefund(orderId: string, key: string): Promise<boolean> {
    const [[order], [attempt]] = await Promise.all([
      this.db.select({ id: orders.id }).from(orders).where(eq(orders.refundIdempotencyKey, key)),
      this.db
        .select({ id: fulfilmentAttempts.id })
        .from(fulfilmentAttempts)
        .where(eq(fulfilmentAttempts.decisionIdempotencyKey, key)),
    ]);
    if (attempt) throw orderRefusals.keyReused();
    if (!order) return false;
    if (order.id !== orderId) throw orderRefusals.keyReused();
    return true;
  }

  /** The open attempt closed `failed` by the admin, without routing the rest (rule D5). */
  private async closeForRefund(
    tx: Transaction,
    actor: DecisionActor,
    order: OrderRow,
    attemptId: string,
    reason: string,
  ) {
    await tx
      .update(fulfilmentAttempts)
      .set({
        status: 'failed',
        nextPollAt: null,
        failureReason: 'Refunded by the admin',
        resolvedAt: new Date(),
        resolvedBy: 'admin',
        adminReason: reason,
        result: { status: 'failed', inputRejected: false },
      })
      .where(eq(fulfilmentAttempts.id, attemptId));
    await addOrderEvent(tx, order.id, 'attempt', {
      actor: 'admin',
      actorId: actor.adminId,
      attemptId,
      reason: 'admin_refund',
      details: { status: 'failed' },
    });
  }

  /** Rule C3: one code shown to the admin, the reveal logged and audited (never its value). */
  async reveal(actor: DecisionActor, orderId: string, codeId: string): Promise<AdminRevealedCode> {
    if (!isUuid(orderId) || !isUuid(codeId)) throw orderRefusals.notFound();
    const code = await this.db.transaction(async (tx) => {
      const revealed = await revealCode(tx, this.codesKey, {
        orderId,
        codeId,
        customerId: null,
        actor: 'admin',
        actorId: actor.adminId,
        ...actor.meta,
      });
      if (!revealed) throw orderRefusals.notFound();
      await recordAudit(tx, {
        action: 'order.code_revealed',
        actorKind: 'admin',
        actorId: actor.adminId,
        channel: 'admin',
        entityType: 'order',
        entityId: orderId,
        details: { itemId: codeId, position: revealed.position },
        ...actor.meta,
      });
      return revealed.code;
    });
    return { code };
  }

  policy(): Promise<OrderPolicy> {
    return currentOrderPolicy(this.db);
  }

  /** A new policy row, in force at once, with its audit entry (before and after). */
  async setPolicy(actor: DecisionActor, policy: OrderPolicy): Promise<OrderPolicy> {
    return this.db.transaction(async (tx) => {
      const before = await currentOrderPolicy(tx);
      const id = newId();
      await tx.insert(orderPolicy).values({ id, ...policy, adminId: actor.adminId });
      await recordAudit(tx, {
        action: 'order_policy.set',
        actorKind: 'admin',
        actorId: actor.adminId,
        channel: 'admin',
        entityType: 'order_policy',
        entityId: id,
        details: { before, after: policy },
        ...actor.meta,
      });
      return policy;
    });
  }
}
