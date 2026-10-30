import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { QUEUES } from '@vertex-digital/contracts';
import {
  bossJobSender,
  type Database,
  earlyAccessEndedBetween,
  queueStoreRevalidate,
} from '@vertex-digital/db';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';

/** OP7: every 5 minutes. */
export const EARLY_ACCESS_END_CRON = '*/5 * * * *';

/**
 * A window that ended within this span before a run counts as ended since the last run: three
 * runs' worth, so a missed or late run still refreshes the store.
 */
export const EARLY_ACCESS_END_LOOKBACK_MS = 15 * 60 * 1000;

/**
 * `catalog.early-access-end` (S23 OP7), every 5 minutes: when a game's or a pack's early-access
 * window ended since the last run, the store's catalog cache is refreshed (`store.revalidate`, one
 * job per slot), so everyone sees it within 5 minutes; F42 and S21 alerts then see the pack as new.
 * Nothing is written to the catalog: an ended window is read by its time. Safe twice: a second
 * refresh in the same slot is debounced.
 */
@Injectable()
export class CatalogEarlyAccessEndJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(CatalogEarlyAccessEndJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work(QUEUES.catalogEarlyAccessEnd, async () => {
      const ended = await this.run(new Date());
      if (ended > 0) this.logger.log(`Refreshed the store for ${ended} ended early-access windows`);
    });
    await this.pgBoss.boss.schedule(QUEUES.catalogEarlyAccessEnd, EARLY_ACCESS_END_CRON);
    this.logger.log(`Scheduled ${QUEUES.catalogEarlyAccessEnd} (${EARLY_ACCESS_END_CRON})`);
  }

  /** Returns the windows that ended in the look-back span. */
  async run(now: Date): Promise<number> {
    const ended = await earlyAccessEndedBetween(
      this.db,
      new Date(now.getTime() - EARLY_ACCESS_END_LOOKBACK_MS),
      now,
    );
    if (ended > 0) {
      const jobs = bossJobSender(this.pgBoss.boss);
      await this.db.transaction((tx) => queueStoreRevalidate(tx, jobs));
    }
    return ended;
  }
}
