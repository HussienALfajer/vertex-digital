import {
  type CancelReason,
  orderTotal,
  reservationCharge,
  STORE_SWITCH_DEFAULTS,
  supplierServesCustomer,
} from '@vertex-digital/contracts';
import { and, asc, desc, eq, gt, lte, sql } from 'drizzle-orm';
import { recordAudit } from '../audit/index.js';
import type { Database, Transaction } from '../client.js';
import {
  ensureSystemAccount,
  LedgerError,
  lockCustomerWallet,
  postJournal,
} from '../ledger/index.js';
import { notifyCustomer } from '../notifications/index.js';
import { catalogProducts, customers, orders, storeSwitchChanges } from '../schema/index.js';
import {
  availabilityNow,
  checkOrderFields,
  displayTotal,
  OrderError,
  routingNow,
  usableRouteCosts,
} from './purchase.js';
import {
  addOrderEvent,
  lockOrder,
  type OrderContext,
  type OrderRow,
  queueFulfil,
  transitionOrder,
} from './transition.js';

/*
 * Reservations (S09 rules RS1–RS9, A02, A15): an `awaiting_balance` order moves no money until it
 * is paid here, after a credit or by the sweep; it is cancelled by the customer, by the system
 * when it can no longer be paid as reserved, or when it expires.
 */

/**
 * The switches lock shared, then the purchase stop (S05 SW7, S08 rule O2): the same advisory key
 * as the API's `SettingsService`, so a payment commits before a stop or sees it.
 */
export async function purchasesStoppedLocked(tx: Transaction): Promise<boolean> {
  await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtext('settings'))`);
  const [row] = await tx
    .select({ value: storeSwitchChanges.value })
    .from(storeSwitchChanges)
    .where(eq(storeSwitchChanges.switch, 'purchases_stopped'))
    .orderBy(desc(storeSwitchChanges.createdAt), desc(storeSwitchChanges.id))
    .limit(1);
  return row?.value ?? STORE_SWITCH_DEFAULTS.purchases_stopped;
}

export type CancelActor =
  | { kind: 'customer'; customerId: string; ipAddress?: string | null; userAgent?: string | null }
  | { kind: 'system' };

/**
 * Moves a locked `awaiting_balance` order to `cancelled` with its reason (rules RS7–RS9), its
 * event and audit entry; a cancellation by the system notifies the customer (center and email).
 * Null on a lost race.
 */
export async function cancelReservation(
  tx: Transaction,
  context: Pick<OrderContext, 'jobs'>,
  order: OrderRow,
  reason: CancelReason,
  actor: CancelActor,
): Promise<OrderRow | null> {
  const byCustomer = actor.kind === 'customer';
  const row = await transitionOrder(
    tx,
    order,
    'cancelled',
    {
      actor: byCustomer ? 'customer' : 'system',
      actorId: byCustomer ? actor.customerId : null,
      reason,
    },
    { cancelReason: reason },
  );
  if (!row) return null;
  await recordAudit(tx, {
    action: 'order.cancelled',
    actorKind: byCustomer ? 'customer' : 'system',
    actorId: byCustomer ? actor.customerId : null,
    channel: byCustomer ? 'store' : 'worker',
    entityType: 'order',
    entityId: order.id,
    details: { reason },
    ipAddress: byCustomer ? (actor.ipAddress ?? null) : null,
    userAgent: byCustomer ? (actor.userAgent ?? null) : null,
  });
  if (reason !== 'customer') {
    const [product] = await tx
      .select({ nameAr: catalogProducts.nameAr })
      .from(catalogProducts)
      .where(eq(catalogProducts.id, order.productId));
    await notifyCustomer(tx, context.jobs, {
      customerId: order.customerId,
      event: 'order_cancelled',
      params: {
        orderId: order.id,
        orderNumber: order.number,
        productNameAr: product?.nameAr ?? '',
        reason,
      },
    });
  }
  return row;
}

/**
 * Rule RS8: the customer cancels an own reservation. Another customer's order is `NOT_FOUND`; any
 * status but `awaiting_balance` is `ORDER_NOT_CANCELLABLE` (also after losing a race with A02).
 */
export async function cancelOwnReservation(
  tx: Transaction,
  context: Pick<OrderContext, 'jobs'>,
  input: {
    orderId: string;
    customerId: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  },
): Promise<OrderRow> {
  const order = await lockOrder(tx, input.orderId);
  if (!order || order.customerId !== input.customerId) {
    throw new OrderError('NOT_FOUND', 'No such order');
  }
  const cancelled =
    order.status === 'awaiting_balance'
      ? await cancelReservation(tx, context, order, 'customer', {
          kind: 'customer',
          customerId: input.customerId,
          ipAddress: input.ipAddress ?? null,
          userAgent: input.userAgent ?? null,
        })
      : null;
  if (!cancelled) {
    throw new OrderError('ORDER_NOT_CANCELLABLE', 'Only a reservation can be cancelled', {
      status: order.status,
    });
  }
  return cancelled;
}

/** What `payWaitingOrders` did with one reservation. */
export type PayOutcome =
  | 'paid'
  | 'skipped_closed'
  | 'skipped_unavailable'
  | 'skipped_balance'
  | 'cancelled_price_rose'
  | 'cancelled_product_changed';

/** Thrown inside one order's transaction to roll it back and go on with the next (RS4 step 6). */
class ShortBalance extends Error {}

/**
 * Rule RS4: pays the customer's open reservations, oldest first, each in its own transaction:
 * the switches lock (a stop ends the run), the order `FOR UPDATE` (still reserved and unexpired),
 * the product `FOR SHARE` (unavailable: skipped), its fields (changed: cancelled), the charge of
 * rule RS6 (the price rose past a profitable route: cancelled), then the purchase journal (short:
 * this order rolls back and the next is tried) and `awaiting_balance → paid` with its event,
 * audit entry, `order_paid` notification and `orders.fulfil`. Safe to run twice: each order is
 * paid under its lock, only from `awaiting_balance`, and the journal key is unique.
 */
export async function payWaitingOrders(
  db: Database,
  context: Pick<OrderContext, 'jobs'> & { now: () => Date; fakeEnabled: boolean },
  customerId: string,
): Promise<{ stopped: boolean; outcomes: { orderId: string; outcome: PayOutcome }[] }> {
  const waiting = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.customerId, customerId),
        eq(orders.status, 'awaiting_balance'),
        gt(orders.expiresAt, sql`now()`),
      ),
    )
    .orderBy(asc(orders.createdAt), asc(orders.id));
  const outcomes: { orderId: string; outcome: PayOutcome }[] = [];
  for (const { id } of waiting) {
    let stopped = false;
    let outcome: PayOutcome = 'skipped_balance';
    try {
      await db.transaction(async (tx) => {
        if (await purchasesStoppedLocked(tx)) {
          stopped = true;
          return;
        }
        outcome = await payOne(tx, context, id);
      });
    } catch (error) {
      if (!(error instanceof ShortBalance)) throw error;
      outcome = 'skipped_balance';
    }
    if (stopped) return { stopped: true, outcomes };
    outcomes.push({ orderId: id, outcome });
  }
  return { stopped: false, outcomes };
}

async function payOne(
  tx: Transaction,
  context: Pick<OrderContext, 'jobs'> & { now: () => Date; fakeEnabled: boolean },
  orderId: string,
): Promise<PayOutcome> {
  const order = await lockOrder(tx, orderId);
  const now = context.now();
  if (order?.status !== 'awaiting_balance' || (order.expiresAt as Date) <= now) {
    return 'skipped_closed';
  }
  await tx
    .select({ id: catalogProducts.id })
    .from(catalogProducts)
    .where(eq(catalogProducts.id, order.productId))
    .for('share');
  const [customer] = await tx
    .select({ isTest: customers.isTest })
    .from(customers)
    .where(eq(customers.id, order.customerId));
  const usable = await routingNow(tx, order.productId, now, context.fakeEnabled);
  const current = usable?.current;
  if (!usable || !current || availabilityNow(usable, customer?.isTest ?? false) !== 'available') {
    return 'skipped_unavailable';
  }
  const checked = await checkOrderFields(tx, order.gameId, order.fields);
  if (!checked.ok) {
    await cancelReservation(tx, context, order, 'product_changed', { kind: 'system' });
    return 'cancelled_product_changed';
  }

  const charge = reservationCharge(order.unitPriceUsdUnits, current.priceUsdUnits);
  let priceId = order.priceId;
  let minMarginUsdUnits = usable.rule.values.minMarginUsdUnits;
  if (charge.source === 'current') {
    priceId = current.id;
    minMarginUsdUnits = current.minMarginUsdUnits;
  } else {
    const profitable = usableRouteCosts(usable).some(
      (route) =>
        supplierServesCustomer(route.supplierCode, order.isTest) &&
        order.unitPriceUsdUnits - route.costUsdUnits >= minMarginUsdUnits,
    );
    if (!profitable) {
      await cancelReservation(tx, context, order, 'price_rose', { kind: 'system' });
      return 'cancelled_price_rose';
    }
  }
  const total = orderTotal(charge.unitPriceUsdUnits, order.quantity);
  const display = await displayTotal(tx, total);
  const wallet = await lockCustomerWallet(tx, order.customerId);
  const revenue = await ensureSystemAccount(tx, {
    code: 'sales_revenue:USD',
    kind: 'sales_revenue',
    currency: 'USD',
  });
  let journalId: string;
  try {
    const journal = await postJournal(tx, {
      idempotencyKey: `order:${order.id}:purchase`,
      kind: 'purchase',
      postings: [
        { accountId: wallet, amountUnits: -total },
        { accountId: revenue, amountUnits: total },
      ],
    });
    journalId = journal.journalId;
  } catch (error) {
    if (error instanceof LedgerError && error.code === 'INSUFFICIENT_BALANCE') {
      throw new ShortBalance();
    }
    throw error;
  }

  const [paid] = await tx
    .update(orders)
    .set({
      status: 'paid',
      priceId,
      unitPriceUsdUnits: charge.unitPriceUsdUnits,
      totalUsdUnits: total,
      minMarginUsdUnits,
      ...display,
      purchaseJournalId: journalId,
      paidAt: sql`now()`,
    })
    .where(and(eq(orders.id, order.id), eq(orders.status, 'awaiting_balance')))
    .returning();
  if (!paid) throw new Error(`Order ${order.id} changed under its lock`);
  await addOrderEvent(
    tx,
    order.id,
    'status',
    { actor: 'system', details: { priceSource: charge.source } },
    { from: 'awaiting_balance', to: 'paid' },
  );
  await recordAudit(tx, {
    action: 'order.paid',
    actorKind: 'system',
    actorId: null,
    channel: 'worker',
    entityType: 'order',
    entityId: order.id,
    details: {
      number: order.number,
      productId: order.productId,
      quantity: order.quantity,
      totalUsdUnits: total,
      journalId,
      priceSource: charge.source,
    },
  });
  const [product] = await tx
    .select({ nameAr: catalogProducts.nameAr })
    .from(catalogProducts)
    .where(eq(catalogProducts.id, order.productId));
  await notifyCustomer(tx, context.jobs, {
    customerId: order.customerId,
    event: 'order_paid',
    params: { orderId: order.id, orderNumber: order.number, productNameAr: product?.nameAr ?? '' },
  });
  await queueFulfil(tx, context.jobs, order.id);
  return 'paid';
}

/**
 * Rule RS7 (A15): cancels up to `limit` reservations past their deadline, `FOR UPDATE SKIP
 * LOCKED` so a payment in progress keeps its order; each notifies `order_cancelled`. Answers the
 * ids of the orders it cancelled.
 */
export async function expireReservations(
  db: Database,
  context: Pick<OrderContext, 'jobs'>,
  limit: number,
): Promise<string[]> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.status, 'awaiting_balance'), lte(orders.expiresAt, sql`now()`)))
      .orderBy(asc(orders.expiresAt), asc(orders.id))
      .limit(limit)
      .for('update', { skipLocked: true });
    const expired: string[] = [];
    for (const order of due) {
      if (await cancelReservation(tx, context, order, 'expired', { kind: 'system' })) {
        expired.push(order.id);
      }
    }
    return expired;
  });
}

/** Rule RS4: customers with an open, unexpired reservation, oldest first (the sweep's list). */
export async function customersWithReservations(db: Database, limit: number): Promise<string[]> {
  const rows = await db
    .select({ customerId: orders.customerId, oldest: sql<Date>`min(${orders.createdAt})` })
    .from(orders)
    .where(and(eq(orders.status, 'awaiting_balance'), gt(orders.expiresAt, sql`now()`)))
    .groupBy(orders.customerId)
    .orderBy(sql`min(${orders.createdAt})`)
    .limit(limit);
  return rows.map((row) => row.customerId);
}
