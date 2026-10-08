import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { QUEUES } from '@vertex-digital/contracts';
import { auditEntries, customers, type Database, deposits, newId } from '@vertex-digital/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE } from '../src/core/database/database.module.js';
import { PgBossService } from '../src/core/jobs/pg-boss.service.js';
import { EXPIRE_BATCH_SIZE, ExpireDepositsJob } from '../src/jobs/deposits/expire.job.js';
import { WorkerModule } from '../src/worker.module.js';

/*
 * `deposits.expire` (S03 rule SC12) against the test database. Deposits are never deleted, so
 * the rows written here stay; each test uses new customers.
 */

let app: INestApplicationContext;
let db: Database;
let job: ExpireDepositsJob;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
  app = await moduleRef.init();
  db = app.get<Database>(DATABASE);
  job = app.get(ExpireDepositsJob);
});

afterAll(() => app.close());

/** A pending USD deposit of a new customer, overdue by default. */
async function pendingDeposit(overdue = true): Promise<string> {
  const customerId = newId();
  await db.insert(customers).values({
    id: customerId,
    name: 'Test',
    email: `${customerId}@test.vertex-digital.local`,
    phone: '+963900000000',
  });
  const id = newId();
  const code = Array.from(
    { length: 5 },
    () => '23456789ABCDEFGHJKMNPQRSTUVWXYZ'[Math.floor(Math.random() * 31)],
  ).join('');
  await db.insert(deposits).values({
    id,
    customerId,
    method: 'sham_cash',
    referenceCode: `VD-${code}`,
    currency: 'USD',
    declaredAmountUnits: 5_000_000,
    declaredUsdUnits: 5_000_000,
    expiresAt: overdue ? sql`now() - interval '1 minute'` : sql`now() + interval '1 hour'`,
    idempotencyKey: newId(),
  });
  return id;
}

const statusOf = async (ids: string[]) =>
  (
    await db
      .select({ id: deposits.id, status: deposits.status })
      .from(deposits)
      .where(inArray(deposits.id, ids))
  )
    .sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
    .map((row) => row.status);

describe('deposits.expire (rule SC12)', () => {
  it('expires overdue pending deposits only, with an audit entry each, and is a no-op twice', async () => {
    const overdue = await pendingDeposit();
    const open = await pendingDeposit(false);
    expect(await job.expire()).toBeGreaterThanOrEqual(1);
    expect(await statusOf([overdue, open])).toEqual(['expired', 'pending']);
    const entries = await db
      .select()
      .from(auditEntries)
      .where(and(eq(auditEntries.entityId, overdue), eq(auditEntries.action, 'deposit.expired')));
    expect(entries).toEqual([
      expect.objectContaining({
        actorKind: 'system',
        actorId: null,
        channel: 'worker',
        details: { depositId: overdue },
      }),
    ]);
    await job.expire();
    const again = await db
      .select()
      .from(auditEntries)
      .where(and(eq(auditEntries.entityId, overdue), eq(auditEntries.action, 'deposit.expired')));
    expect(again).toHaveLength(1);
  });

  it('works through more than one batch', async () => {
    const ids: string[] = [];
    for (let count = 0; count < EXPIRE_BATCH_SIZE + 5; count += 1) ids.push(await pendingDeposit());
    expect(await job.expire()).toBeGreaterThanOrEqual(EXPIRE_BATCH_SIZE + 5);
    expect(new Set(await statusOf(ids))).toEqual(new Set(['expired']));
  });

  it('skips a deposit locked by a submission, which then decides', async () => {
    const locked = await pendingDeposit();
    const other = await pendingDeposit();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lockTaken: () => void = () => {};
    const taken = new Promise<void>((resolve) => {
      lockTaken = resolve;
    });
    const submission = db.transaction(async (tx) => {
      await tx.select().from(deposits).where(eq(deposits.id, locked)).for('update');
      lockTaken();
      await held;
      await tx
        .update(deposits)
        .set({ status: 'submitted', submittedAt: sql`now()` })
        .where(eq(deposits.id, locked));
    });
    await taken;
    await job.expire();
    expect(await statusOf([locked, other])).toEqual(['pending', 'expired']);
    release();
    await submission;
    await job.expire();
    expect(await statusOf([locked])).toEqual(['submitted']);
  });

  it('is scheduled every 5 minutes', async () => {
    expect(await app.get(PgBossService).boss.getSchedules(QUEUES.depositsExpire)).toEqual([
      expect.objectContaining({ cron: '*/5 * * * *' }),
    ]);
  });
});
