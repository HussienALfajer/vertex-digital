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
    if ('runId' in payload) return this.execute(payload.runId, retryCount, now);
    const businessDate =
      'businessDate' in payload ? payload.businessDate : nightlyBusinessDate(now);
    const night = await this.runner.nightlyRun(businessDate, now);
    if (night === null) return;
    if (typeof night === 'string') return this.execute(night, retryCount, now);
    // Another run is running (a manual run may wait 10 minutes for its recheck): the night's
    // run is sent again for later, never lost (RN1); a stale blocker is failed after an hour.
    await this.pgBoss.boss.send(
      QUEUES.reconciliationRun,
      { businessDate },
      { ...RECONCILIATION_RUN_OPTIONS, startAfter: night.retryAt },
    );
    this.logger.log(
      `Night ${businessDate} waits for a running run until ${night.retryAt.toISOString()}`,
    );
  }

  private async execute(runId: string, retryCount: number, now: Date): Promise<void> {
    try {
      await this.runner.execute(runId, now);
    } catch (error) {
      // Rule RN5: retried twice by pg-boss, then the run is failed.
      if (retryCount >= RECONCILIATION_RUN_OPTIONS.retryLimit) await this.runner.fail(runId, error);
      throw error;
    }
  }
}
