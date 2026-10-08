import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { QUEUES, type SuppliersSyncPayload, supplierHasCatalog } from '@vertex-digital/contracts';
import { type Database, supplierStates, type Transaction } from '@vertex-digital/db';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';

/** Every 15 minutes (ADR 0021). */
export const SUPPLIERS_SYNC_CRON = '*/15 * * * *';

/**
 * `suppliers.sync-schedule` (S07 rule SY1): a `schedule` sync for each configured, available
 * supplier with a catalog, paused ones included (SP3). A supplier already syncing ends the new
 * job at once (the running-run index).
 */
@Injectable()
export class SupplierSyncScheduleJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(SupplierSyncScheduleJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work(QUEUES.suppliersSyncSchedule, async () => {
      await this.enqueue();
    });
    await this.pgBoss.boss.schedule(QUEUES.suppliersSyncSchedule, SUPPLIERS_SYNC_CRON);
    this.logger.log(`Scheduled ${QUEUES.suppliersSyncSchedule} (${SUPPLIERS_SYNC_CRON})`);
  }

  /** The payloads queued. */
  async enqueue(db: Database | Transaction = this.db): Promise<SuppliersSyncPayload[]> {
    const states = await supplierStates(db, { fakeEnabled: this.env.SUPPLIER_FAKE_ENABLED });
    const due = states
      .filter((state) => state.configured && state.available && supplierHasCatalog(state.code))
      .map(
        (state): SuppliersSyncPayload => ({
          supplierId: state.id,
          supplierCode: state.code,
          trigger: 'schedule',
        }),
      );
    for (const payload of due) {
      // No retry: the next schedule is the retry (S07 "Jobs and integrations").
      await this.pgBoss.boss.send(QUEUES.suppliersSync, payload, { retryLimit: 0 });
    }
    return due;
  }
}
