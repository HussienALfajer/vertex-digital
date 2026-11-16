import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { QUEUES, REVIEW_TIME_ZONE } from '@vertex-digital/contracts';
import type { Database } from '@vertex-digital/db';
import { sql } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';

export const RATES_PURGE_OBSERVATIONS_CRON = '40 4 * * *';

/** Reads deleted per statement. */
export const PURGE_RATE_OBSERVATIONS_BATCH = 5_000;

/**
 * `rates.purge-observations` (S27 data), daily at 04:40 Damascus: rate source reads older than
 * 90 days are deleted by `purge_rate_observations` (migration 0122), the only path past their
 * append-only guard. In batches, each its own statement; safe to run twice.
 */
@Injectable()
export class PurgeRateObservationsJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(PurgeRateObservationsJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work(QUEUES.ratesPurgeObservations, async () => {
      const deleted = await this.purge();
      if (deleted > 0) this.logger.log(`Deleted ${deleted} old rate source reads`);
    });
    await this.pgBoss.boss.schedule(
      QUEUES.ratesPurgeObservations,
      RATES_PURGE_OBSERVATIONS_CRON,
      undefined,
      { tz: REVIEW_TIME_ZONE },
    );
    this.logger.log(
      `Scheduled ${QUEUES.ratesPurgeObservations} (${RATES_PURGE_OBSERVATIONS_CRON} Damascus)`,
    );
  }

  /** Deletes every read past the retention; how many. */
  async purge(): Promise<number> {
    let deleted = 0;
    for (;;) {
      const { rows } = await this.db.execute<{ deleted: number }>(
        sql`select purge_rate_observations(${PURGE_RATE_OBSERVATIONS_BATCH}) as deleted`,
      );
      const batch = rows[0]?.deleted ?? 0;
      deleted += batch;
      if (batch < PURGE_RATE_OBSERVATIONS_BATCH) return deleted;
    }
  }
}
