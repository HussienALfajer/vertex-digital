import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { QUEUES } from '@vertex-digital/contracts';
import {
  bossJobSender,
  type Database,
  type ProductAlertRun,
  runProductAlerts,
} from '@vertex-digital/db';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';

/** PA3: every 15 minutes at minute 7, after the supplier syncs. */
export const PRODUCT_ALERTS_CRON = '7,22,37,52 * * * *';

/**
 * `catalog.product-alerts` (S22 PA3–PA6), one run at a time (a `singleton` queue): every active
 * alert read in batches of 500 on its customer's effective list, each settled in its own short
 * transaction by `runProductAlerts` (sent once under the row lock, rebased, expired or
 * cancelled). Safe twice: a sent or ended alert is never read again.
 */
@Injectable()
export class ProductAlertsJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(ProductAlertsJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work(QUEUES.catalogProductAlerts, async () => {
      const run = await this.run(new Date());
      if (run.sent + run.rebased + run.expired + run.cancelled > 0)
        this.logger.log(
          `Product alerts: ${run.sent} sent, ${run.rebased} rebased, ${run.expired} expired, ${run.cancelled} cancelled`,
        );
    });
    await this.pgBoss.boss.schedule(QUEUES.catalogProductAlerts, PRODUCT_ALERTS_CRON);
    this.logger.log(`Scheduled ${QUEUES.catalogProductAlerts} (${PRODUCT_ALERTS_CRON})`);
  }

  run(now: Date): Promise<ProductAlertRun> {
    return runProductAlerts(
      this.db,
      { jobs: bossJobSender(this.pgBoss.boss), now, fakeEnabled: this.env.SUPPLIER_FAKE_ENABLED },
      now,
    );
  }
}
