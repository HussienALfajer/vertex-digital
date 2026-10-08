import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { QUEUE_POLICIES } from '@vertex-digital/contracts';
import {
  createPgBoss,
  type Transaction,
  transactionExecutor,
  withoutQueryParameters,
} from '@vertex-digital/db';
import type { PgBoss, SendOptions } from 'pg-boss';
import { ENV, type Env } from '../config/env.js';

/**
 * The API's side of pg-boss (ADR 0002, 0011): it only sends jobs, in the transaction of the change
 * that causes them; the worker works them. Started on first use, so a process that sends nothing
 * (the OpenAPI export) opens no connection. A failed start or queue creation is retried by the
 * next send instead of being kept.
 */
@Injectable()
export class JobsService implements OnApplicationShutdown {
  private readonly logger = new Logger(JobsService.name);
  private readonly boss: PgBoss;
  private started: Promise<void> | undefined;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(@Inject(ENV) env: Env) {
    this.boss = createPgBoss(env.DATABASE_URL, { supervise: false, schedule: false });
    // pg-boss reports its pool's errors as events: without a listener one would end the process.
    this.boss.on('error', (error) => {
      const reported = withoutQueryParameters(error);
      this.logger.error(reported);
      Sentry.captureException(reported);
    });
  }

  /** Sends a job inside `tx`: it exists only if the transaction commits. */
  async send(tx: Transaction, queue: string, data: object, options: SendOptions = {}) {
    await this.ready(queue);
    return this.boss.send(queue, data, { ...options, db: transactionExecutor(tx) });
  }

  private ready(queue: string): Promise<void> {
    if (!this.started) {
      this.started = this.boss.start().then(
        () => undefined,
        (error: unknown) => {
          this.started = undefined;
          throw error;
        },
      );
    }
    const started = this.started;
    let created = this.queues.get(queue);
    if (!created) {
      // The worker may not have started yet: creating an existing queue changes nothing.
      created = started
        .then(() => this.boss.createQueue(queue, { policy: QUEUE_POLICIES[queue] ?? 'standard' }))
        .catch((error: unknown) => {
          this.queues.delete(queue);
          throw error;
        });
      this.queues.set(queue, created);
    }
    return created;
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.started)
      await this.started.then(
        () => this.boss.stop({ graceful: true }),
        () => {},
      );
  }
}
