import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { QUEUES } from '@vertex-digital/contracts';
import {
  bossJobSender,
  type Database,
  dueTierGrants,
  expireTierGrant,
  remindEndingTierGrants,
} from '@vertex-digital/db';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';

export const TIER_GRANTS_CRON = '*/10 * * * *';

/** The grants that failed to end, after every other step was done. */
export class TierGrantsFailed extends Error {
  constructor(readonly steps: string[]) {
    super(`Merchant tier grants steps failed: ${steps.join(', ')}`);
  }
}

export interface TierGrantsResult {
  expired: string[];
  reminded: number;
}

/**
 * `merchants.tier-grants` (S23 MG4, MG5), every 10 minutes: each open grant past its end becomes
 * `expired` with the merchant's recomputation (TR6), one transaction per grant
 * (`expireTierGrant`: the customer, then the grant re-read under the lock, so a grant ended
 * meanwhile is left); then one Telegram reminder per grant ending within 3 days (dedupe key
 * `grant-ending:<grant>`). The steps are independent: a failing grant does not stop the others or
 * the reminders, and the run then fails naming them. Safe twice: an ended grant is not due again
 * and a reminder is written once.
 */
@Injectable()
export class MerchantTierGrantsJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(MerchantTierGrantsJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work(QUEUES.merchantsTierGrants, async () => {
      const result = await this.run(new Date());
      if (result.expired.length > 0 || result.reminded > 0)
        this.logger.log(
          `Ended ${result.expired.length} tier grants, reminded ${result.reminded} ending`,
        );
    });
    await this.pgBoss.boss.schedule(QUEUES.merchantsTierGrants, TIER_GRANTS_CRON);
    this.logger.log(`Scheduled ${QUEUES.merchantsTierGrants} (${TIER_GRANTS_CRON})`);
  }

  async run(now: Date): Promise<TierGrantsResult> {
    const context = { jobs: bossJobSender(this.pgBoss.boss), now };
    const failed: string[] = [];
    const expired: string[] = [];
    for (const grant of await dueTierGrants(this.db, now)) {
      try {
        const ended = await this.db.transaction((tx) => expireTierGrant(tx, context, grant));
        if (ended) expired.push(grant.id);
      } catch (error) {
        this.logger.error(`Tier grant ${grant.id} failed to end`, error);
        failed.push(`grant ${grant.id}`);
      }
    }
    let reminded = 0;
    try {
      reminded = await this.db.transaction((tx) => remindEndingTierGrants(tx, context));
    } catch (error) {
      this.logger.error('Tier grant reminders failed', error);
      failed.push('reminders');
    }
    if (failed.length > 0) throw new TierGrantsFailed(failed);
    return { expired, reminded };
  }
}
