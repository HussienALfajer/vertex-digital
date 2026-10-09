import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { QUEUES } from '@vertex-digital/contracts';
import {
  bossJobSender,
  customersWithReservations,
  type Database,
  queuePayWaiting,
  type Transaction,
} from '@vertex-digital/db';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';

/** Every 5 minutes (S09 rule RS4). */
export const ORDERS_WAITING_SWEEP_CRON = '*/5 * * * *';

/** At most this many customers per run, oldest reservation first; the next run takes the rest. */
export const WAITING_SWEEP_BATCH = 500;

/**
 * `orders.waiting-sweep` (S09 rule RS4, edge case 11): queues `orders.pay-waiting` for each
 * customer with an open, unexpired reservation, so a product back in stock or a credit whose job
 * was lost still pays it. The paying job is `stately` per customer: one already queued makes this
 * a no-op.
 */
@Injectable()
export class OrdersWaitingSweepJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(OrdersWaitingSweepJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work(QUEUES.ordersWaitingSweep, async () => {
      const queued = await this.sweep();
      if (queued.length > 0) this.logger.log(`Queued payment of ${queued.length} customers`);
    });
    await this.pgBoss.boss.schedule(QUEUES.ordersWaitingSweep, ORDERS_WAITING_SWEEP_CRON);
    this.logger.log(`Scheduled ${QUEUES.ordersWaitingSweep} (${ORDERS_WAITING_SWEEP_CRON})`);
  }

  /** The customers queued. */
  async sweep(db: Database | Transaction = this.db): Promise<string[]> {
    const due = await customersWithReservations(db as Database, WAITING_SWEEP_BATCH);
    if (due.length === 0) return [];
    await db.transaction(async (tx) => {
      for (const customerId of due) {
        await queuePayWaiting(tx, bossJobSender(this.pgBoss.boss), customerId);
      }
    });
    return due;
  }
}
