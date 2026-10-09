import {
  canTransitionOrder,
  isTerminalOrderStatus,
  ORDER_POLICY_DEFAULTS,
  type OrderEventActor,
  type OrderEventKind,
  type OrderPolicy,
  type OrderStatus,
  QUEUES,
} from '@vertex-digital/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../client.js';
import { newId } from '../id.js';
import type { JobSender } from '../notifications/index.js';
import { type fulfilmentAttempts, orderEvents, orderPolicy, orders } from '../schema/index.js';

/*
 * The order state machine's only writer (S08 "States and rules", ADR 0004, 0013): a status
 * changes with `UPDATE … WHERE id = $1 AND status = <from>` and its `order_events` row, in the
 * caller's transaction. A change that matches no row lost a race and is not retried blindly.
 */

type Executor = Database | Transaction;

export type OrderRow = typeof orders.$inferSelect;
export type AttemptRow = typeof fulfilmentAttempts.$inferSelect;

/** What an order change knows that the database does not. */
export interface OrderContext {
  /** Sends jobs in the caller's transaction (the API's `JobsService`, `bossJobSender`). */
  jobs: JobSender;
  /** `ORDER_CODES_SECRET` (`orderCodesKey`). */
  codesKey: Buffer;
  now: Date;
}

export interface OrderEventInput {
  actor: OrderEventActor;
  actorId?: string | null;
  attemptId?: string | null;
  /** A code such as `no_route`, `hard_limit`, `input_rejected`. */
  reason?: string | null;
  /** Never codes or field values. */
  details?: Record<string, unknown>;
}

/** The order policy in force: the newest `order_policy` row (the seed at least). */
export async function currentOrderPolicy(db: Executor): Promise<OrderPolicy> {
  const [row] = await db
    .select()
    .from(orderPolicy)
    .orderBy(desc(orderPolicy.createdAt), desc(orderPolicy.id))
    .limit(1);
  if (!row) return ORDER_POLICY_DEFAULTS;
  return {
    firstPollSeconds: row.firstPollSeconds,
    fastPollSeconds: row.fastPollSeconds,
    fastPollMinutes: row.fastPollMinutes,
    slowPollSeconds: row.slowPollSeconds,
    hardLimitMinutes: row.hardLimitMinutes,
    reviewPollMinutes: row.reviewPollMinutes,
    reviewPollHours: row.reviewPollHours,
    manualReminderMinutes: row.manualReminderMinutes,
  };
}

/** The order, locked `FOR UPDATE` for the caller's transaction; null when it does not exist. */
export async function lockOrder(tx: Transaction, orderId: string): Promise<OrderRow | null> {
  const [row] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
  return row ?? null;
}

/** Writes one `order_events` row. */
export async function addOrderEvent(
  tx: Transaction,
  orderId: string,
  kind: OrderEventKind,
  event: OrderEventInput,
  status: { from: OrderStatus | null; to: OrderStatus } | null = null,
): Promise<void> {
  await tx.insert(orderEvents).values({
    id: newId(),
    orderId,
    kind,
    fromStatus: status?.from ?? null,
    toStatus: status?.to ?? null,
    actor: event.actor,
    actorId: event.actorId ?? null,
    attemptId: event.attemptId ?? null,
    reason: event.reason ?? null,
    details: event.details ?? {},
  });
}

/** Columns a transition may set with the status (quantities, refund, review). */
export type OrderChanges = Partial<
  Pick<
    OrderRow,
    | 'deliveredQuantity'
    | 'refundedQuantity'
    | 'refundedUsdUnits'
    | 'refundReason'
    | 'refundJournalId'
    | 'refundIdempotencyKey'
    | 'cancelReason'
  >
>;

/**
 * Moves the order from its status to `to` (ADR 0004's table, `ORDER_TRANSITIONS`) with the
 * columns that follow the status: `finished_at` on a terminal status, `delivered_at` on
 * `delivered`, `review_since` while in `needs_review`. Writes the `status` event. Returns the
 * changed row, or null when the order was no longer in that status (a lost race).
 */
export async function transitionOrder(
  tx: Transaction,
  order: Pick<OrderRow, 'id' | 'status'>,
  to: OrderStatus,
  event: OrderEventInput,
  changes: OrderChanges = {},
): Promise<OrderRow | null> {
  if (!canTransitionOrder(order.status, to)) {
    throw new Error(`Order ${order.id}: ${order.status} → ${to} is not an allowed transition`);
  }
  const [row] = await tx
    .update(orders)
    .set({
      ...changes,
      status: to,
      ...(isTerminalOrderStatus(to) && { finishedAt: sql`now()` }),
      ...(to === 'delivered' && { deliveredAt: sql`now()` }),
      reviewSince: to === 'needs_review' ? sql`now()` : null,
    })
    .where(and(eq(orders.id, order.id), eq(orders.status, order.status)))
    .returning();
  if (!row) return null;
  await addOrderEvent(tx, order.id, 'status', event, { from: order.status, to });
  return row;
}

/** Queues the routing of the order's remaining units (rule R1): one job per order. */
export async function queueFulfil(tx: Transaction, jobs: JobSender, orderId: string) {
  await jobs.send(
    tx,
    QUEUES.ordersFulfil,
    { orderId },
    { singletonKey: orderId, retryLimit: 3, retryDelay: 10, retryBackoff: true },
  );
}

/** Queues the poll of an open attempt at `at` (rule F3): one queued per attempt. */
export async function queuePoll(tx: Transaction, jobs: JobSender, attemptId: string, at: Date) {
  await jobs.send(
    tx,
    QUEUES.ordersPoll,
    { attemptId },
    { singletonKey: attemptId, startAfter: at, retryLimit: 3, retryDelay: 10, retryBackoff: true },
  );
}

/**
 * Queues the paying of a customer's reservations (S09 rule RS4): one queued and one running per
 * customer, so a credit, the sweep and a new reservation never pay one order twice at once.
 */
export async function queuePayWaiting(tx: Transaction, jobs: JobSender, customerId: string) {
  await jobs.send(
    tx,
    QUEUES.ordersPayWaiting,
    { customerId },
    { singletonKey: customerId, retryLimit: 3, retryDelay: 10, retryBackoff: true },
  );
}
