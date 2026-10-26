import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ADMIN_SESSION_RULES, QUEUES } from '@vertex-digital/contracts';
import {
  adminSessions,
  adminVerifications,
  customerSessions,
  customerVerifications,
  type Database,
} from '@vertex-digital/db';
import { inArray, lt, or } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';

export const PURGE_EXPIRED_CRON = '17 * * * *';

/** Rows deleted per statement. */
export const PURGE_EXPIRED_BATCH_SIZE = 1_000;

/**
 * `auth.purge-expired` (A01-1), hourly at :17: deletes what can no longer sign anyone in or prove
 * anything. Sessions of both auth instances past their expiry, and the admin's idle past rule D4
 * (Better Auth deletes a session only when its cookie comes back); verification rows of both
 * instances past their expiry: email codes and their decoys, passkey challenges and grants, the
 * admin's TOTP step. The public passkey sign-in options write a challenge on every call, so
 * without this the table grows with every visit that never signs in. A missing code answers as an
 * expired one (`email-codes.ts`), so deleting it changes no answer. Not business records: no
 * audit. A push device goes with its session (the foreign key). Safe to run twice.
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
    const idleSince = new Date(now.getTime() - ADMIN_SESSION_RULES.idleTimeoutMs);
    const db = this.db;
    const counts = [
      await batched(() =>
        db
          .delete(customerSessions)
          .where(
            inArray(
              customerSessions.id,
              db
                .select({ id: customerSessions.id })
                .from(customerSessions)
                .where(lt(customerSessions.expiresAt, now))
                .limit(PURGE_EXPIRED_BATCH_SIZE),
            ),
          )
          .returning({ id: customerSessions.id }),
      ),
      await batched(() =>
        db
          .delete(customerVerifications)
          .where(
            inArray(
              customerVerifications.id,
              db
                .select({ id: customerVerifications.id })
                .from(customerVerifications)
                .where(lt(customerVerifications.expiresAt, now))
                .limit(PURGE_EXPIRED_BATCH_SIZE),
            ),
          )
          .returning({ id: customerVerifications.id }),
      ),
      await batched(() =>
        db
          .delete(adminSessions)
          .where(
            inArray(
              adminSessions.id,
              db
                .select({ id: adminSessions.id })
                .from(adminSessions)
                .where(
                  or(lt(adminSessions.expiresAt, now), lt(adminSessions.lastActiveAt, idleSince)),
                )
                .limit(PURGE_EXPIRED_BATCH_SIZE),
            ),
          )
          .returning({ id: adminSessions.id }),
      ),
      await batched(() =>
        db
          .delete(adminVerifications)
          .where(
            inArray(
              adminVerifications.id,
              db
                .select({ id: adminVerifications.id })
                .from(adminVerifications)
                .where(lt(adminVerifications.expiresAt, now))
                .limit(PURGE_EXPIRED_BATCH_SIZE),
            ),
          )
          .returning({ id: adminVerifications.id }),
      ),
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
