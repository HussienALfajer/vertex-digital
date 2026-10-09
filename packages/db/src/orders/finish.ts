import { isTerminalOrderStatus } from '@vertex-digital/contracts';
import { eq, sql } from 'drizzle-orm';
import type { Transaction } from '../client.js';
import { type JobSender, notifyCustomer } from '../notifications/index.js';
import { checkouts, orders } from '../schema/index.js';
import { markSavedPlayers } from './saved-players.js';

type FinishedOrder = Pick<
  typeof orders.$inferSelect,
  'customerId' | 'gameId' | 'fields' | 'status' | 'refundReason' | 'checkoutId'
>;

/**
 * What follows an order's terminal status, in its transaction (`transitionOrder`): rule SP6 on the
 * customer's saved ids, and rule CT7 for a checkout order.
 */
export async function orderFinished(
  tx: Transaction,
  jobs: JobSender | undefined,
  order: FinishedOrder,
): Promise<void> {
  if (order.status === 'delivered') await markSavedPlayers(tx, order, false);
  else if (order.refundReason === 'input_rejected') await markSavedPlayers(tx, order, true);
  if (order.checkoutId === null) return;
  if (!jobs)
    throw new Error(`Checkout ${order.checkoutId}: an order finished without a job sender`);
  await finishCheckout(tx, jobs, order.checkoutId);
}

/**
 * Rule CT7: locks the checkout `FOR UPDATE`, so two of its orders finishing at once take turns;
 * the one that sees no open order left sets `finished_at` and notifies `checkout_finished` once.
 */
async function finishCheckout(tx: Transaction, jobs: JobSender, checkoutId: string) {
  const [checkout] = await tx
    .select()
    .from(checkouts)
    .where(eq(checkouts.id, checkoutId))
    .for('update');
  if (!checkout || checkout.finishedAt !== null) return;
  const rows = await tx
    .select({ status: orders.status, refundedUsdUnits: orders.refundedUsdUnits })
    .from(orders)
    .where(eq(orders.checkoutId, checkoutId));
  if (rows.some((row) => !isTerminalOrderStatus(row.status))) return;
  await tx.update(checkouts).set({ finishedAt: sql`now()` }).where(eq(checkouts.id, checkoutId));
  const counted = (status: string) => rows.filter((row) => row.status === status).length;
  await notifyCustomer(tx, jobs, {
    customerId: checkout.customerId,
    event: 'checkout_finished',
    params: {
      checkoutId,
      orderCount: rows.length,
      delivered: counted('delivered'),
      partiallyRefunded: counted('partially_refunded'),
      refunded: counted('refunded'),
      refundedUsdUnits: rows.reduce((sum, row) => sum + row.refundedUsdUnits, 0),
    },
  });
}
