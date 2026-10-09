import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { QUEUE_POLICIES, QUEUES } from '@vertex-digital/contracts';
import { createPgBoss, withoutQueryParameters } from '@vertex-digital/db';
import type { PgBoss } from 'pg-boss';
import { TelegramAlerts } from '../alerts/telegram-alerts.js';
import { ENV, type Env } from '../config/env.js';

/**
 * Owns the pg-boss instance (the app role: no schema changes, ADR 0014), started before the jobs
 * register and stopped gracefully on shutdown. Jobs register through `work`, which reports a
 * failure to the logs, Sentry and the admin alert channel before pg-boss retries it.
 */
@Injectable()
export class PgBossService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PgBossService.name);
  readonly boss: PgBoss;

  constructor(
    @Inject(ENV) env: Env,
    private readonly alerts: TelegramAlerts,
  ) {
    this.boss = createPgBoss(env.DATABASE_URL);
    this.boss.on('error', (error) => {
      this.logger.error(error);
      Sentry.captureException(error);
      void this.alerts.send(`pg-boss error: ${error.message}`);
    });
  }

  async onModuleInit(): Promise<void> {
    await this.boss.start();
    // Every shared queue exists before any job sends to it, worked here or not yet (a job in a
    // credit's transaction must never fail on a missing queue, S09 rule RS4). Creating an
    // existing queue changes nothing.
    for (const queue of Object.values(QUEUES)) {
      await this.boss.createQueue(queue, { policy: QUEUE_POLICIES[queue] ?? 'standard' });
    }
    this.logger.log('pg-boss started');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.boss.stop({ graceful: true });
  }

  /**
   * Creates `queue` and works it with `handler`, one job at a time. The handler must be
   * idempotent: pg-boss retries a job that throws.
   */
  async work<T extends object>(queue: string, handler: (data: T) => Promise<void>): Promise<void> {
    await this.boss.createQueue(queue, { policy: QUEUE_POLICIES[queue] ?? 'standard' });
    await this.boss.work<T>(queue, async ([job]) => {
      if (!job) return;
      try {
        await handler(job.data);
      } catch (error) {
        // Never a query's parameters (codes, emails) in the logs, Sentry or the alert channel.
        const reported = withoutQueryParameters(error) as Error;
        this.logger.error(reported, `Job ${queue} ${job.id} failed`);
        Sentry.captureException(reported);
        await this.alerts.send(`Job ${queue} failed: ${reported.message}`);
        throw error;
      }
    });
  }
}
