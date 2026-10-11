import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import {
  QUEUES,
  type ReconciliationRecheckPayload,
  reconciliationRecheckPayloadSchema,
} from '@vertex-digital/contracts';
import { RECONCILIATION_RUN_OPTIONS } from '@vertex-digital/db';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';
import { ReconciliationRunner } from './reconciliation-runner.js';

/**
 * `reconciliation.recheck` (S13 rule RN4), one per run at its `recheck_at`: the external checks
 * that were off are read again, their results stored, the run finished and its alert queued.
 * After its last retry the run is failed.
 */
@Injectable()
export class ReconciliationRecheckJob implements OnApplicationBootstrap {
  constructor(
    private readonly pgBoss: PgBossService,
    private readonly runner: ReconciliationRunner,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work<ReconciliationRecheckPayload>(
      QUEUES.reconciliationRecheck,
      (data, job) => this.handle(data, job.retryCount),
    );
  }

  async handle(data: unknown, retryCount: number): Promise<void> {
    const { runId } = reconciliationRecheckPayloadSchema.parse(data);
    try {
      await this.runner.recheck(runId);
    } catch (error) {
      if (retryCount >= RECONCILIATION_RUN_OPTIONS.retryLimit) await this.runner.fail(runId, error);
      throw error;
    }
  }
}
