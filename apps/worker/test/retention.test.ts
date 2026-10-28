import { existsSync } from 'node:fs';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { QUEUES } from '@vertex-digital/contracts';
import { type Database, newId, storedFiles, supplierCalls, suppliers } from '@vertex-digital/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE } from '../src/core/database/database.module.js';
import { PgBossService } from '../src/core/jobs/pg-boss.service.js';
import { PurgeSupplierLogsJob } from '../src/jobs/system/purge-supplier-logs.job.js';
import { SweepFilesJob } from '../src/jobs/system/sweep-files.job.js';
import { WorkerModule } from '../src/worker.module.js';

/*
 * Retention jobs of audit A10 (A10-45, A10-54) against the test database. The guards and the
 * database functions are tested in packages/db (`suppliers.test.ts`, `stored-files.test.ts`);
 * here the jobs' loops, the disk and the schedules. Rows these tests leave are append-only.
 */

const DAY_MS = 86_400_000;

let app: INestApplicationContext;
let db: Database;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
  app = await moduleRef.init();
  db = app.get<Database>(DATABASE);
});

afterAll(() => app.close());

describe('system.purge-supplier-logs (audit A10-54)', () => {
  it('deletes calls past 180 days and keeps younger ones', async () => {
    const [supplier] = await db
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(eq(suppliers.code, 'fazercards'));
    const call = (daysAgo: number) =>
      db
        .insert(supplierCalls)
        .values({
          id: newId(),
          supplierId: supplier?.id as string,
          operation: 'get_balance',
          result: 'ok',
          latencyMs: 10,
          createdAt: sql`now() - make_interval(days => ${daysAgo})`,
        })
        .returning({ id: supplierCalls.id })
        .then(([row]) => row?.id as string);
    const old = await call(200);
    const young = await call(170);

    const result = await app.get(PurgeSupplierLogsJob).purge();
    expect(result.calls).toBeGreaterThanOrEqual(1);
    const left = await db
      .select({ id: supplierCalls.id })
      .from(supplierCalls)
      .where(inArray(supplierCalls.id, [old, young]));
    expect(left.map((row) => row.id)).toEqual([young]);
  });

  it('is scheduled daily at 04:45 Damascus', async () => {
    expect(await app.get(PgBossService).boss.getSchedules(QUEUES.systemPurgeSupplierLogs)).toEqual([
      expect.objectContaining({ cron: '45 4 * * *', timezone: 'Asia/Damascus' }),
    ]);
  });
});

describe('system.sweep-files (audit A10-45)', () => {
  const root = () => (app.get(SweepFilesJob) as unknown as { filesRoot: string }).filesRoot;

  /** Writes a file at `key` under the files root, last modified `daysAgo` days before `now`. */
  async function onDisk(key: string, daysAgo: number, now: Date): Promise<string> {
    const path = join(root(), key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from('image'));
    const time = new Date(now.getTime() - daysAgo * DAY_MS);
    await utimes(path, time, time);
    return path;
  }

  async function row(kind: 'catalog_image' | 'deposit_receipt', daysAgo: number) {
    const id = newId();
    const storageKey = `${kind}/${id.slice(-2)}/${id}.webp`;
    await db.insert(storedFiles).values({
      id,
      kind,
      storageKey,
      contentType: 'image/webp',
      byteSize: 5,
      width: 10,
      height: 10,
      createdAt: sql`now() - make_interval(days => ${daysAgo})`,
    });
    return { id, storageKey };
  }

  it('removes old files no row names, keeps young ones and every file a row names', async () => {
    const now = new Date();
    const orphanId = newId();
    const youngId = newId();
    const orphan = await onDisk(`catalog_image/${orphanId.slice(-2)}/${orphanId}.webp`, 40, now);
    const orphanWidth = await onDisk(
      `catalog_image/${orphanId.slice(-2)}/${orphanId}.w320.webp`,
      40,
      now,
    );
    const young = await onDisk(`deposit_receipt/${youngId.slice(-2)}/${youngId}.webp`, 3, now);
    const temporary = await onDisk(
      `catalog_image/${youngId.slice(-2)}/${youngId}.w320.webp.0123456789ab.tmp`,
      2,
      now,
    );
    const receipt = await row('deposit_receipt', 400);
    const receiptFile = await onDisk(receipt.storageKey, 400, now);
    const image = await row('catalog_image', 60);
    const imageFile = await onDisk(image.storageKey, 60, now);
    const imageWidth = await onDisk(image.storageKey.replace('.webp', '.w320.webp'), 60, now);

    await app.get(SweepFilesJob).sweep(now);

    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(orphanWidth)).toBe(false);
    expect(existsSync(temporary)).toBe(false);
    expect(existsSync(young)).toBe(true);
    expect(existsSync(receiptFile)).toBe(true);
    // Unreferenced since today: marked, kept on disk for 30 days.
    expect(existsSync(imageFile)).toBe(true);
    expect(existsSync(imageWidth)).toBe(true);
    const [marked] = await db
      .select({ since: storedFiles.unreferencedSince, swept: storedFiles.sweptAt })
      .from(storedFiles)
      .where(eq(storedFiles.id, image.id));
    expect(marked?.since).not.toBeNull();
    expect(marked?.swept).toBeNull();
    const [evidence] = await db
      .select({ since: storedFiles.unreferencedSince })
      .from(storedFiles)
      .where(eq(storedFiles.id, receipt.id));
    expect(evidence?.since).toBeNull();
  });

  it('runs twice with the same result', async () => {
    await expect(app.get(SweepFilesJob).sweep()).resolves.toEqual({ swept: 0, removed: 0 });
  });

  it('is scheduled daily at 05:15 Damascus', async () => {
    expect(await app.get(PgBossService).boss.getSchedules(QUEUES.systemSweepFiles)).toEqual([
      expect.objectContaining({ cron: '15 5 * * *', timezone: 'Asia/Damascus' }),
    ]);
  });
});
