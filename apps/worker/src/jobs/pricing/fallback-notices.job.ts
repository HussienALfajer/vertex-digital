import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { QUEUES } from '@vertex-digital/contracts';
import {
  bossJobSender,
  type Database,
  damascusDate,
  fixedPriceFallbacks,
  queueTelegramMessage,
  type Transaction,
} from '@vertex-digital/db';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';

export const FALLBACK_NOTICES_CRON = '*/10 * * * *';

/**
 * `pricing.fallback-notices` (S20 RP5, decision 6), every 10 minutes: one Telegram
 * `fixed_price_fallback` per list price that fell back from its fixed price to its rule, deduped by
 * `fixed-fallback:<list>:<product>:<Damascus date>`, so a fallback is told within 10 minutes of
 * any repricing that caused it, and once a day while it lasts. Read from the stored rows, so no
 * repricing path has to queue it; safe to run twice (the dedupe key).
 */
@Injectable()
export class FallbackNoticesJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(FallbackNoticesJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work(QUEUES.pricingFallbackNotices, async () => {
      const queued = await this.db.transaction((tx) => this.notify(tx, new Date()));
      if (queued > 0) this.logger.log(`Queued ${queued} fixed-price fallback notices`);
    });
    await this.pgBoss.boss.schedule(QUEUES.pricingFallbackNotices, FALLBACK_NOTICES_CRON);
    this.logger.log(`Scheduled ${QUEUES.pricingFallbackNotices} (${FALLBACK_NOTICES_CRON})`);
  }

  /** Queues the notices not yet sent today; returns how many. */
  async notify(tx: Transaction, now: Date): Promise<number> {
    const jobs = bossJobSender(this.pgBoss.boss);
    const date = damascusDate(now);
    let queued = 0;
    for (const cell of await fixedPriceFallbacks(tx)) {
      const id = await queueTelegramMessage(tx, jobs, {
        kind: 'fixed_price_fallback',
        params: cell,
        dedupeKey: `fixed-fallback:${cell.priceListId}:${cell.productId}:${date}`,
      });
      if (id) queued += 1;
    }
    return queued;
  }
}
