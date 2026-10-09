import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  type OrdersPayWaitingPayload,
  ordersPayWaitingPayloadSchema,
  QUEUES,
} from '@vertex-digital/contracts';
import {
  bossJobSender,
  type Database,
  type PayOutcome,
  payWaitingOrders,
} from '@vertex-digital/db';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';

/** What one run did, for the logs and the tests. */
export interface PayWaitingResult {
  stopped: boolean;
  outcomes: { orderId: string; outcome: PayOutcome }[];
}

/**
 * `orders.pay-waiting` (S09 rule RS4, A02), `stately` per customer: pays the customer's open
 * reservations, oldest first, each in its own transaction through the order write path
 * (`payWaitingOrders`): a purchase stop ends the run, an unavailable product is skipped, changed
 * fields or a price risen past every profitable route cancel the order, and a short balance skips
 * it for the next one. Safe to run twice: each order is paid under its lock, only from
 * `awaiting_balance`, and its journal key is unique. Queued by every deposit credit, by a new
 * reservation and by `orders.waiting-sweep`.
 */
@Injectable()
export class OrdersPayWaitingJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(OrdersPayWaitingJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work<OrdersPayWaitingPayload>(QUEUES.ordersPayWaiting, async (data) => {
      const { customerId } = ordersPayWaitingPayloadSchema.parse(data);
      const result = await this.pay(customerId);
      const done = result.outcomes.filter((row) => !row.outcome.startsWith('skipped'));
      if (done.length > 0 || result.stopped) {
        this.logger.log(
          `Reservations of ${customerId}: ${done.map((row) => `${row.orderId} ${row.outcome}`).join(', ') || 'none'}${result.stopped ? '; purchases stopped' : ''}`,
        );
      }
    });
  }

  async pay(customerId: string, db: Database = this.db): Promise<PayWaitingResult> {
    return payWaitingOrders(
      db,
      {
        jobs: bossJobSender(this.pgBoss.boss),
        now: () => new Date(),
        fakeEnabled: this.env.SUPPLIER_FAKE_ENABLED,
      },
      customerId,
    );
  }
}
