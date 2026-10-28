import { randomBytes } from 'node:crypto';
import {
  CURRENCY_SCALE,
  INTERNAL_CHECKS,
  QUEUES,
  type TelegramMessageParams,
  tronAddressFromHex,
  type UsdtMethod,
} from '@vertex-digital/contracts';
import {
  createDatabase,
  type Database,
  newId,
  openingRecorded,
  orderEvents,
  orders,
  placeBooks,
  reconciliationResults,
  reconciliationRuns,
  recordMovement,
  supplierCredentials,
  suppliers,
  type Transaction,
  telegramMessages,
} from '@vertex-digital/db';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { parseEnv } from '../src/core/config/env.js';
import type { PgBossService } from '../src/core/jobs/pg-boss.service.js';
import { ChainReaderError, type ChainReaders } from '../src/jobs/deposits/chain/chain-reader.js';
import {
  nightlyBusinessDate,
  ReconciliationRunner,
} from '../src/jobs/reconciliation/reconciliation-runner.js';
import { ReconciliationRunJob } from '../src/jobs/reconciliation/run.job.js';
import type { BalanceOutcome, SupplierBalancesJob } from '../src/jobs/suppliers/balances.job.js';
import type { SupplierRegistry } from '../src/suppliers/supplier-registry.js';

/*
 * The reconciliation jobs (S13 rules RN1–RN5, E2–E5, NT1) against the test database, each test in
 * a rolled-back transaction: the runner works on the transaction, the supplier read and the chain
 * reader are scripted, pg-boss is stubbed. The test database holds every other suite's ledger, so
 * balances are scripted from the books the transaction reads, and assertions name their check
 * and subject.
 */

const connection = createDatabase(process.env.DATABASE_URL as string);
const { db } = connection;
afterAll(() => connection.close());

const USD = CURRENCY_SCALE.USD;
const env = parseEnv();
const TRON = tronAddressFromHex(randomBytes(20).toString('hex')) as string;
const BSC = `0x${randomBytes(20).toString('hex')}`;
const actor = { adminId: newId(), ipAddress: null, userAgent: null };

interface Sent {
  queue: string;
  data: Record<string, unknown>;
  options: Record<string, unknown>;
}
const sent: Sent[] = [];
const pgBoss = {
  boss: {
    send: async (queue: string, data: Record<string, unknown>, options = {}) => {
      sent.push({ queue, data, options });
      return newId();
    },
  },
} as unknown as PgBossService;

/** What the scripted reads answer: a supplier outcome, a raw USDT balance or an error. */
let supplierOutcome: BalanceOutcome = null;
const usdtRead: Record<UsdtMethod, bigint | Error> = { usdt_trc20: 0n, usdt_bep20: 0n };
const balances = {
  read: async (_db: unknown, supplier: { code: string }) =>
    supplier.code === 'fake' ? supplierOutcome : null,
} as unknown as SupplierBalancesJob;
const reader = (method: UsdtMethod) => ({
  method,
  getTransfer: async () => ({ status: 'not_found' as const }),
  listIncoming: async () => ({ transfers: [], cursor: '0', caughtUp: true }),
  getUsdtBalance: async () => {
    const answer = usdtRead[method];
    if (answer instanceof Error) throw answer;
    return answer;
  },
});
const readers: ChainReaders = {
  usdt_trc20: reader('usdt_trc20'),
  usdt_bep20: reader('usdt_bep20'),
};

/** S18 RC1: the fake supplier's statement of orders, page by page, or an error. */
interface ScriptedOrder {
  supplierOrderId: string;
  status?: string;
  total?: { currency: 'USD'; amountUnits: number };
  createdAt?: Date;
}
let supplierOrders: ScriptedOrder[][] | Error = [[]];
const statementPages: number[] = [];
const registry = {
  connect: async (_db: unknown, supplier: { code: string }) =>
    supplier.code === 'fake'
      ? {
          secrets: [],
          adapter: {
            capabilities: { statement: true },
            listOrders: async (page: number) => {
              statementPages.push(page);
              if (supplierOrders instanceof Error) throw supplierOrders;
              const items = supplierOrders[page - 1] ?? [];
              return { items, hasMore: page < supplierOrders.length };
            },
          },
        }
      : null,
} as unknown as SupplierRegistry;

beforeEach(() => {
  sent.length = 0;
  supplierOutcome = null;
  supplierOrders = [[]];
  statementPages.length = 0;
  usdtRead.usdt_trc20 = 0n;
  usdtRead.usdt_bep20 = 0n;
});

class Rollback extends Error {}

/**
 * `work` with a runner on a transaction that is rolled back. Runs left running by other suites
 * are failed first (one running run at a time), the fake supplier gets credentials (configured),
 * and the fake supplier and TRC20 places get an opening when they have none.
 */
async function inRollback(
  work: (context: { tx: Transaction; runner: ReconciliationRunner }) => Promise<void>,
): Promise<void> {
  await db
    .transaction(async (tx) => {
      await tx
        .update(reconciliationRuns)
        .set({ status: 'failed', finishedAt: new Date(), recheckAt: null, failure: 'Test' })
        .where(eq(reconciliationRuns.status, 'running'));
      const [fake] = await tx
        .select({ id: suppliers.id })
        .from(suppliers)
        .where(eq(suppliers.code, 'fake'));
      if (!fake) throw new Error('No fake supplier');
      await tx.insert(supplierCredentials).values({
        id: newId(),
        supplierId: fake.id,
        ciphertext: Buffer.from([0]),
        hints: {},
        adminId: actor.adminId,
      });
      for (const place of ['supplier:fake', 'usdt_trc20'] as const) {
        if (await openingRecorded(tx, place)) continue;
        await recordMovement(
          tx,
          {
            idempotencyKey: newId(),
            kind: 'transfer',
            from: 'outside_usd',
            to: place,
            sentUnits: 100 * USD,
            receivedUnits: 100 * USD,
            outsideCategory: 'owner',
            openingBalance: true,
            orderId: null,
            externalReference: null,
            reason: 'Reconciliation test opening',
          },
          actor,
        );
      }
      const runner = new ReconciliationRunner(
        pgBoss,
        balances,
        registry,
        readers,
        tx as unknown as Database,
        {
          ...env,
          SUPPLIER_FAKE_ENABLED: true,
          USDT_TRC20_ADDRESS: TRON,
          USDT_BEP20_ADDRESS: BSC,
        },
      );
      await work({ tx, runner });
      throw new Rollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });
}

/** The supplier answers `books + offset` dollars; TRC20 holds `books + offset` too. */
async function script(
  tx: Transaction,
  offsets: { supplier?: number; trc20?: number } = {},
): Promise<{ supplierBooks: number; trc20Books: number }> {
  const supplierBooks = await placeBooks(tx, 'supplier:fake');
  const trc20Books = await placeBooks(tx, 'usdt_trc20');
  supplierOutcome = {
    ok: true,
    balance: { currency: 'USD', amountUnits: supplierBooks + (offsets.supplier ?? 0) },
  };
  // TRC20 USDT has 6 decimals: raw units are USD units.
  usdtRead.usdt_trc20 = BigInt(trc20Books + (offsets.trc20 ?? 0));
  return { supplierBooks, trc20Books };
}

async function manualRun(tx: Transaction): Promise<string> {
  const [run] = await tx
    .insert(reconciliationRuns)
    .values({ trigger: 'manual', adminId: actor.adminId })
    .returning({ id: reconciliationRuns.id });
  if (!run) throw new Error('No run');
  return run.id;
}

const runOf = async (tx: Transaction, id: string) => {
  const [run] = await tx.select().from(reconciliationRuns).where(eq(reconciliationRuns.id, id));
  return run;
};

const resultsOf = (tx: Transaction, id: string) =>
  tx
    .select()
    .from(reconciliationResults)
    .where(eq(reconciliationResults.runId, id))
    .orderBy(asc(reconciliationResults.createdAt));

async function resultOf(tx: Transaction, id: string, check: string, subject: string) {
  return (await resultsOf(tx, id)).find((row) => row.check === check && row.subject === subject);
}

async function alertOf(tx: Transaction, runId: string) {
  const [row] = await tx
    .select()
    .from(telegramMessages)
    .where(eq(telegramMessages.dedupeKey, `reconciliation:${runId}`));
  return row?.params as TelegramMessageParams<'reconciliation_alert'> | undefined;
}

/** A night far from any real one, unique per call. */
const businessDate = () =>
  new Date(Date.UTC(2150, 0, 1) + Math.floor(Math.random() * 10_000) * 86_400_000)
    .toISOString()
    .slice(0, 10);

describe('reconciliation.run (RN1–RN5)', () => {
  it('finishes a run whose balances match, with every check stored, once', async () => {
    await inRollback(async ({ tx, runner }) => {
      const { supplierBooks, trc20Books } = await script(tx);
      const runId = await manualRun(tx);
      await runner.execute(runId);
      const run = await runOf(tx, runId);
      expect(run).toMatchObject({ status: 'finished', recheckAt: null });
      expect(run?.snapshotPosition).not.toBeNull();
      const results = await resultsOf(tx, runId);
      for (const check of INTERNAL_CHECKS) {
        expect(results.some((row) => row.check === check)).toBe(true);
      }
      expect(results.map((row) => row.check)).toEqual(
        expect.arrayContaining(['count_stale', 'order_conflicts']),
      );
      expect(await resultOf(tx, runId, 'supplier_balance', 'supplier:fake')).toMatchObject({
        status: 'ok',
        booksUnits: supplierBooks,
        actualUnits: supplierBooks,
      });
      expect(await resultOf(tx, runId, 'usdt_balance', 'usdt_trc20')).toMatchObject({
        status: 'ok',
        booksUnits: trc20Books,
        actualUnits: trc20Books,
      });
      expect(sent.some((job) => job.queue === QUEUES.reconciliationRecheck)).toBe(false);
      // A second delivery of the job changes nothing.
      await runner.execute(runId);
      expect(await resultsOf(tx, runId)).toHaveLength(results.length);
      // No check here alerts about the fake supplier or TRC20.
      const alert = await alertOf(tx, runId);
      expect(alert?.lines.map((line) => line.subject) ?? []).not.toContain('supplier:fake');
      expect(alert?.lines.map((line) => line.subject) ?? []).not.toContain('usdt_trc20');
    });
  });

  it('compares the supplier charges of the day with our attempts (S18 RC1, RC2)', async () => {
    await inRollback(async ({ tx, runner }) => {
      await script(tx);
      const runId = await manualRun(tx);
      const today = new Date(Date.now() - 60_000);
      supplierOrders = [
        [
          {
            supplierOrderId: `nobody-${newId()}`,
            status: 'completed',
            total: { currency: 'USD', amountUnits: USD / 2 },
            createdAt: today,
          },
        ],
        // The second page reaches before the day: the read stops there.
        [{ supplierOrderId: 'old', status: 'completed', createdAt: new Date(0) }],
        [{ supplierOrderId: 'never read', status: 'completed', createdAt: today }],
      ];
      await runner.execute(runId);
      expect(statementPages).toEqual([1, 2]);
      // Off its range: read again after 10 minutes (RN4), then stored.
      expect(sent.some((job) => job.queue === QUEUES.reconciliationRecheck)).toBe(true);
      await runner.recheck(runId);
      const result = await resultOf(tx, runId, 'supplier_charges', 'supplier:fake');
      expect(result).toMatchObject({ status: 'mismatch', actualUnits: USD / 2 });
      expect(result?.details).toMatchObject({ unmatchedSupplierOrders: [expect.any(String)] });
    });
  });

  it('skips the supplier charges when the pages run out before the day starts (RC1)', async () => {
    await inRollback(async ({ tx, runner }) => {
      await script(tx);
      const runId = await manualRun(tx);
      const today = new Date(Date.now() - 60_000);
      supplierOrders = Array.from({ length: 21 }, (_, index) => [
        { supplierOrderId: `busy-${index}`, status: 'completed', createdAt: today },
      ]);
      await runner.execute(runId);
      expect(statementPages).toHaveLength(20);
      expect(await resultOf(tx, runId, 'supplier_charges', 'supplier:fake')).toMatchObject({
        status: 'skipped',
        details: { reason: 'reader_failed' },
      });
    });
  });

  it('skips the supplier charges when the statement cannot be read', async () => {
    await inRollback(async ({ tx, runner }) => {
      await script(tx);
      const runId = await manualRun(tx);
      supplierOrders = new Error('down');
      await runner.execute(runId);
      expect(await resultOf(tx, runId, 'supplier_charges', 'supplier:fake')).toMatchObject({
        status: 'skipped',
        details: { reason: 'reader_failed' },
      });
    });
  });

  it('skips a place without an opening, and a balance whose read failed (RN4, E5)', async () => {
    await inRollback(async ({ tx, runner }) => {
      await script(tx);
      supplierOutcome = { ok: false };
      usdtRead.usdt_trc20 = new ChainReaderError('timeout', 'TronGrid account timed out');
      const bep20Opening = await openingRecorded(tx, 'usdt_bep20');
      const runId = await manualRun(tx);
      await runner.execute(runId);
      expect(await runOf(tx, runId)).toMatchObject({ status: 'finished' });
      for (const [check, subject] of [
        ['supplier_balance', 'supplier:fake'],
        ['usdt_balance', 'usdt_trc20'],
      ] as const) {
        expect(await resultOf(tx, runId, check, subject)).toMatchObject({
          status: 'skipped',
          actualUnits: null,
          details: { reason: 'reader_failed' },
        });
      }
      // Other suites roll back their BEP20 openings.
      if (!bep20Opening) {
        expect(await resultOf(tx, runId, 'usdt_balance', 'usdt_bep20')).toMatchObject({
          status: 'skipped',
          details: { reason: 'opening_missing' },
        });
      }
      expect((await runOf(tx, runId))?.warningCount).toBeGreaterThanOrEqual(2);
      // A balance in another currency is skipped, and is no warning (E2).
      supplierOutcome = { ok: true, balance: { currency: 'SYP', amountUnits: 100 } };
      const other = await manualRun(tx);
      await runner.execute(other);
      expect(await resultOf(tx, other, 'supplier_balance', 'supplier:fake')).toMatchObject({
        status: 'skipped',
        details: { reason: 'currency_unsupported' },
      });
    });
  });

  it('waits 10 minutes to read a balance off its range again, and the recheck clears it', async () => {
    await inRollback(async ({ tx, runner }) => {
      await script(tx, { supplier: 5 * USD });
      const runId = await manualRun(tx);
      const now = new Date();
      await runner.execute(runId, now);
      const waiting = await runOf(tx, runId);
      expect(waiting?.status).toBe('running');
      expect(waiting?.recheckAt?.getTime()).toBe(now.getTime() + 10 * 60_000);
      // Only the recheck's result is stored.
      expect(await resultOf(tx, runId, 'supplier_balance', 'supplier:fake')).toBeUndefined();
      expect(await resultOf(tx, runId, 'usdt_balance', 'usdt_trc20')).toMatchObject({
        status: 'ok',
      });
      const recheck = sent.find((job) => job.queue === QUEUES.reconciliationRecheck);
      expect(recheck).toMatchObject({
        data: { runId },
        options: { singletonKey: runId, startAfter: waiting?.recheckAt, retryLimit: 2 },
      });
      // A second delivery of the run job waits too.
      await runner.execute(runId);
      expect(sent.filter((job) => job.queue === QUEUES.reconciliationRecheck)).toHaveLength(1);

      // Edge case 2: the books caught up in the meantime.
      await script(tx);
      await runner.recheck(runId);
      expect(await runOf(tx, runId)).toMatchObject({ status: 'finished', recheckAt: null });
      expect(await resultOf(tx, runId, 'supplier_balance', 'supplier:fake')).toMatchObject({
        status: 'ok',
      });
      // Only the owed check was read again: one TRC20 result.
      const trc20 = (await resultsOf(tx, runId)).filter((row) => row.subject === 'usdt_trc20');
      expect(trc20).toHaveLength(1);
      // A recheck of an ended run does nothing.
      await runner.recheck(runId);
    });
  });

  it('stores the mismatch the recheck confirms, and alerts it (NT1)', async () => {
    await inRollback(async ({ tx, runner }) => {
      await script(tx, { supplier: 5 * USD });
      const runId = await manualRun(tx);
      await runner.execute(runId);
      await runner.recheck(runId);
      expect(await runOf(tx, runId)).toMatchObject({ status: 'finished' });
      expect((await runOf(tx, runId))?.mismatchCount).toBeGreaterThanOrEqual(1);
      expect(await resultOf(tx, runId, 'supplier_balance', 'supplier:fake')).toMatchObject({
        status: 'mismatch',
        differenceUnits: 5 * USD,
      });
      expect((await alertOf(tx, runId))?.lines).toContainEqual(
        expect.objectContaining({
          check: 'supplier_balance',
          subject: 'supplier:fake',
          differenceUnits: 5 * USD,
        }),
      );
      expect((await runOf(tx, runId))?.alertedAt).not.toBeNull();
      expect(sent.some((job) => job.queue === QUEUES.telegramSend)).toBe(true);

      // The next run finds it again, unchanged and still open: no new alert for it (NT1).
      await script(tx, { supplier: 5 * USD });
      const next = await manualRun(tx);
      await runner.execute(next);
      await runner.recheck(next);
      expect((await alertOf(tx, next))?.lines.map((line) => line.subject) ?? []).not.toContain(
        'supplier:fake',
      );
    });
  });

  it('warns about the conflicts of the day (E5)', async ({ skip }) => {
    await inRollback(async ({ tx, runner }) => {
      const [order] = await tx.select({ id: orders.id }).from(orders).limit(1);
      if (!order) skip('No order in the test database');
      await tx.insert(orderEvents).values({
        orderId: order?.id as string,
        kind: 'note',
        actor: 'supplier',
        reason: 'webhook_conflict',
      });
      await script(tx);
      const runId = await manualRun(tx);
      await runner.execute(runId);
      const conflicts = await resultOf(tx, runId, 'order_conflicts', 'orders');
      expect(conflicts?.status).toBe('warning');
      expect(conflicts?.details).toMatchObject({
        offending: expect.arrayContaining([{ kind: 'order', id: order?.id }]),
      });
    });
  });
});

describe('the nightly run (RN1, RN5, edge cases 4, 16)', () => {
  it('names the Damascus day that ended, even for a late or retried job', () => {
    // 00:30 in Damascus (UTC+3) on 11 March is 21:30 UTC on 10 March.
    expect(nightlyBusinessDate(new Date('2030-03-10T21:30:00Z'))).toBe('2030-03-10');
    expect(nightlyBusinessDate(new Date('2030-03-11T08:00:00Z'))).toBe('2030-03-10');
    // Up to 12 hours late (11:59 in Damascus); later, the job names the day it runs in.
    expect(nightlyBusinessDate(new Date('2030-03-11T08:59:00Z'))).toBe('2030-03-10');
    expect(nightlyBusinessDate(new Date('2030-03-11T09:00:00Z'))).toBe('2030-03-11');
  });

  it('creates one run per night, continues it, and does nothing once it ended', async () => {
    await inRollback(async ({ tx, runner }) => {
      await script(tx);
      const date = businessDate();
      const runId = await runner.nightlyRun(date);
      expect(runId).not.toBeNull();
      expect(await runner.nightlyRun(date)).toBe(runId);
      expect(await runOf(tx, runId as string)).toMatchObject({
        trigger: 'schedule',
        businessDate: date,
        adminId: null,
      });
      // Another night waits while this one runs: two minutes on, or after its recheck.
      const now = new Date();
      expect(await runner.nightlyRun(businessDate(), now)).toEqual({
        retryAt: new Date(now.getTime() + 2 * 60_000),
      });
      await runner.execute(runId as string);
      expect(await runner.nightlyRun(date)).toBeNull();
    });
  });

  it('sends the night again for after a manual run recheck, never losing it (RN1)', async () => {
    await inRollback(async ({ tx, runner }) => {
      await script(tx, { supplier: 5 * USD });
      const manual = await manualRun(tx);
      const now = new Date();
      await runner.execute(manual, now);
      const recheckAt = (await runOf(tx, manual))?.recheckAt as Date;
      const job = new ReconciliationRunJob(pgBoss, runner);
      const date = businessDate();
      await job.handle({ businessDate: date }, 0, now);
      expect(
        await tx.select().from(reconciliationRuns).where(eq(reconciliationRuns.businessDate, date)),
      ).toEqual([]);
      const again = sent.filter((item) => item.queue === QUEUES.reconciliationRun);
      expect(again).toEqual([
        expect.objectContaining({
          data: { businessDate: date },
          options: expect.objectContaining({
            startAfter: new Date(recheckAt.getTime() + 2 * 60_000),
          }),
        }),
      ]);
      // After the recheck, the night's run is created and runs.
      await script(tx);
      await runner.recheck(manual);
      await job.handle(again[0]?.data, 0);
      const [night] = await tx
        .select()
        .from(reconciliationRuns)
        .where(eq(reconciliationRuns.businessDate, date));
      expect(night?.status).toBe('finished');
    });
  });

  it('waits for a manual run started at the same moment, never failing on it (A09-7)', async () => {
    // Another transaction starts a manual run as the API does, under the starts' lock, and
    // commits only once the night has had time to reach its own start.
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let manualId = '';
    const manual = db.transaction(async (other) => {
      await other.execute(sql`select pg_advisory_xact_lock(hashtext('reconciliation:start'))`);
      manualId = await manualRun(other);
      started();
      await held;
    });
    await ready;
    try {
      await inRollback(async ({ runner }) => {
        const night = runner.nightlyRun(businessDate());
        setTimeout(release, 500);
        // Before the shared lock, the night met the manual run's row on the one-running index and
        // the job failed with a unique violation.
        expect(await night).toEqual({ retryAt: expect.any(Date) });
      });
    } finally {
      release();
      await manual;
      await db
        .update(reconciliationRuns)
        .set({ status: 'failed', finishedAt: new Date(), failure: 'Test' })
        .where(eq(reconciliationRuns.id, manualId));
    }
  });

  it('fails a run still running after an hour before the night starts', async () => {
    await inRollback(async ({ tx, runner }) => {
      const [stale] = await tx
        .insert(reconciliationRuns)
        .values({
          trigger: 'manual',
          adminId: actor.adminId,
          startedAt: new Date(Date.now() - 2 * 3_600_000),
        })
        .returning({ id: reconciliationRuns.id });
      const runId = await runner.nightlyRun(businessDate());
      expect(runId).not.toBeNull();
      expect(await runOf(tx, stale?.id as string)).toMatchObject({ status: 'failed' });
    });
  });

  it('runs the night named by the job, and fails a run after its last retry with an alert', async () => {
    await inRollback(async ({ tx, runner }) => {
      await script(tx);
      const job = new ReconciliationRunJob(pgBoss, runner);
      const date = businessDate();
      await job.handle({ businessDate: date }, 0);
      const [night] = await tx
        .select()
        .from(reconciliationRuns)
        .where(eq(reconciliationRuns.businessDate, date));
      expect(night?.status).toBe('finished');

      // A fault of ours (not a reader's): retried, then the run is failed (RN5).
      usdtRead.usdt_trc20 = new TypeError('Unexpected');
      const runId = await manualRun(tx);
      await expect(job.handle({ runId }, 0)).rejects.toThrow('Unexpected');
      expect(await runOf(tx, runId)).toMatchObject({ status: 'running' });
      await expect(job.handle({ runId }, 2)).rejects.toThrow('Unexpected');
      expect(await runOf(tx, runId)).toMatchObject({
        status: 'failed',
        failure: 'TypeError: Unexpected',
      });
      expect(await alertOf(tx, runId)).toMatchObject({ failed: true });
      await expect(job.handle({ unknown: true }, 0)).rejects.toThrow();
    });
  });
});
