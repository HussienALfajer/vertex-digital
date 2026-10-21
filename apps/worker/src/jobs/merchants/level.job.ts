import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  type MerchantsLevelPayload,
  merchantsLevelPayloadSchema,
  QUEUES,
  REVIEW_TIME_ZONE,
} from '@vertex-digital/contracts';
import {
  bossJobSender,
  type Database,
  type LevelChange,
  queueAllMerchantLevels,
  recomputeMerchantLevel,
} from '@vertex-digital/db';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';

/** LV4: every merchant recomputed on the 1st at 00:10 `Asia/Damascus`. */
export const LEVEL_SCHEDULE_CRON = '10 0 1 * *';

/**
 * `merchants.level` (S21 LV3–LV5, LV7): one merchant's volume level, recomputed in one transaction
 * with the customer locked (`recomputeMerchantLevel`); queued after a merchant's purchase,
 * checkout or refund, after a grant and after every level change in the panel (`stately` by
 * customer). `merchants.level-schedule` queues every merchant on the 1st, when the previous month
 * is the one that counts. Safe twice: the same state writes nothing.
 */
@Injectable()
export class MerchantLevelJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(MerchantLevelJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work<MerchantsLevelPayload>(QUEUES.merchantsLevel, async (data) => {
      const { customerId } = merchantsLevelPayloadSchema.parse(data);
      const change = await this.recompute(customerId, new Date());
      if (change.changed)
        this.logger.log(`Merchant ${customerId} moved to level ${change.levelIdAfter}`);
    });
    await this.pgBoss.work(QUEUES.merchantsLevelSchedule, async () => {
      const queued = await this.queueAll();
      this.logger.log(`Queued ${queued} merchant level recomputations`);
    });
    await this.pgBoss.boss.schedule(
      QUEUES.merchantsLevelSchedule,
      LEVEL_SCHEDULE_CRON,
      {},
      { tz: REVIEW_TIME_ZONE },
    );
    this.logger.log(`Scheduled ${QUEUES.merchantsLevelSchedule} (${LEVEL_SCHEDULE_CRON} Damascus)`);
  }

  recompute(customerId: string, now: Date): Promise<LevelChange> {
    return this.db.transaction((tx) =>
      recomputeMerchantLevel(tx, { jobs: bossJobSender(this.pgBoss.boss), now }, customerId),
    );
  }

  queueAll(): Promise<number> {
    return this.db.transaction((tx) => queueAllMerchantLevels(tx, bossJobSender(this.pgBoss.boss)));
  }
}
