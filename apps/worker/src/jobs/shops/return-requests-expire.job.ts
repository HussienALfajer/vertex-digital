import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { QUEUES } from '@vertex-digital/contracts';
import { bossJobSender, type Database, expireShopReturns } from '@vertex-digital/db';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';

export const RETURN_REQUESTS_EXPIRE_CRON = '*/10 * * * *';

/**
 * `shop.return-requests-expire` (S26 WL5), every 10 minutes: pending return requests past their
 * 24 hours become `expired`, each in its own transaction under the shop's lock, with the audit
 * entry (the system) and the merchant's notice, through `expireShopReturns` (a request ended
 * meanwhile is passed over, so a second run is a no-op).
 */
@Injectable()
export class ReturnRequestsExpireJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReturnRequestsExpireJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work(QUEUES.shopReturnRequestsExpire, async () => {
      const expired = await this.run();
      if (expired.length > 0) this.logger.log(`Expired ${expired.length} shop return requests`);
    });
    await this.pgBoss.boss.schedule(QUEUES.shopReturnRequestsExpire, RETURN_REQUESTS_EXPIRE_CRON);
    this.logger.log(
      `Scheduled ${QUEUES.shopReturnRequestsExpire} (${RETURN_REQUESTS_EXPIRE_CRON})`,
    );
  }

  /** Expires what is due; returns the requests' ids. */
  run(): Promise<string[]> {
    return expireShopReturns(this.db, bossJobSender(this.pgBoss.boss));
  }
}
