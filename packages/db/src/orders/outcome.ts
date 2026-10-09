import {
  type AttemptResolver,
  type AuditChannel,
  codeHint,
  costOfGoods,
  firstPollAt,
  isOpenAttempt,
  nextPollAt,
  type OrderEventActor,
  type RefundReason,
  refundAmount,
} from '@vertex-digital/contracts';
import { desc, eq } from 'drizzle-orm';
import { recordAudit } from '../audit/index.js';
import type { Transaction } from '../client.js';
import { newId } from '../id.js';
import { ensureCustomerWallet, ensureSystemAccount, postJournal } from '../ledger/index.js';
import { notifyCustomer } from '../notifications/index.js';
import {
  catalogProducts,
  fulfilmentAttempts,
  orderCodes,
  orders,
  suppliers,
} from '../schema/index.js';
import { encryptSecret } from './secrets.js';
import {
  type AttemptRow,
  addOrderEvent,
  currentOrderPolicy,
  lockOrder,
  type OrderContext,
  type OrderRow,
  queueFulfil,
  queuePoll,
  transitionOrder,
} from './transition.js';

/*
 * Applying a supplier's (or the admin's) result to an attempt, and refunding what could not be
 * delivered (S08 rules F1, F2, M2, M3). Both lock the order, then the attempt, `FOR UPDATE`, so a
 * webhook, a poll and an admin decision on one attempt apply one after the other; only an open
 * attempt takes a result.
 */

/** A classified result (ADR 0004), as an adapter or the admin gives it. Never logged. */
export type AttemptOutcome =
  | {
      status: 'delivered';
      quantity: number;
      /** One per unit for a code product; kept encrypted, never in `result`. */
      codes?: readonly string[];
      supplierOrderId?: string | null;
    }
  | { status: 'pending'; supplierOrderId?: string | null }
  | {
      status: 'failed';
      reason: string;
      inputRejected?: boolean;
      supplierErrorCode?: string | null;
      supplierOrderId?: string | null;
    }
  | { status: 'unknown'; reason: string; supplierOrderId?: string | null };

/** Who applies the result; an admin decision carries its reason and key (rules D2, D3). */
export interface Resolution {
  by: AttemptResolver;
  admin?: { id: string; reason: string; idempotencyKey: string | null };
}

export interface AppliedOutcome {
  /** False when the attempt was already closed: nothing changed (rule F5 then compares). */
  applied: boolean;
  order: OrderRow;
  attempt: AttemptRow;
}

const clip = (text: string | null | undefined, max: number): string | null =>
  text ? text.slice(0, max) : null;

const eventActor = (resolution: Resolution): OrderEventActor =>
  resolution.by === 'admin' ? 'admin' : 'supplier';

/** The attempt, locked after its order (the order lock first, always). */
async function lockAttempt(
  tx: Transaction,
  attemptId: string,
): Promise<{ order: OrderRow; attempt: AttemptRow } | null> {
  const [found] = await tx
    .select({ orderId: fulfilmentAttempts.orderId })
    .from(fulfilmentAttempts)
    .where(eq(fulfilmentAttempts.id, attemptId));
  if (!found) return null;
  const order = await lockOrder(tx, found.orderId);
  const [attempt] = await tx
    .select()
    .from(fulfilmentAttempts)
    .where(eq(fulfilmentAttempts.id, attemptId))
    .for('update');
  if (!order || !attempt) return null;
  return { order, attempt };
}

/**
 * Rules F1 and F2: applies the outcome to an open attempt.
 * - `delivered` with `q` units: a code product needs exactly `q` codes (else it is `unknown`,
 *   `codes_missing`); codes stored encrypted, the cost of goods posted (M2), the order
 *   `delivered` when every unit is, else `failed` (or held in `needs_review`) and routed again.
 * - `pending`: the first poll scheduled (an automatic attempt).
 * - `failed`: the next route by `orders.fulfil`, or with `inputRejected` the remaining units
 *   refunded at once (no route would take the same account).
 * - `unknown`: the next poll scheduled; never another route (ADR 0004).
 */
export async function applyOutcome(
  tx: Transaction,
  context: OrderContext,
  attemptId: string,
  received: AttemptOutcome,
  resolution: Resolution,
): Promise<AppliedOutcome> {
  const locked = await lockAttempt(tx, attemptId);
  if (!locked) throw new Error(`Attempt ${attemptId} does not exist`);
  const { order, attempt } = locked;
  if (!isOpenAttempt(attempt.status)) return { applied: false, order, attempt };

  const [supplier] = await tx
    .select({ code: suppliers.code })
    .from(suppliers)
    .where(eq(suppliers.id, attempt.supplierId));
  if (!supplier) throw new Error(`Attempt ${attemptId} names no supplier`);
  const supplierCode = supplier.code;
  let outcome = received;
  if (outcome.status === 'delivered') {
    const { quantity, codes = [] } = outcome;
    const units = Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= attempt.quantity;
    if (!units) {
      outcome = { status: 'unknown', reason: 'quantity_invalid' };
    } else if (order.kind === 'code' ? codes.length !== quantity : codes.length > 0) {
      outcome = { status: 'unknown', reason: 'codes_missing' };
    }
  }

  const admin = resolution.admin;
  const event = { actor: eventActor(resolution), actorId: admin?.id ?? null, attemptId };
  const supplierOrderId = clip(outcome.supplierOrderId, 128) ?? attempt.supplierOrderId;
  const closing = {
    resolvedAt: context.now,
    resolvedBy: resolution.by,
    adminReason: admin?.reason ?? null,
    decisionIdempotencyKey: admin?.idempotencyKey ?? null,
  };

  switch (outcome.status) {
    case 'delivered': {
      const units = outcome.quantity;
      for (const [index, code] of (outcome.codes ?? []).entries()) {
        const id = newId();
        await tx.insert(orderCodes).values({
          id,
          orderId: order.id,
          attemptId,
          position: index + 1,
          ciphertext: encryptSecret(context.codesKey, id, code),
          hint: codeHint(code),
        });
      }
      const cost = costOfGoods(attempt.unitCostUsdUnits, units);
      const journal = await postJournal(tx, {
        idempotencyKey: `order:${order.id}:cost:${attemptId}`,
        kind: 'cost_of_goods',
        postings: [
          {
            accountId: await ensureSystemAccount(tx, {
              code: 'cost_of_goods:USD',
              kind: 'cost_of_goods',
              currency: 'USD',
            }),
            amountUnits: cost,
          },
          {
            accountId: await ensureSystemAccount(tx, {
              code: `supplier_prepaid:${supplierCode}`,
              kind: 'supplier_prepaid',
              currency: 'USD',
            }),
            amountUnits: -cost,
          },
        ],
      });
      const [closed] = await tx
        .update(fulfilmentAttempts)
        .set({
          ...closing,
          status: 'delivered',
          deliveredQuantity: units,
          supplierOrderId,
          nextPollAt: null,
          costJournalId: journal.journalId,
          result: { status: 'delivered', quantity: units, codeCount: outcome.codes?.length ?? 0 },
        })
        .where(eq(fulfilmentAttempts.id, attemptId))
        .returning();
      await addOrderEvent(tx, order.id, 'attempt', {
        ...event,
        details: { status: 'delivered', units },
      });
      await recordAudit(tx, {
        action: 'order.cost_posted',
        actorKind: admin ? 'admin' : 'system',
        actorId: admin?.id ?? null,
        channel: admin ? 'admin' : 'worker',
        entityType: 'order',
        entityId: order.id,
        details: {
          supplier: supplierCode,
          attemptId,
          units,
          costUsdUnits: cost,
          journalId: journal.journalId,
        },
      });
      const delivered = order.deliveredQuantity + units;
      let changed: OrderRow;
      if (delivered === order.quantity) {
        // The order's own notification first: a checkout's summary follows it (S10 CT7).
        await notifyDelivered(tx, context, order);
        changed = (await transitionOrder(
          tx,
          order,
          'delivered',
          event,
          { deliveredQuantity: delivered },
          context.jobs,
        )) as OrderRow;
      } else {
        // Partial delivery (ADR 0004): the rest goes to the next route, or is refunded.
        changed =
          order.status === 'sent_to_supplier'
            ? ((await transitionOrder(
                tx,
                order,
                'failed',
                { ...event, reason: 'partial' },
                {
                  deliveredQuantity: delivered,
                },
              )) as OrderRow)
            : ((
                await tx
                  .update(orders)
                  .set({ deliveredQuantity: delivered })
                  .where(eq(orders.id, order.id))
                  .returning()
              )[0] as OrderRow);
        await queueFulfil(tx, context.jobs, order.id);
      }
      return { applied: true, order: changed, attempt: closed as AttemptRow };
    }
    case 'failed': {
      const inputRejected = outcome.inputRejected === true;
      const [closed] = await tx
        .update(fulfilmentAttempts)
        .set({
          ...closing,
          status: 'failed',
          supplierOrderId,
          nextPollAt: null,
          failureReason: clip(outcome.reason, 200),
          inputRejected,
          supplierErrorCode: clip(outcome.supplierErrorCode, 64),
          result: { status: 'failed', inputRejected },
        })
        .where(eq(fulfilmentAttempts.id, attemptId))
        .returning();
      await addOrderEvent(tx, order.id, 'attempt', {
        ...event,
        reason: inputRejected ? 'input_rejected' : null,
        details: { status: 'failed' },
      });
      let changed = order;
      if (order.status === 'sent_to_supplier') {
        changed = (await transitionOrder(tx, order, 'failed', event)) as OrderRow;
      }
      if (inputRejected) {
        changed = await refundRemaining(tx, context, changed, 'input_rejected', {
          actor: event.actor === 'admin' ? 'admin' : 'system',
          actorId: admin?.id ?? null,
        });
      } else {
        await queueFulfil(tx, context.jobs, order.id);
      }
      return { applied: true, order: changed, attempt: closed as AttemptRow };
    }
    case 'pending':
    case 'unknown': {
      // Manual attempts are never polled (rule MN2); automatic ones by the policy (rule F7).
      const sentAt = attempt.sentAt ?? context.now;
      const policy = await currentOrderPolicy(tx);
      const pollAt =
        supplierCode === 'manual'
          ? null
          : outcome.status === 'pending' && attempt.status !== 'pending'
            ? firstPollAt(sentAt, policy)
            : nextPollAt(sentAt, context.now, policy);
      const [kept] = await tx
        .update(fulfilmentAttempts)
        .set({
          status: outcome.status,
          supplierOrderId,
          nextPollAt: pollAt,
          sentAt,
          ...(outcome.status === 'unknown' && { failureReason: clip(outcome.reason, 200) }),
          result: { status: outcome.status },
        })
        .where(eq(fulfilmentAttempts.id, attemptId))
        .returning();
      if (attempt.status !== outcome.status) {
        await addOrderEvent(tx, order.id, 'attempt', {
          ...event,
          reason: outcome.status === 'unknown' ? clip(outcome.reason, 64) : null,
          details: { status: outcome.status },
        });
      }
      if (pollAt) await queuePoll(tx, context.jobs, attemptId, pollAt);
      return { applied: true, order, attempt: kept as AttemptRow };
    }
  }
}

/** Who refunds: the system after failures, or the admin's decision (rule D5). */
export interface RefundActor {
  actor: 'system' | 'admin';
  actorId: string | null;
  /** The admin's reason and `Idempotency-Key`. */
  reason?: string;
  idempotencyKey?: string | null;
}

/**
 * Rule M3: refunds the order's remaining units to the customer's wallet, in the transaction of
 * its terminal status: `refunded` when nothing was delivered (`order:<id>:refund`), else
 * `partially_refunded` (`order:<id>:refund:<last attempt>`). An order has one refund journal, so
 * refunds never exceed what was paid. The caller holds the order lock and closed its attempt.
 */
export async function refundRemaining(
  tx: Transaction,
  context: Pick<OrderContext, 'jobs'>,
  order: OrderRow,
  reason: RefundReason,
  by: RefundActor,
): Promise<OrderRow> {
  const units = order.quantity - order.deliveredQuantity - order.refundedQuantity;
  if (units <= 0) throw new Error(`Order ${order.id} has nothing left to refund`);
  const amount = refundAmount(order.unitPriceUsdUnits, units);
  const [lastAttempt] = await tx
    .select({ id: fulfilmentAttempts.id })
    .from(fulfilmentAttempts)
    .where(eq(fulfilmentAttempts.orderId, order.id))
    .orderBy(desc(fulfilmentAttempts.createdAt), desc(fulfilmentAttempts.id))
    .limit(1);
  const partial = order.deliveredQuantity > 0;
  const journal = await postJournal(tx, {
    idempotencyKey: partial
      ? `order:${order.id}:refund:${lastAttempt?.id}`
      : `order:${order.id}:refund`,
    kind: 'refund',
    postings: [
      { accountId: await ensureCustomerWallet(tx, order.customerId), amountUnits: amount },
      {
        accountId: await ensureSystemAccount(tx, {
          code: 'refunds:USD',
          kind: 'refunds',
          currency: 'USD',
        }),
        amountUnits: -amount,
      },
    ],
  });
  const productNameAr = await productName(tx, order.productId);
  // S10 rule CT8: a checkout's orders tell the center only; its summary is the one email.
  const email = { email: order.checkoutId === null };
  if (partial) {
    await notifyCustomer(
      tx,
      context.jobs,
      {
        customerId: order.customerId,
        event: 'order_partially_refunded',
        params: {
          orderId: order.id,
          orderNumber: order.number,
          productNameAr,
          deliveredQuantity: order.deliveredQuantity,
          refundedQuantity: units,
          refundedUsdUnits: amount,
        },
      },
      email,
    );
  } else {
    await notifyCustomer(
      tx,
      context.jobs,
      {
        customerId: order.customerId,
        event: 'order_refunded',
        params: {
          orderId: order.id,
          orderNumber: order.number,
          productNameAr,
          refundedUsdUnits: amount,
          reason,
        },
      },
      email,
    );
  }
  const changed = await transitionOrder(
    tx,
    order,
    partial ? 'partially_refunded' : 'refunded',
    { actor: by.actor, actorId: by.actorId, reason },
    {
      refundedQuantity: order.refundedQuantity + units,
      refundedUsdUnits: refundAmount(order.unitPriceUsdUnits, order.refundedQuantity + units),
      refundReason: reason,
      refundJournalId: journal.journalId,
      refundIdempotencyKey: by.idempotencyKey ?? null,
    },
    context.jobs,
  );
  if (!changed) throw new Error(`Order ${order.id} changed while it was refunded`);
  const channel: AuditChannel = by.actor === 'admin' ? 'admin' : 'worker';
  await recordAudit(tx, {
    action: 'order.refunded',
    actorKind: by.actor,
    actorId: by.actorId,
    channel,
    entityType: 'order',
    entityId: order.id,
    reason: by.reason ?? null,
    details: { units, amountUsdUnits: amount, reason, journalId: journal.journalId },
  });
  return changed;
}

async function productName(tx: Transaction, productId: string): Promise<string> {
  const [row] = await tx
    .select({ nameAr: catalogProducts.nameAr })
    .from(catalogProducts)
    .where(eq(catalogProducts.id, productId));
  return row?.nameAr ?? '';
}

async function notifyDelivered(tx: Transaction, context: OrderContext, order: OrderRow) {
  await notifyCustomer(
    tx,
    context.jobs,
    {
      customerId: order.customerId,
      event: 'order_delivered',
      params: {
        orderId: order.id,
        orderNumber: order.number,
        productNameAr: await productName(tx, order.productId),
        quantity: order.quantity,
      },
    },
    { email: order.checkoutId === null },
  );
}
