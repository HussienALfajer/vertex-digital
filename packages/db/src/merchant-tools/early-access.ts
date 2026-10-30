import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Transaction } from '../client.js';
import { type JobSender, notifyCustomer } from '../notifications/index.js';
import { customerNotifications } from '../schema/index.js';
import { earlyAccessAudience } from './reads.js';

/*
 * S23 OP5: the `merchant_early_access` notice when the admin opens a game or a pack early. Sent
 * once per merchant and target (`early-access:<game or product>:<customer>`): a window set again
 * tells no one twice. Runs in the admin's transaction, under the game's lock.
 */

export interface EarlyAccessTarget {
  gameId: string;
  gameSlug: string;
  gameNameAr: string;
  /** Null when the whole game opened early. */
  product: { id: string; nameAr: string } | null;
  until: Date;
}

/** Notifies the audience who has not been told of this target yet; returns how many were. */
export async function notifyEarlyAccess(
  tx: Transaction,
  jobs: JobSender,
  target: EarlyAccessTarget,
  now: Date,
): Promise<number> {
  const audience = await earlyAccessAudience(tx, target.gameId, now);
  if (audience.length === 0) return 0;
  const productId = target.product?.id ?? null;
  const told = await tx
    .select({ customerId: customerNotifications.customerId })
    .from(customerNotifications)
    .where(
      and(
        inArray(customerNotifications.customerId, audience),
        eq(customerNotifications.event, 'merchant_early_access'),
        sql`${customerNotifications.params}->>'gameSlug' = ${target.gameSlug}`,
        productId === null
          ? sql`${customerNotifications.params}->>'productId' is null`
          : sql`${customerNotifications.params}->>'productId' = ${productId}`,
      ),
    );
  const already = new Set(told.map((row) => row.customerId));
  let sent = 0;
  for (const customerId of audience) {
    if (already.has(customerId)) continue;
    await notifyCustomer(tx, jobs, {
      customerId,
      event: 'merchant_early_access',
      params: {
        gameSlug: target.gameSlug,
        gameNameAr: target.gameNameAr,
        productId,
        productNameAr: target.product?.nameAr ?? null,
        until: target.until.toISOString(),
      },
    });
    sent += 1;
  }
  return sent;
}
