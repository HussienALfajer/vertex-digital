import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { QUEUES } from '@vertex-digital/contracts';
import {
  bossJobSender,
  type Database,
  deposits,
  queueDepositCard,
  recordAudit,
  usdtDeposits,
} from '@vertex-digital/db';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';

export const EXPIRE_DEPOSITS_CRON = '*/5 * * * *';

/** Deposits expired per transaction. */
export const EXPIRE_BATCH_SIZE = 100;

/**
 * `deposits.expire` (S03 rule SC12), every 5 minutes: moves `pending` deposits past `expires_at`
 * to `expired`, in batches of 100 locked with `FOR UPDATE SKIP LOCKED`, one audit entry each, in
 * the batch's transaction. A deposit a customer is submitting right now is locked, so it is
 * skipped; whichever commits first wins (rule SC12). Safe to run twice: the status check makes a
 * second run a no-op. No email: the customer did nothing after creating the deposit.
 */
@Injectable()
export class ExpireDepositsJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(ExpireDepositsJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work(QUEUES.depositsExpire, async () => {
      const expired = await this.expire();
      if (expired > 0) this.logger.log(`Expired ${expired} deposits`);
    });
    await this.pgBoss.boss.schedule(QUEUES.depositsExpire, EXPIRE_DEPOSITS_CRON);
    this.logger.log(`Scheduled ${QUEUES.depositsExpire} (${EXPIRE_DEPOSITS_CRON})`);
  }

  /** Expires every overdue deposit it can lock; returns how many. */
  async expire(): Promise<number> {
    let total = 0;
    for (;;) {
      const expired = await this.db.transaction(async (tx) => {
        const due = await tx
          .select({ id: deposits.id, receiptRequestCount: deposits.receiptRequestCount })
          .from(deposits)
          .where(and(eq(deposits.status, 'pending'), lte(deposits.expiresAt, sql`now()`)))
          .orderBy(deposits.expiresAt, deposits.id)
          .limit(EXPIRE_BATCH_SIZE)
          .for('update', { skipLocked: true });
        if (due.length === 0) return 0;
        const ids = due.map((row) => row.id);
        await tx.update(deposits).set({ status: 'expired' }).where(inArray(deposits.id, ids));
        // A USDT deposit's check ends with it; its amount stays reserved 7 days (S04 rule U4).
        await tx
          .update(usdtDeposits)
          .set({ checkStatus: 'done', checkError: null })
          .where(inArray(usdtDeposits.depositId, ids));
        for (const id of ids) {
          await recordAudit(tx, {
            action: 'deposit.expired',
            actorKind: 'system',
            actorId: null,
            channel: 'worker',
            entityType: 'deposit',
            entityId: id,
            reason: null,
            ipAddress: null,
            userAgent: null,
            details: { depositId: id },
          });
        }
        // A deposit sent back for a clearer receipt has a card to close (S05 rule TC6).
        for (const row of due.filter((deposit) => deposit.receiptRequestCount > 0)) {
          await queueDepositCard(tx, bossJobSender(this.pgBoss.boss), row.id);
        }
        return ids.length;
      });
      total += expired;
      if (expired < EXPIRE_BATCH_SIZE) return total;
    }
  }
}
