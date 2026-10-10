import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { QUEUES, REVIEW_TIME_ZONE, SIGN_IN_RETENTION_DAYS } from '@vertex-digital/contracts';
import { customerSignIns, type Database } from '@vertex-digital/db';
import { inArray, lt, sql } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';

export const PURGE_SIGN_INS_CRON = '0 4 * * *';

/** Sign-ins deleted per statement. */
export const PURGE_BATCH_SIZE = 1_000;

/**
 * `customers.purge-sign-ins` (S12 data), daily at 04:00 Damascus: deletes the sign-in log older
 * than 90 days, in batches. Not business records: no audit. Safe to run twice.
 */
@Injectable()
export class PurgeSignInsJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(PurgeSignInsJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work(QUEUES.customersPurgeSignIns, async () => {
      const deleted = await this.purge();
      if (deleted > 0) this.logger.log(`Deleted ${deleted} old sign-ins`);
    });
    await this.pgBoss.boss.schedule(QUEUES.customersPurgeSignIns, PURGE_SIGN_INS_CRON, undefined, {
      tz: REVIEW_TIME_ZONE,
    });
    this.logger.log(`Scheduled ${QUEUES.customersPurgeSignIns} (${PURGE_SIGN_INS_CRON} Damascus)`);
  }

  /** Deletes every sign-in past the retention; returns how many. */
  async purge(): Promise<number> {
    let total = 0;
    for (;;) {
      const old = this.db
        .select({ id: customerSignIns.id })
        .from(customerSignIns)
        .where(
          lt(
            customerSignIns.createdAt,
            sql`now() - make_interval(days => ${SIGN_IN_RETENTION_DAYS})`,
          ),
        )
        .limit(PURGE_BATCH_SIZE);
      const deleted = await this.db
        .delete(customerSignIns)
        .where(inArray(customerSignIns.id, old))
        .returning({ id: customerSignIns.id });
      total += deleted.length;
      if (deleted.length < PURGE_BATCH_SIZE) return total;
    }
  }
}
