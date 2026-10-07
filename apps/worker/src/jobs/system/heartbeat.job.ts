import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { type Database, workerHeartbeats } from '@vertex-digital/db';
import { ENV, type Env } from '../../core/config/env.js';
import { DATABASE } from '../../core/database/database.module.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';

export const HEARTBEAT_QUEUE = 'system.heartbeat';
export const HEARTBEAT_CRON = '* * * * *';

/**
 * Records that this worker is alive, once a minute, for the deploy health check and the admin
 * dashboard. The pattern for every job: a queue constant, registration on bootstrap, and an
 * idempotent handler (an upsert: running it twice leaves one row).
 */
@Injectable()
export class HeartbeatJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(HeartbeatJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work(HEARTBEAT_QUEUE, () => this.beat());
    await this.pgBoss.boss.schedule(HEARTBEAT_QUEUE, HEARTBEAT_CRON);
    this.logger.log(`Scheduled ${HEARTBEAT_QUEUE} (${HEARTBEAT_CRON})`);
  }

  async beat(now = new Date()): Promise<void> {
    await this.db
      .insert(workerHeartbeats)
      .values({ worker: this.env.WORKER_NAME, beatAt: now })
      .onConflictDoUpdate({ target: workerHeartbeats.worker, set: { beatAt: now } });
  }
}
