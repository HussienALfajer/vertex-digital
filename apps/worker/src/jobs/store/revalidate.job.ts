import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  QUEUES,
  STORE_CACHE_TAGS,
  STORE_REVALIDATE_RETRIES,
  type StoreCacheTag,
} from '@vertex-digital/contracts';
import { ENV, type Env } from '../../core/config/env.js';
import { PgBossService } from '../../core/jobs/pg-boss.service.js';

/** The store's answer must arrive within this (S09 "Jobs and integrations"). */
export const STORE_REVALIDATE_TIMEOUT_MS = 5_000;

/**
 * `store.revalidate` (S09 rule SF4), a `singleton` queue sent at most once per 10 seconds: asks
 * the store, on `127.0.0.1:<STORE_PORT>` and never through the public host, to refresh its cached
 * catalog pages, with `STORE_REVALIDATE_SECRET` as the bearer token. A failure (the store
 * restarting, a timeout, any answer but 204) is retried by pg-boss, then only logged as a warning:
 * the pages' 5-minute cache life is the fallback, so it raises no alert.
 */
@Injectable()
export class StoreRevalidateJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(StoreRevalidateJob.name);

  constructor(
    private readonly pgBoss: PgBossService,
    @Inject(ENV) private readonly env: Pick<Env, 'STORE_PORT' | 'STORE_REVALIDATE_SECRET'>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.pgBoss.work(
      QUEUES.storeRevalidate,
      async (data: { tag?: unknown }, job) => {
        const tag = STORE_CACHE_TAGS.find((known) => known === data.tag);
        await this.handle(job.retryCount, tag);
      },
      { alert: false },
    );
  }

  /**
   * One run: true when the store refreshed. A failure throws while retries are left (pg-boss
   * retries it), and on the last attempt is logged and dropped.
   */
  async handle(retryCount: number, tag?: StoreCacheTag): Promise<boolean> {
    try {
      await this.revalidate(tag);
      return true;
    } catch (error) {
      if (retryCount < STORE_REVALIDATE_RETRIES) throw error;
      this.logger.warn(
        `The store did not refresh its catalog pages after ${retryCount + 1} attempts: ${(error as Error).message}; they refresh within 5 minutes`,
      );
      return false;
    }
  }

  /** The store expires `tag`, or both tags for a job that names none (audit A10-16). */
  private async revalidate(tag?: StoreCacheTag): Promise<void> {
    const response = await fetch(`http://127.0.0.1:${this.env.STORE_PORT}/_internal/revalidate`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.env.STORE_REVALIDATE_SECRET}`,
        ...(tag && { 'content-type': 'application/json' }),
      },
      ...(tag && { body: JSON.stringify({ tag }) }),
      signal: AbortSignal.timeout(STORE_REVALIDATE_TIMEOUT_MS),
    });
    await response.body?.cancel();
    if (response.status !== 204) throw new Error(`The store answered ${response.status}`);
  }
}
