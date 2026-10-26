import type { AuditChannel } from '@vertex-digital/contracts';
import { and, eq, inArray, lte, type SQL, sql } from 'drizzle-orm';
import { recordAudit } from '../audit/index.js';
import type { Transaction } from '../client.js';
import type { JobSender } from '../notifications/index.js';
import { deposits, usdtDeposits, usdtScanCursors } from '../schema/index.js';
import { queueDepositCard } from '../telegram/index.js';

/** How long past its expiry a USDT deposit waits for a scanner that is behind (audit A02-21). */
export const USDT_EXPIRY_HOLD_MINUTES = 60;

/**
 * Moves `pending` deposits past `expires_at` (by the database's clock) to `expired` (S03 rule
 * SC12), at most `limit`, locked `FOR UPDATE SKIP LOCKED`: a deposit a customer is submitting
 * right now is skipped, and whichever commits first wins. One audit entry each, the system as
 * actor; a USDT deposit's check ends with it (S04 rule U4); a deposit sent back for a clearer
 * receipt has a card to close (S05 rule TC6). No email: the customer did nothing after creating
 * it. Shared by the worker's `deposits.expire` and, for one customer, a new deposit's creation
 * (F4-13), so an elapsed deposit never blocks the next while the job has not run.
 *
 * The job leaves a USDT deposit pending while its network's scanner has not read past its expiry,
 * for up to an hour (audit A02-21): a transfer sent before the deadline is still credited when the
 * scanner catches up (edge case 5), instead of landing unmatched. The customer's own new deposit
 * expires it by the clock, as before.
 */
export async function expireDueDeposits(
  tx: Transaction,
  jobs: JobSender,
  options: { limit: number; channel: AuditChannel; customerId?: string },
): Promise<number> {
  const conditions: SQL[] = [eq(deposits.status, 'pending'), lte(deposits.expiresAt, sql`now()`)];
  if (options.customerId) conditions.push(eq(deposits.customerId, options.customerId));
  else {
    conditions.push(sql`not exists (
      select 1 from ${usdtDeposits}
      where ${usdtDeposits.depositId} = ${deposits.id}
        and ${deposits.expiresAt} > now() - make_interval(mins => ${USDT_EXPIRY_HOLD_MINUTES})
        and coalesce(
          (select ${usdtScanCursors.lastSuccessAt} from ${usdtScanCursors}
            where ${usdtScanCursors.method} = ${usdtDeposits.method}),
          'epoch'::timestamptz
        ) <= ${deposits.expiresAt})`);
  }
  const due = await tx
    .select({ id: deposits.id, receiptRequestCount: deposits.receiptRequestCount })
    .from(deposits)
    .where(and(...conditions))
    .orderBy(deposits.expiresAt, deposits.id)
    .limit(options.limit)
    .for('update', { skipLocked: true });
  if (due.length === 0) return 0;
  const ids = due.map((row) => row.id);
  await tx.update(deposits).set({ status: 'expired' }).where(inArray(deposits.id, ids));
  await tx
    .update(usdtDeposits)
    .set({ checkStatus: 'done', checkError: null })
    .where(inArray(usdtDeposits.depositId, ids));
  for (const id of ids) {
    await recordAudit(tx, {
      action: 'deposit.expired',
      actorKind: 'system',
      actorId: null,
      channel: options.channel,
      entityType: 'deposit',
      entityId: id,
      reason: null,
      ipAddress: null,
      userAgent: null,
      details: { depositId: id },
    });
  }
  for (const row of due.filter((deposit) => deposit.receiptRequestCount > 0)) {
    await queueDepositCard(tx, jobs, row.id);
  }
  return ids.length;
}
