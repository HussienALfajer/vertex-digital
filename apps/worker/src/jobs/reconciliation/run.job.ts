import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  QUEUES,
  RECONCILIATION_CRON,
  REVIEW_TIME_ZONE,
  type ReconciliationRunPayload,
  reconciliationRunPayloadSchema,
} from '@vertex-digital/contracts';
import { RECONCILIATION_RUN_OPTIONS } from '@vertex-digital/db';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';
import { nightlyBusinessDate, ReconciliationRunner } from './reconciliation-runner.js';

/**
 * `reconciliation.run` (S13 rules RN1–RN5): the nightly cron at 00:30 `Asia/Damascus` sends `{}`
 * and the job names the day that ended; the API queues `{ runId }` for a manual run it created.
 * Safe twice: one nightly run per day, a finished run is not run again, results are unique per run,
 * check and subject. After its last retry the run is failed with its alert.
 */
@Injectable()
export class ReconciliationRunJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReconciliationRunJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    private readonly runner: ReconciliationRunner,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work<ReconciliationRunPayload>(QUEUES.reconciliationRun, (data, job) =>
      this.handle(data, job.retryCount),
    );
    await this.pgBoss.boss.schedule(
      QUEUES.reconciliationRun,
      RECONCILIATION_CRON,
      {},
      {
        tz: REVIEW_TIME_ZONE,
        ...RECONCILIATION_RUN_OPTIONS,
      },
    );
    this.logger.log(`Scheduled ${QUEUES.reconciliationRun} (${RECONCILIATION_CRON} Damascus)`);
  }

  async handle(data: unknown, retryCount: number, now = new Date()): Promise<void> {
    const payload = reconciliationRunPayloadSchema.parse(data);
    const runId =
      'runId' in payload
        ? payload.runId
        : await this.runner.nightlyRun(
            'businessDate' in payload ? payload.businessDate : nightlyBusinessDate(now),
            now,
          );
    if (runId === null) return;
    try {
      await this.runner.execute(runId, now);
    } catch (error) {
      // Rule RN5: retried twice by pg-boss, then the run is failed.
      if (retryCount >= RECONCILIATION_RUN_OPTIONS.retryLimit) await this.runner.fail(runId, error);
      throw error;
    }
  }
}
