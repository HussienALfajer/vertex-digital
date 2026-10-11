import { CURRENCY_SCALE, type TelegramMessageParams } from '@vertex-digital/contracts';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database, type Transaction } from '../client.js';
import { newId } from '../id.js';
import type { JobSender } from '../notifications/email-outbox.js';
import {
  reconciliationExplanations,
  reconciliationResults,
  reconciliationRuns,
  telegramMessages,
} from '../schema/index.js';
import { recordMovement } from '../treasury/index.js';
import { openMismatchCount, queueReconciliationAlert } from './alert.js';
import {
  currentReconciliationSettings,
  failReconciliationRun,
  finishReconciliationRun,
} from './runs.js';
import { countStaleCheck } from './warnings.js';

/*
 * The reconciliation alert (S13 rule NT1), the end of a run (RN5) and the stale count (E5). Runs and results are planted
 * in a transaction that is rolled back; each test uses its own subjects, so the results other
 * suites left never count as "previous".
 */

const connection = createDatabase(process.env.DATABASE_URL as string);
const { db } = connection;

afterAll(() => connection.close());

const USD = CURRENCY_SCALE.USD;

class Rollback extends Error {}

async function rolledBack(target: Database, work: (tx: Transaction) => Promise<void>) {
  await target
    .transaction(async (tx) => {
      await work(tx);
      throw new Rollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });
}

const sent: { queue: string; data: object }[] = [];
const jobs: JobSender = {
  send: async (_tx, queue, data) => {
    sent.push({ queue, data });
    return newId();
  },
};

/** A unique subject, so only this test's results are "previous". */
const subject = () => `test:${newId()}`;

/** A day far from any real night, unique per call. */
const businessDate = () => {
  const day = Math.floor(Math.random() * 3_000);
  return new Date(Date.UTC(2100, 0, 1) + day * 86_400_000).toISOString().slice(0, 10);
};

/** An ended run: manual unless it is a night's. */
async function run(
  tx: Transaction,
  options: { nightly?: boolean; status?: 'running' | 'finished' | 'failed' } = {},
): Promise<string> {
  const status = options.status ?? 'finished';
  const [row] = await tx
    .insert(reconciliationRuns)
    .values({
      trigger: options.nightly ? 'schedule' : 'manual',
      businessDate: options.nightly ? businessDate() : null,
      adminId: options.nightly ? null : newId(),
      status,
      finishedAt: status === 'running' ? null : new Date(),
    })
    .returning({ id: reconciliationRuns.id });
  if (!row) throw new Error('No run');
  return row.id;
}

type ResultInput = Partial<typeof reconciliationResults.$inferInsert> &
  Pick<typeof reconciliationResults.$inferInsert, 'check' | 'subject' | 'status'>;

async function result(tx: Transaction, runId: string, input: ResultInput): Promise<string> {
  const [row] = await tx
    .insert(reconciliationResults)
    .values({
      runId,
      currency: 'USD',
      offendingCount: input.status === 'mismatch' ? 1 : 0,
      details: { offending: [], lines: [], reason: null },
      ...input,
    })
    .returning({ id: reconciliationResults.id });
  if (!row) throw new Error('No result');
  return row.id;
}

/** The alert queued for the run, or undefined. */
async function alertOf(tx: Transaction, runId: string) {
  const [row] = await tx
    .select()
    .from(telegramMessages)
    .where(eq(telegramMessages.dedupeKey, `reconciliation:${runId}`));
  return row?.params as TelegramMessageParams<'reconciliation_alert'> | undefined;
}

/** A run holding one supplier mismatch of `differenceUnits` on `place`, and its alert's id. */
async function supplierMismatch(tx: Transaction, place: string, differenceUnits: number) {
  const runId = await run(tx);
  const resultId = await result(tx, runId, {
    check: 'supplier_balance',
    subject: place,
    status: 'mismatch',
    differenceUnits,
  });
  return { runId, resultId, alert: await queueReconciliationAlert(tx, jobs, runId) };
}

describe('reconciliation alert (NT1)', () => {
  it('alerts a new mismatch once, not an open one again, and one that moved beyond the tolerance', async () => {
    await rolledBack(db, async (tx) => {
      const { toleranceUsdUnits } = await currentReconciliationSettings(tx);
      const place = subject();
      const first = await supplierMismatch(tx, place, 5 * USD);
      expect(first.alert).not.toBeNull();
      expect(await alertOf(tx, first.runId)).toMatchObject({
        failed: false,
        urgent: false,
        lines: [
          {
            check: 'supplier_balance',
            subject: place,
            status: 'mismatch',
            currency: 'USD',
            differenceUnits: 5 * USD,
          },
        ],
        moreLines: 0,
      });
      expect(sent.at(-1)?.queue).toBe('telegram.send');
      // Once per run: the dedupe key and `alerted_at`.
      expect(await queueReconciliationAlert(tx, jobs, first.runId)).toBeNull();
      const [stamped] = await tx
        .select({ alertedAt: reconciliationRuns.alertedAt })
        .from(reconciliationRuns)
        .where(eq(reconciliationRuns.id, first.runId));
      expect(stamped?.alertedAt).not.toBeNull();

      // Still open with the same difference, or within the tolerance of it: nothing new.
      expect((await supplierMismatch(tx, place, 5 * USD)).alert).toBeNull();
      expect((await supplierMismatch(tx, place, 5 * USD + toleranceUsdUnits)).alert).toBeNull();
      // Moved by more than the tolerance from the previous result.
      const moved = await supplierMismatch(tx, place, 5 * USD + 2 * toleranceUsdUnits + 1);
      expect(moved.alert).not.toBeNull();
    });
  });

  it('alerts a mismatch again after its explanation closed it (RN7)', async () => {
    await rolledBack(db, async (tx) => {
      const place = subject();
      const first = await supplierMismatch(tx, place, 3 * USD);
      await tx.insert(reconciliationExplanations).values({
        resultId: first.resultId,
        note: 'Checked with the supplier',
        adminId: newId(),
      });
      expect((await supplierMismatch(tx, place, 3 * USD)).alert).not.toBeNull();
    });
  });

  it('marks an internal mismatch urgent and alerts it again only when it changes', async () => {
    await rolledBack(db, async (tx) => {
      const place = subject();
      const internal = async (offendingCount: number) => {
        const runId = await run(tx);
        await result(tx, runId, {
          check: 'journal_balance',
          subject: place,
          status: 'mismatch',
          currency: null,
          offendingCount,
        });
        await queueReconciliationAlert(tx, jobs, runId);
        return alertOf(tx, runId);
      };
      expect(await internal(2)).toMatchObject({
        urgent: true,
        lines: [{ check: 'journal_balance', offendingCount: 2, differenceUnits: null }],
      });
      expect(await internal(2)).toBeUndefined();
      expect(await internal(3)).toMatchObject({ urgent: true });
    });
  });

  it('alerts a warning the previous nightly run did not have', async () => {
    await rolledBack(db, async (tx) => {
      const place = subject();
      const warning = {
        check: 'usdt_balance' as const,
        subject: place,
        status: 'skipped' as const,
        details: { offending: [], lines: [], reason: 'reader_failed' as const },
      };
      const night = await run(tx, { nightly: true });
      await result(tx, night, {
        ...warning,
        status: 'ok',
        details: { ...warning.details, reason: null },
      });
      // The previous night had no warning on this subject: new.
      const first = await run(tx, { nightly: true });
      await result(tx, first, warning);
      expect(await queueReconciliationAlert(tx, jobs, first)).not.toBeNull();
      expect(await alertOf(tx, first)).toMatchObject({
        lines: [{ status: 'skipped', reason: 'reader_failed' }],
      });
      // The previous night had it: nothing new, for a manual run too.
      const manual = await run(tx);
      await result(tx, manual, warning);
      expect(await queueReconciliationAlert(tx, jobs, manual)).toBeNull();
      // A supplier balance in another currency is not a warning (E2).
      const currency = await run(tx);
      await result(tx, currency, {
        ...warning,
        subject: subject(),
        details: { ...warning.details, reason: 'currency_unsupported' },
      });
      expect(await queueReconciliationAlert(tx, jobs, currency)).toBeNull();
    });
  });

  it('alerts a failed run with no results, and never a running one', async () => {
    await rolledBack(db, async (tx) => {
      await tx
        .update(reconciliationRuns)
        .set({ status: 'failed', finishedAt: new Date(), recheckAt: null, failure: 'Test' })
        .where(eq(reconciliationRuns.status, 'running'));
      const running = await run(tx, { status: 'running' });
      expect(await queueReconciliationAlert(tx, jobs, running)).toBeNull();
      expect(await failReconciliationRun(tx, jobs, running, `Error: ${'x'.repeat(600)}`)).toBe(
        true,
      );
      const [failed] = await tx
        .select()
        .from(reconciliationRuns)
        .where(eq(reconciliationRuns.id, running));
      expect(failed).toMatchObject({ status: 'failed', recheckAt: null });
      expect(failed?.failure).toHaveLength(500);
      expect(await alertOf(tx, running)).toMatchObject({ failed: true, lines: [], moreLines: 0 });
      // An ended run is not failed again.
      expect(await failReconciliationRun(tx, jobs, running, 'Again')).toBe(false);
    });
  });

  it('lists at most 10 lines, internal mismatches first, and counts the rest', async () => {
    await rolledBack(db, async (tx) => {
      const runId = await run(tx);
      for (let index = 0; index < 11; index += 1) {
        await result(tx, runId, {
          check: 'supplier_balance',
          subject: subject(),
          status: 'mismatch',
          differenceUnits: USD,
        });
      }
      await result(tx, runId, {
        check: 'ledger_total',
        subject: subject(),
        status: 'mismatch',
        differenceUnits: 1,
      });
      await queueReconciliationAlert(tx, jobs, runId);
      const alert = await alertOf(tx, runId);
      expect(alert?.lines).toHaveLength(10);
      expect(alert?.lines[0]?.check).toBe('ledger_total');
      expect(alert?.moreLines).toBe(2);
    });
  });
});

describe('the end of a run (RN5, RN7)', () => {
  it('finishes a running run with its counts, once, and counts the open mismatches', async () => {
    await rolledBack(db, async (tx) => {
      await tx
        .update(reconciliationRuns)
        .set({ status: 'failed', finishedAt: new Date(), recheckAt: null, failure: 'Test' })
        .where(eq(reconciliationRuns.status, 'running'));
      const openBefore = await openMismatchCount(tx);
      const runId = await run(tx, { status: 'running' });
      const details = (reason: 'opening_missing' | 'currency_unsupported' | null) => ({
        offending: [],
        lines: [],
        reason,
      });
      await result(tx, runId, {
        check: 'supplier_balance',
        subject: subject(),
        status: 'mismatch',
      });
      await result(tx, runId, { check: 'usdt_balance', subject: subject(), status: 'mismatch' });
      await result(tx, runId, { check: 'order_conflicts', subject: subject(), status: 'warning' });
      await result(tx, runId, {
        check: 'usdt_balance',
        subject: subject(),
        status: 'skipped',
        details: details('opening_missing'),
      });
      await result(tx, runId, {
        check: 'supplier_balance',
        subject: subject(),
        status: 'skipped',
        details: details('currency_unsupported'),
      });
      await result(tx, runId, { check: 'ledger_total', subject: subject(), status: 'ok' });
      expect(await finishReconciliationRun(tx, jobs, runId)).toBe(true);
      const [finished] = await tx
        .select()
        .from(reconciliationRuns)
        .where(eq(reconciliationRuns.id, runId));
      expect(finished).toMatchObject({
        status: 'finished',
        mismatchCount: 2,
        warningCount: 2,
        recheckAt: null,
      });
      expect(finished?.finishedAt).not.toBeNull();
      expect(await alertOf(tx, runId)).toMatchObject({ open: openBefore + 2 });
      expect(await finishReconciliationRun(tx, jobs, runId)).toBe(false);
      expect(await openMismatchCount(tx)).toBe(openBefore + 2);
    });
  });
});

describe('the stale Sham Cash count (E5)', () => {
  it('warns while Sham Cash is in use and no count is newer than the stale days', async () => {
    await rolledBack(db, async (tx) => {
      // In use: an opening into the pounds place (rolled back with the rest).
      await recordMovement(
        tx,
        {
          idempotencyKey: newId(),
          kind: 'transfer',
          from: 'outside_syp',
          to: 'sham_cash_syp',
          sentUnits: 1_000_00,
          receivedUnits: 1_000_00,
          outsideCategory: 'owner',
          openingBalance: false,
          orderId: null,
          externalReference: null,
          reason: 'Stale count test',
        },
        { adminId: newId(), ipAddress: null, userAgent: null },
      );
      await tx
        .update(reconciliationRuns)
        .set({ status: 'failed', finishedAt: new Date(), recheckAt: null, failure: 'Test' })
        .where(eq(reconciliationRuns.status, 'running'));
      await tx.insert(reconciliationRuns).values({
        trigger: 'count',
        adminId: newId(),
        idempotencyKey: newId(),
        status: 'finished',
        finishedAt: new Date(),
      });
      expect(await countStaleCheck(tx, { now: new Date(), staleDays: 7 })).toMatchObject({
        check: 'count_stale',
        subject: 'sham_cash',
        status: 'ok',
        offendingCount: 0,
      });
      // Eight days on, that count is stale.
      const later = new Date(Date.now() + 8 * 86_400_000);
      expect(await countStaleCheck(tx, { now: later, staleDays: 7 })).toMatchObject({
        status: 'warning',
        offendingCount: 1,
      });
      expect(await countStaleCheck(tx, { now: later, staleDays: 9 })).toMatchObject({
        status: 'ok',
      });
    });
  });
});
