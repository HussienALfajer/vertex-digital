import {
  RECONCILIATION_STALE_RUN_MINUTES,
  type ReconciliationSettings,
} from '@vertex-digital/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../client.js';
import type { JobSender } from '../notifications/email-outbox.js';
import { reconciliationRuns, reconciliationSettings } from '../schema/index.js';
import { queueReconciliationAlert } from './alert.js';

type Executor = Database | Transaction;

/**
 * Rule RN5: a run job that throws is retried twice, a minute apart and then doubling; after the
 * last try the run is failed. The API's manual runs and the worker's nightly cron send with these.
 */
export const RECONCILIATION_RUN_OPTIONS = { retryLimit: 2, retryDelay: 60, retryBackoff: true };

/** Rules E1, E5: the newest settings row; the migration seeds the first. */
export async function currentReconciliationSettings(db: Executor): Promise<ReconciliationSettings> {
  const [row] = await db
    .select()
    .from(reconciliationSettings)
    .orderBy(desc(reconciliationSettings.createdAt), desc(reconciliationSettings.id))
    .limit(1);
  if (!row) throw new Error('The reconciliation settings were never seeded');
  return { toleranceUsdUnits: row.toleranceUsdUnits, countStaleDays: row.countStaleDays };
}

/**
 * Rule RN5: a run still `running` an hour after it started is marked `failed`, so the next run can
 * start. Called before a new run is created; the number of runs marked.
 */
export async function failStaleRuns(tx: Transaction, now: Date): Promise<number> {
  const limit = new Date(now.getTime() - RECONCILIATION_STALE_RUN_MINUTES * 60_000);
  const rows = await tx
    .update(reconciliationRuns)
    .set({
      status: 'failed',
      finishedAt: now,
      recheckAt: null,
      failure: `Stale: still running after ${RECONCILIATION_STALE_RUN_MINUTES} minutes`,
    })
    .where(
      sql`${reconciliationRuns.status} = 'running' and ${reconciliationRuns.startedAt} < ${limit}`,
    )
    .returning({ id: reconciliationRuns.id });
  return rows.length;
}

/**
 * Rule RN5: a running run is `finished` with its counts taken from its stored results, and its
 * alert queued (rule NT1), in the caller's transaction. False when the run was no longer running.
 */
export async function finishReconciliationRun(
  tx: Transaction,
  jobs: JobSender,
  runId: string,
): Promise<boolean> {
  const { rows } = await tx.execute<{ mismatches: number; warnings: number }>(sql`
    select
      (count(*) filter (where status = 'mismatch'))::int as mismatches,
      (count(*) filter (where status = 'warning' or (status = 'skipped'
        and details->>'reason' is distinct from 'currency_unsupported')))::int as warnings
    from reconciliation_results where run_id = ${runId}`);
  const [finished] = await tx
    .update(reconciliationRuns)
    .set({
      status: 'finished',
      finishedAt: new Date(),
      recheckAt: null,
      mismatchCount: rows[0]?.mismatches ?? 0,
      warningCount: rows[0]?.warnings ?? 0,
    })
    .where(and(eq(reconciliationRuns.id, runId), eq(reconciliationRuns.status, 'running')))
    .returning({ id: reconciliationRuns.id });
  if (!finished) return false;
  await queueReconciliationAlert(tx, jobs, runId);
  return true;
}

/**
 * Rule RN5: a running run that could not finish is `failed` with its failure (class and message,
 * at most 500 characters) and its alert queued. False when it was no longer running.
 */
export async function failReconciliationRun(
  tx: Transaction,
  jobs: JobSender,
  runId: string,
  failure: string,
): Promise<boolean> {
  const [failed] = await tx
    .update(reconciliationRuns)
    .set({
      status: 'failed',
      finishedAt: new Date(),
      recheckAt: null,
      failure: failure.slice(0, 500),
    })
    .where(and(eq(reconciliationRuns.id, runId), eq(reconciliationRuns.status, 'running')))
    .returning({ id: reconciliationRuns.id });
  if (!failed) return false;
  await queueReconciliationAlert(tx, jobs, runId);
  return true;
}
