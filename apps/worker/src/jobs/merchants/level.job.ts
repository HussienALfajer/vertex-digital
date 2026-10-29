import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  damascusMonth,
  type MerchantsLevelPayload,
  merchantsLevelPayloadSchema,
  previousMonth,
  QUEUES,
  REVIEW_TIME_ZONE,
  type TierChangeSource,
} from '@vertex-digital/contracts';
import {
  bossJobSender,
  customers,
  type Database,
  type LevelChange,
  recomputeMerchantLevel,
  recordTierMonth,
} from '@vertex-digital/db';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';

/** LV4: every merchant recomputed on the 1st at 00:10 `Asia/Damascus`. */
export const LEVEL_SCHEDULE_CRON = '10 0 1 * *';

/** The monthly run's merchants that failed, after every other merchant was done. */
export class LevelScheduleFailed extends Error {
  constructor(readonly customerIds: string[]) {
    super(`Merchant level schedule failed for ${customerIds.length} merchants`);
  }
}

/**
 * `merchants.level` (S21 LV3–LV5, LV7, S23 TR6): one merchant's earned and effective level,
 * recomputed in one transaction with the customer locked (`recomputeMerchantLevel`); queued after a
 * merchant's purchase, checkout or refund, after a grant and after every tier change in the panel
 * (`stately` by customer), the payload's `cause` naming a tiers change. `merchants.level-schedule`
 * runs on the 1st, when the previous month is the one that counts: each merchant in a transaction
 * of its own, recomputed then given its row of the month just ended (`recordTierMonth`, S23 PG5).
 * Safe twice: the same state writes nothing and the month's row is written once.
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
      const { customerId, cause } = merchantsLevelPayloadSchema.parse(data);
      const change = await this.recompute(customerId, new Date(), cause);
      if (change.changed)
        this.logger.log(`Merchant ${customerId} moved to level ${change.levelIdAfter}`);
    });
    await this.pgBoss.work(QUEUES.merchantsLevelSchedule, async () => {
      const recorded = await this.monthly(new Date());
      this.logger.log(`Recomputed ${recorded} merchants and recorded their month`);
    });
    await this.pgBoss.boss.schedule(
      QUEUES.merchantsLevelSchedule,
      LEVEL_SCHEDULE_CRON,
      {},
      { tz: REVIEW_TIME_ZONE },
    );
    this.logger.log(`Scheduled ${QUEUES.merchantsLevelSchedule} (${LEVEL_SCHEDULE_CRON} Damascus)`);
  }

  recompute(customerId: string, now: Date, cause?: TierChangeSource): Promise<LevelChange> {
    return this.db.transaction((tx) =>
      recomputeMerchantLevel(
        tx,
        { jobs: bossJobSender(this.pgBoss.boss), now, ...(cause ? { cause } : {}) },
        customerId,
      ),
    );
  }

  /**
   * LV4, S23 PG5: every live merchant, in id order, recomputed then given the row of the month
   * before `now`'s; a merchant that fails does not stop the others, and the run then fails naming
   * them (pg-boss retries it; the merchants done already write nothing again). Returns how many
   * merchants were done.
   */
  async monthly(now: Date): Promise<number> {
    const month = previousMonth(damascusMonth(now));
    const merchants = await this.db
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.accountType, 'merchant'), isNull(customers.archivedAt)))
      .orderBy(asc(customers.id));
    const failed: string[] = [];
    for (const { id } of merchants) {
      try {
        await this.db.transaction(async (tx) => {
          await recomputeMerchantLevel(tx, { jobs: bossJobSender(this.pgBoss.boss), now }, id);
          await recordTierMonth(tx, id, month);
        });
      } catch (error) {
        this.logger.error(`Merchant ${id} level schedule failed`, error);
        failed.push(id);
      }
    }
    if (failed.length > 0) throw new LevelScheduleFailed(failed);
    return merchants.length;
  }
}
