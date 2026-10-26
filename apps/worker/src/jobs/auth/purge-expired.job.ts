import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { QUEUES } from '@vertex-digital/contracts';
import {
  adminSessions,
  adminVerifications,
  customerSessions,
  customerVerifications,
  type Database,
} from '@vertex-digital/db';
import { and, inArray, lt } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';

export const PURGE_EXPIRED_CRON = '17 * * * *';

/** Rows deleted per statement. */
export const PURGE_EXPIRED_BATCH_SIZE = 1_000;

/**
 * `auth.purge-expired` (A01-1), hourly at :17: deletes what can no longer sign anyone in or prove
 * anything. Sessions of both auth instances past their expiry (Better Auth deletes a session only
 * when its cookie comes back); an admin session idle past rule D4 stays until its 12 hours end, so
 * the first action after it still meets `SESSION_IDLE_EXPIRED` and the panel's notice. Verification
 * rows of both instances past their expiry: email codes and their decoys, passkey challenges and
 * grants, the admin's TOTP step. The public passkey sign-in options write a challenge on every
 * call, so without this the table grows with every visit that never signs in. A missing code
 * answers as an expired one (`email-codes.ts`), so deleting it changes no answer. Not business
 * records: no audit. A push device goes with its session (the foreign key). Safe to run twice.
 *
 * Each delete repeats the expiry on the row it deletes, not only in its batch's select: a code
 * re-issued on the same row (`ON CONFLICT DO UPDATE`) while the batch waits on its lock is
 * checked again and kept.
 */
@Injectable()
export class PurgeExpiredJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(PurgeExpiredJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work(QUEUES.authPurgeExpired, async () => {
      const deleted = await this.purge();
      if (deleted > 0) this.logger.log(`Deleted ${deleted} ended sessions and expired values`);
    });
    await this.pgBoss.boss.schedule(QUEUES.authPurgeExpired, PURGE_EXPIRED_CRON);
    this.logger.log(`Scheduled ${QUEUES.authPurgeExpired} (${PURGE_EXPIRED_CRON})`);
  }

  /** Deletes every ended session and expired value; returns how many rows. */
  async purge(now = new Date()): Promise<number> {
    const db = this.db;
    const counts = [
      await batched(() => {
        const ended = lt(customerSessions.expiresAt, now);
        return db
          .delete(customerSessions)
          .where(
            and(
              ended,
              inArray(
                customerSessions.id,
                db
                  .select({ id: customerSessions.id })
                  .from(customerSessions)
                  .where(ended)
                  .limit(PURGE_EXPIRED_BATCH_SIZE),
              ),
            ),
          )
          .returning({ id: customerSessions.id });
      }),
      await batched(() => {
        const ended = lt(customerVerifications.expiresAt, now);
        return db
          .delete(customerVerifications)
          .where(
            and(
              ended,
              inArray(
                customerVerifications.id,
                db
                  .select({ id: customerVerifications.id })
                  .from(customerVerifications)
                  .where(ended)
                  .limit(PURGE_EXPIRED_BATCH_SIZE),
              ),
            ),
          )
          .returning({ id: customerVerifications.id });
      }),
      await batched(() => {
        const ended = lt(adminSessions.expiresAt, now);
        return db
          .delete(adminSessions)
          .where(
            and(
              ended,
              inArray(
                adminSessions.id,
                db
                  .select({ id: adminSessions.id })
                  .from(adminSessions)
                  .where(ended)
                  .limit(PURGE_EXPIRED_BATCH_SIZE),
              ),
            ),
          )
          .returning({ id: adminSessions.id });
      }),
      await batched(() => {
        const ended = lt(adminVerifications.expiresAt, now);
        return db
          .delete(adminVerifications)
          .where(
            and(
              ended,
              inArray(
                adminVerifications.id,
                db
                  .select({ id: adminVerifications.id })
                  .from(adminVerifications)
                  .where(ended)
                  .limit(PURGE_EXPIRED_BATCH_SIZE),
              ),
            ),
          )
          .returning({ id: adminVerifications.id });
      }),
    ];
    return counts.reduce((sum, count) => sum + count, 0);
  }
}

/** Runs one batch delete until a batch comes back short; returns how many rows went. */
async function batched(remove: () => Promise<unknown[]>): Promise<number> {
  let total = 0;
  for (;;) {
    const deleted = await remove();
    total += deleted.length;
    if (deleted.length < PURGE_EXPIRED_BATCH_SIZE) return total;
  }
}
