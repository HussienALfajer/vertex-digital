import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { QUEUES } from '@vertex-digital/contracts';
import { bossJobSender, type Database, expireMerchantApplications } from '@vertex-digital/db';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';

export const EXPIRE_APPLICATIONS_CRON = '*/15 * * * *';

/**
 * `merchants.expire-applications` (S20 MA4, edge case 14), every 15 minutes: applications waiting
 * for information longer than `info_expiry_days` since the request become `expired`, each in its
 * own transaction with its event, audit entry (the system) and center notice, through
 * `expireMerchantApplications` (`FOR UPDATE SKIP LOCKED`; the status check makes a second run a
 * no-op).
 */
@Injectable()
export class ExpireApplicationsJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(ExpireApplicationsJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work(QUEUES.merchantsExpireApplications, async () => {
      const expired = await this.run(new Date());
      if (expired > 0) this.logger.log(`Expired ${expired} merchant applications`);
    });
    await this.pgBoss.boss.schedule(QUEUES.merchantsExpireApplications, EXPIRE_APPLICATIONS_CRON);
    this.logger.log(
      `Scheduled ${QUEUES.merchantsExpireApplications} (${EXPIRE_APPLICATIONS_CRON})`,
    );
  }

  /** Expires what is due; returns how many. */
  run(now: Date): Promise<number> {
    return expireMerchantApplications(this.db, { jobs: bossJobSender(this.pgBoss.boss) }, now);
  }
}
