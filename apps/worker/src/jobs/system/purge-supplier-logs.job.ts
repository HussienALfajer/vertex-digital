import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { QUEUES, REVIEW_TIME_ZONE } from '@vertex-digital/contracts';
import type { Database } from '@vertex-digital/db';
import { sql } from 'drizzle-orm';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';

export const PURGE_SUPPLIER_LOGS_CRON = '45 4 * * *';

/** Rows of each table deleted per statement. */
export const PURGE_SUPPLIER_LOGS_BATCH = 5_000;

/**
 * `system.purge-supplier-logs` (audit A10-54), daily at 04:45 Damascus: supplier calls and balance
 * reads older than 180 days are deleted by `purge_supplier_logs` (migration 0103), the only path
 * past their append-only guard. The function keeps the calls a `down` supplier's probe still reads
 * and each supplier's newest balance read per currency; the 180 days are the guard's own floor. In
 * batches, each its own statement; safe to run twice.
 */
@Injectable()
export class PurgeSupplierLogsJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(PurgeSupplierLogsJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work(QUEUES.systemPurgeSupplierLogs, async () => {
      const { calls, balanceReads } = await this.purge();
      if (calls + balanceReads > 0) {
        this.logger.log(`Deleted ${calls} old supplier calls and ${balanceReads} balance reads`);
      }
    });
    await this.pgBoss.boss.schedule(
      QUEUES.systemPurgeSupplierLogs,
      PURGE_SUPPLIER_LOGS_CRON,
      undefined,
      { tz: REVIEW_TIME_ZONE },
    );
    this.logger.log(
      `Scheduled ${QUEUES.systemPurgeSupplierLogs} (${PURGE_SUPPLIER_LOGS_CRON} Damascus)`,
    );
  }

  /** Deletes every row past the retention; how many of each. */
  async purge(): Promise<{ calls: number; balanceReads: number }> {
    let calls = 0;
    let balanceReads = 0;
    for (;;) {
      const { rows } = await this.db.execute<{ calls: number; balance_reads: number }>(
        sql`select calls, balance_reads from purge_supplier_logs(${PURGE_SUPPLIER_LOGS_BATCH})`,
      );
      const batch = rows[0] ?? { calls: 0, balance_reads: 0 };
      calls += batch.calls;
      balanceReads += batch.balance_reads;
      if (
        batch.calls < PURGE_SUPPLIER_LOGS_BATCH &&
        batch.balance_reads < PURGE_SUPPLIER_LOGS_BATCH
      ) {
        break;
      }
    }
    return { calls, balanceReads };
  }
}
