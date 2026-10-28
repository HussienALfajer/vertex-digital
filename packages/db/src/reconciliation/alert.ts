import {
  type Currency,
  isInternalCheck,
  isWarningResult,
  RECONCILIATION_ALERT_MAX_LINES,
  type ReconciliationDetails,
  rateFromNumeric,
  sypTolerance,
  type TelegramMessageParams,
} from '@vertex-digital/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../client.js';
import type { JobSender } from '../notifications/email-outbox.js';
import { exchangeRates, reconciliationResults, reconciliationRuns } from '../schema/index.js';
import { damascusDate } from '../suppliers/validations.js';
import { queueTelegramMessage } from '../telegram/queue-telegram-message.js';
import { currentReconciliationSettings } from './runs.js';

type Executor = Database | Transaction;
type ResultRow = typeof reconciliationResults.$inferSelect;
type AlertLine = TelegramMessageParams<'reconciliation_alert'>['lines'][number];

/** Rule RN7: the mismatches open now, the newest result of each check and subject unexplained. */
export async function openMismatchCount(db: Executor): Promise<number> {
  const { rows } = await db.execute<{ open: number }>(sql`
    select count(*)::int as open from (
      select distinct on ("check", subject) id, status
      from reconciliation_results
      order by "check", subject, created_at desc, id desc
    ) newest
    where newest.status = 'mismatch'
      and not exists (select 1 from reconciliation_explanations e where e.result_id = newest.id)`);
  return rows[0]?.open ?? 0;
}

const reasonOf = (row: ResultRow) => (row.details as ReconciliationDetails).reason;

const isWarning = (row: ResultRow) =>
  isWarningResult({ status: row.status, reason: reasonOf(row) });

/** The newest result of the same check and subject in an earlier run, with whether it is open. */
async function previousResult(tx: Transaction, row: ResultRow) {
  const { rows } = await tx.execute<{
    status: ResultRow['status'];
    reason: ReconciliationDetails['reason'];
    difference: string | null;
    offending: number;
    explained: boolean;
  }>(sql`
    select r.status, r.details->>'reason' as reason, r.difference_units::text as difference,
      r.offending_count as offending,
      exists (select 1 from reconciliation_explanations e where e.result_id = r.id) as explained
    from reconciliation_results r
    where r."check" = ${row.check} and r.subject = ${row.subject} and r.run_id <> ${row.runId}
      and r.created_at < ${row.createdAt}
    order by r.created_at desc, r.id desc
    limit 1`);
  return rows[0];
}

/**
 * Rule NT1: queues the run's `reconciliation_alert`, at most once (dedupe key
 * `reconciliation:<run id>`), in the transaction that ends the run, and stamps `alerted_at`. It
 * alerts when the run failed, found a mismatch that is new (the previous result of its check and
 * subject is not an open mismatch) or moved by more than the tolerance (internal checks are exact:
 * any change of the difference or the count), or a warning the previous nightly run did not have.
 * Returns the message id, or null when nothing alerts.
 */
export async function queueReconciliationAlert(
  tx: Transaction,
  jobs: JobSender,
  runId: string,
): Promise<string | null> {
  const [run] = await tx.select().from(reconciliationRuns).where(eq(reconciliationRuns.id, runId));
  if (!run || run.status === 'running' || run.alertedAt !== null) return null;
  const results = await tx
    .select()
    .from(reconciliationResults)
    .where(eq(reconciliationResults.runId, runId))
    .orderBy(reconciliationResults.createdAt, reconciliationResults.id);
  const tolerance = await tolerances(tx);
  const [previousNightly] = await tx
    .select({ id: reconciliationRuns.id })
    .from(reconciliationRuns)
    .where(
      and(
        eq(reconciliationRuns.trigger, 'schedule'),
        eq(reconciliationRuns.status, 'finished'),
        sql`${reconciliationRuns.startedAt} < ${run.startedAt}`,
      ),
    )
    .orderBy(desc(reconciliationRuns.startedAt))
    .limit(1);
  const previousWarnings = new Set<string>();
  if (previousNightly) {
    const rows = await tx
      .select()
      .from(reconciliationResults)
      .where(eq(reconciliationResults.runId, previousNightly.id));
    for (const row of rows) if (isWarning(row)) previousWarnings.add(`${row.check}|${row.subject}`);
  }
  const alerting: ResultRow[] = [];
  for (const row of results) {
    if (row.status === 'mismatch') {
      const previous = await previousResult(tx, row);
      const open = previous?.status === 'mismatch' && !previous.explained;
      // S18 RC2: the supplier's charges are a day's own facts, never the night before's again.
      if (!open || row.check === 'supplier_charges') {
        alerting.push(row);
        continue;
      }
      const before = previous.difference === null ? null : Number(previous.difference);
      if (isInternalCheck(row.check)) {
        if (before !== row.differenceUnits || previous.offending !== row.offendingCount) {
          alerting.push(row);
        }
      } else if (
        before === null ||
        row.differenceUnits === null ||
        Math.abs(row.differenceUnits - before) > tolerance(row.currency ?? 'USD')
      ) {
        alerting.push(row);
      }
    } else if (isWarning(row) && run.trigger === 'count') {
      // A count's check is in count runs only, never the night's: its warning is new against the
      // previous count of that currency, so each count before an opening alerts once (A09-8).
      const previous = await previousResult(tx, row);
      if (!previous || !isWarningResult(previous)) alerting.push(row);
    } else if (isWarning(row) && !previousWarnings.has(`${row.check}|${row.subject}`)) {
      alerting.push(row);
    }
  }
  const failed = run.status === 'failed';
  if (!failed && alerting.length === 0) return null;
  // Internal mismatches first, then the external ones, then the warnings.
  const rank = (row: ResultRow) =>
    row.status === 'mismatch' ? (isInternalCheck(row.check) ? 0 : 1) : 2;
  alerting.sort((a, b) => rank(a) - rank(b));
  const lines: AlertLine[] = alerting.slice(0, RECONCILIATION_ALERT_MAX_LINES).map((row) => ({
    check: row.check,
    subject: row.subject,
    status: row.status,
    currency: row.currency,
    differenceUnits: row.differenceUnits,
    offendingCount: row.offendingCount,
    reason: reasonOf(row),
  }));
  const id = await queueTelegramMessage(tx, jobs, {
    kind: 'reconciliation_alert',
    params: {
      runId,
      trigger: run.trigger,
      date: run.businessDate ?? damascusDate(run.startedAt),
      failed,
      urgent: results.some((row) => row.status === 'mismatch' && isInternalCheck(row.check)),
      lines,
      moreLines: alerting.length - lines.length,
      open: await openMismatchCount(tx),
    },
    dedupeKey: `reconciliation:${runId}`,
  });
  await tx
    .update(reconciliationRuns)
    .set({ alertedAt: new Date() })
    .where(eq(reconciliationRuns.id, runId));
  return id;
}

/** Rule E1: the tolerance in each currency; SYP at today's rate, 0 without a rate. */
async function tolerances(tx: Transaction): Promise<(currency: Currency) => number> {
  const settings = await currentReconciliationSettings(tx);
  const [rate] = await tx
    .select({ sypPerUsd: exchangeRates.sypPerUsd })
    .from(exchangeRates)
    .orderBy(desc(exchangeRates.createdAt), desc(exchangeRates.id))
    .limit(1);
  const syp = sypTolerance(
    settings.toleranceUsdUnits,
    rate ? rateFromNumeric(rate.sypPerUsd) : null,
  );
  return (currency) => (currency === 'USD' ? settings.toleranceUsdUnits : syp);
}
