import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { QUEUE_POLICIES, QUEUES } from '@vertex-digital/contracts';
import { type Database, workerHeartbeats } from '@vertex-digital/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENV, type Env } from '../src/core/config/env.js';
import { DATABASE } from '../src/core/database/database.module.js';
import { PgBossService } from '../src/core/jobs/pg-boss.service.js';
import { UsdtScanJob } from '../src/jobs/deposits/usdt-scan.job.js';
import { UsdtVerifyJob } from '../src/jobs/deposits/usdt-verify.job.js';
import { OrdersFulfilJob } from '../src/jobs/orders/fulfil.job.js';
import { OrdersPollJob } from '../src/jobs/orders/poll.job.js';
import { OrdersSweepJob } from '../src/jobs/orders/sweep.job.js';
import { SupplierBalancesJob } from '../src/jobs/suppliers/balances.job.js';
import { SupplierHealthJob } from '../src/jobs/suppliers/health.job.js';
import { SupplierSyncJob } from '../src/jobs/suppliers/sync.job.js';
import { SupplierSyncScheduleJob } from '../src/jobs/suppliers/sync-schedule.job.js';
import { SupplierWebhookJob } from '../src/jobs/suppliers/webhook.job.js';
import { HEARTBEAT_CRON, HEARTBEAT_QUEUE, HeartbeatJob } from '../src/jobs/system/heartbeat.job.js';
import { WorkerModule } from '../src/worker.module.js';

// WORKER_NAME is unique per run (vitest.config.ts), so rows never collide between runs.

/**
 * Jobs that call a supplier or a chain, or move orders and deposits, stay idle here: the queues
 * hold what the api tests left (orders to fulfil, syncs, verifications), and working them would
 * commit supplier calls and cursors that the order, supplier and USDT tests read. Those jobs have
 * their own tests; this file proves the module boots and works a queue.
 */
const IDLE_JOBS = [
  OrdersFulfilJob,
  OrdersPollJob,
  OrdersSweepJob,
  SupplierWebhookJob,
  SupplierSyncJob,
  SupplierSyncScheduleJob,
  SupplierBalancesJob,
  SupplierHealthJob,
  UsdtScanJob,
  UsdtVerifyJob,
];
const worker = process.env.WORKER_NAME as string;

describe('worker against the test database', () => {
  let app: INestApplicationContext;
  let db: Database;

  const heartbeat = () =>
    db.select().from(workerHeartbeats).where(eq(workerHeartbeats.worker, worker));

  beforeAll(async () => {
    let builder = Test.createTestingModule({ imports: [WorkerModule] });
    for (const job of IDLE_JOBS) builder = builder.overrideProvider(job).useValue({});
    const moduleRef = await builder.compile();
    app = await moduleRef.init();
    db = app.get<Database>(DATABASE);
  });

  afterAll(async () => {
    await db.delete(workerHeartbeats).where(eq(workerHeartbeats.worker, worker));
    await app.close();
  });

  it('has every shared queue, with its policy, before any job sends to it (S09 rule RS4)', async () => {
    const { boss } = app.get(PgBossService);
    for (const queue of Object.values(QUEUES)) {
      expect(await boss.getQueue(queue), queue).toMatchObject({
        policy: QUEUE_POLICIES[queue] ?? 'standard',
      });
    }
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
