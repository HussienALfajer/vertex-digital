import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { QUEUES, REVIEW_TIME_ZONE } from '@vertex-digital/contracts';
import {
  bossJobSender,
  type Database,
  sendTierReminder,
  tierReminderMerchants,
  withoutQueryParameters,
} from '@vertex-digital/db';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';

/** PG3: the 25th at 10:00 `Asia/Damascus`. */
export const TIER_REMINDERS_CRON = '0 10 25 * *';

/**
 * `merchants.tier-reminders` (S23 PG3), monthly: `merchant_tier_reminder` to every merchant within
 * 30% of the next tier or below the threshold of a tier the previous month carried, each in a
 * transaction of their own; frozen and revoked merchants are skipped, test merchants included.
 * Safe twice: a month's reminder already written is not written again (`sendTierReminder`, the
 * dedupe key `tier-reminder:<customer>:<month>`). A merchant that fails is logged by id and
 * skipped; the run fails at its end.
 */
@Injectable()
export class MerchantTierRemindersJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(MerchantTierRemindersJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work(QUEUES.merchantsTierReminders, async () => {
      const sent = await this.sendAll(new Date());
      if (sent > 0) this.logger.log(`Reminded ${sent} merchants of their tier`);
    });
    await this.pgBoss.boss.schedule(
      QUEUES.merchantsTierReminders,
      TIER_REMINDERS_CRON,
      {},
      { tz: REVIEW_TIME_ZONE },
    );
    this.logger.log(`Scheduled ${QUEUES.merchantsTierReminders} (${TIER_REMINDERS_CRON} Damascus)`);
  }

  /** PG3 at `now`; returns how many reminders were written. */
  async sendAll(now: Date): Promise<number> {
    const jobs = bossJobSender(this.pgBoss.boss);
    let sent = 0;
    let failed = 0;
    for (const customerId of await tierReminderMerchants(this.db)) {
      try {
        if (await this.db.transaction((tx) => sendTierReminder(tx, jobs, customerId, now))) {
          sent += 1;
        }
      } catch (error) {
        const reported = withoutQueryParameters(error) as Error;
        this.logger.error(`Tier reminder of customer ${customerId} failed: ${reported.message}`);
        failed += 1;
      }
    }
    if (failed > 0) throw new Error(`Tier reminders failed for ${failed} merchants`);
    return sent;
  }
}
