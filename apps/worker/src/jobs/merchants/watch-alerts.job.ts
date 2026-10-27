import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { QUEUES, REVIEW_TIME_ZONE } from '@vertex-digital/contracts';
import {
  bossJobSender,
  compareMerchantWatches,
  type Database,
  dailyDigestMerchants,
  merchantsToCompare,
  sendDailyDigest,
  withoutQueryParameters,
} from '@vertex-digital/db';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';

/** AL2: at minute 5 of every hour. */
export const WATCH_ALERTS_CRON = '5 * * * *';

/** AL4: 09:00 `Asia/Damascus`. */
export const DAILY_DIGEST_CRON = '0 9 * * *';

/**
 * `merchants.watch-alerts` (S21 AL2, AL3, AL6), hourly: each merchant with follows compared in a
 * transaction of their own (`compareMerchantWatches`, a merchant held by another run is skipped),
 * at most one digest notification each; a sent low-balance alert is cleared once the balance is
 * back. `merchants.daily-digest` (AL4), daily: the email of the last 24 hours for merchants who
 * turned it on, at most one a day. Both safe twice: a second run finds no difference, and a digest
 * already queued today is not queued again.
 */
@Injectable()
export class MerchantWatchAlertsJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(MerchantWatchAlertsJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work(QUEUES.merchantsWatchAlerts, async () => {
      const events = await this.compareAll(new Date());
      if (events > 0) this.logger.log(`Told merchants of ${events} changes`);
    });
    await this.pgBoss.work(QUEUES.merchantsDailyDigest, async () => {
      const sent = await this.digestAll(new Date());
      if (sent > 0) this.logger.log(`Queued ${sent} merchant daily digests`);
    });
    await this.pgBoss.boss.schedule(QUEUES.merchantsWatchAlerts, WATCH_ALERTS_CRON);
    await this.pgBoss.boss.schedule(
      QUEUES.merchantsDailyDigest,
      DAILY_DIGEST_CRON,
      {},
      { tz: REVIEW_TIME_ZONE },
    );
    this.logger.log(`Scheduled ${QUEUES.merchantsWatchAlerts} (${WATCH_ALERTS_CRON})`);
    this.logger.log(`Scheduled ${QUEUES.merchantsDailyDigest} (${DAILY_DIGEST_CRON} Damascus)`);
  }

  /** AL2: every merchant to compare; returns the events written. */
  async compareAll(now: Date): Promise<number> {
    const context = {
      jobs: bossJobSender(this.pgBoss.boss),
      now,
      fakeEnabled: this.env.SUPPLIER_FAKE_ENABLED,
    };
    let events = 0;
    await this.eachMerchant('Watch comparison', await merchantsToCompare(this.db), async (id) => {
      const result = await this.db.transaction((tx) => compareMerchantWatches(tx, context, id));
      events += result?.events ?? 0;
    });
    return events;
  }

  /** AL4: every merchant who turned the email on; returns the emails queued. */
  async digestAll(now: Date): Promise<number> {
    const jobs = bossJobSender(this.pgBoss.boss);
    let sent = 0;
    await this.eachMerchant('Daily digest', await dailyDigestMerchants(this.db), async (id) => {
      if (await this.db.transaction((tx) => sendDailyDigest(tx, { jobs, now }, id))) sent += 1;
    });
    return sent;
  }

  /**
   * Audit A06-33: each merchant in turn, one's failure logged by id and the others still run; the
   * run then fails, so pg-boss reports and retries it (a retry finds the done ones done).
   */
  private async eachMerchant(
    step: string,
    customerIds: readonly string[],
    work: (customerId: string) => Promise<void>,
  ): Promise<void> {
    let failed = 0;
    for (const customerId of customerIds) {
      try {
        await work(customerId);
      } catch (error) {
        const reported = withoutQueryParameters(error) as Error;
        this.logger.error(`${step} of customer ${customerId} failed: ${reported.message}`);
        failed += 1;
      }
    }
    if (failed > 0) throw new Error(`${step} failed for ${failed} merchants`);
  }
}
