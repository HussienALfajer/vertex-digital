import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { QUEUES } from '@vertex-digital/contracts';
import { bossJobSender, type Database, expireCashHolds } from '@vertex-digital/db';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';

/** Every 5 minutes (S25 CS5). */
export const CASH_HOLD_EXPIRY_CRON = '*/5 * * * *';

/** Holds refunded per run, oldest first; the next run takes the rest. */
export const CASH_HOLD_EXPIRY_BATCH = 100;

/**
 * `orders.cash-hold-expiry` (S25 CS5): refunds held cash orders undecided past the policy's hours
 * through `expireCashHolds` (`packages/db`): each in its own transaction, `FOR UPDATE SKIP LOCKED`,
 * with its refund journal, audit entry and refund notice. Safe to run twice: the hold's guard
 * refuses an order the admin or an earlier run decided.
 */
@Injectable()
export class OrdersCashHoldExpiryJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(OrdersCashHoldExpiryJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work(QUEUES.ordersCashHoldExpiry, async () => {
      const expired = await this.expire();
      if (expired.length > 0) this.logger.log(`Refunded ${expired.length} expired cash holds`);
    });
    await this.pgBoss.boss.schedule(QUEUES.ordersCashHoldExpiry, CASH_HOLD_EXPIRY_CRON);
    this.logger.log(`Scheduled ${QUEUES.ordersCashHoldExpiry} (${CASH_HOLD_EXPIRY_CRON})`);
  }

  /** The orders refunded. */
  expire(): Promise<string[]> {
    return expireCashHolds(
      this.db,
      { jobs: bossJobSender(this.pgBoss.boss) },
      CASH_HOLD_EXPIRY_BATCH,
    );
  }
}
