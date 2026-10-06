import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { type Database, workerHeartbeats } from '@vertex-digital/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENV, type Env } from '../src/core/config/env.js';
import { DATABASE } from '../src/core/database/database.module.js';
import { PgBossService } from '../src/core/jobs/pg-boss.service.js';
import { HEARTBEAT_CRON, HEARTBEAT_QUEUE, HeartbeatJob } from '../src/jobs/system/heartbeat.job.js';
import { WorkerModule } from '../src/worker.module.js';

// WORKER_NAME is unique per run (vitest.config.ts), so rows never collide between runs.
const worker = process.env.WORKER_NAME as string;

describe('worker against the test database', () => {
  let app: INestApplicationContext;
  let db: Database;

  const heartbeat = () =>
    db.select().from(workerHeartbeats).where(eq(workerHeartbeats.worker, worker));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    app = await moduleRef.init();
    db = app.get<Database>(DATABASE);
  });

  afterAll(async () => {
    await db.delete(workerHeartbeats).where(eq(workerHeartbeats.worker, worker));
    await app.close();
  });

  it('schedules the heartbeat once however often it boots', async () => {
    const { boss } = app.get(PgBossService);
    await boss.schedule(HEARTBEAT_QUEUE, HEARTBEAT_CRON);
    expect(await boss.getSchedules(HEARTBEAT_QUEUE)).toEqual([
      expect.objectContaining({ cron: HEARTBEAT_CRON }),
    ]);
  });

  it('beats idempotently: repeated runs keep one row with the latest time', async () => {
    // A name of its own: the live schedule would overwrite the fixed times of `worker`'s row.
    const name = `${worker}-idempotent`;
    const job = new HeartbeatJob(app.get(PgBossService), db, {
      ...app.get<Env>(ENV),
      WORKER_NAME: name,
    });
    try {
      await job.beat(new Date('2026-10-07T10:00:00.000Z'));
      await job.beat(new Date('2026-10-07T10:01:00.000Z'));
      expect(
        await db.select().from(workerHeartbeats).where(eq(workerHeartbeats.worker, name)),
      ).toEqual([{ worker: name, beatAt: new Date('2026-10-07T10:01:00.000Z') }]);
    } finally {
      await db.delete(workerHeartbeats).where(eq(workerHeartbeats.worker, name));
    }
  });

  it('processes a queued heartbeat job', async () => {
    const before = Date.now();
    await app.get(PgBossService).boss.send(HEARTBEAT_QUEUE, {});
    await expect
      .poll(async () => (await heartbeat())[0]?.beatAt.getTime() ?? 0, { timeout: 15_000 })
      .toBeGreaterThanOrEqual(before - 1_000);
  });
});
