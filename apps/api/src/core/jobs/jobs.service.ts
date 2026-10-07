import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { createPgBoss, type Transaction, transactionExecutor } from '@vertex-digital/db';
import type { PgBoss, SendOptions } from 'pg-boss';
import { ENV, type Env } from '../config/env.js';

/**
 * The API's side of pg-boss (ADR 0002, 0011): it only sends jobs, in the transaction of the change
 * that causes them; the worker works them. Started on first use, so a process that sends nothing
 * (the OpenAPI export) opens no connection.
 */
@Injectable()
export class JobsService implements OnApplicationShutdown {
  private readonly boss: PgBoss;
  private started: Promise<void> | undefined;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(@Inject(ENV) env: Env) {
    this.boss = createPgBoss(env.DATABASE_URL, { supervise: false, schedule: false });
  }

  /** Sends a job inside `tx`: it exists only if the transaction commits. */
  async send(tx: Transaction, queue: string, data: object, options: SendOptions = {}) {
    await this.ready(queue);
    return this.boss.send(queue, data, { ...options, db: transactionExecutor(tx) });
  }

  private ready(queue: string): Promise<void> {
    this.started ??= this.boss.start().then(() => undefined);
    let created = this.queues.get(queue);
    if (!created) {
      // The worker may not have started yet: creating an existing queue changes nothing.
      created = this.started.then(() => this.boss.createQueue(queue));
      this.queues.set(queue, created);
    }
    return created;
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.started) await this.boss.stop({ graceful: true });
  }
}
