import { RECONCILIATION_MAX_OFFENDING_IDS } from '@vertex-digital/contracts';
import { sql } from 'drizzle-orm';
import type { Database, Transaction } from '../client.js';
import { type CheckResult, noDetails, units } from './types.js';

/*
 * The warning checks of a run (S13 rule E5): `ok` or `warning`, never a mismatch. They read the
 * newest state, outside the internal checks' snapshot.
 */

type Executor = Database | Transaction;

const warningResult = (
  check: 'count_stale' | 'order_conflicts',
  subject: string,
  offending: CheckResult['details']['offending'],
  offendingCount: number,
): CheckResult => ({
  check,
  subject,
  status: offendingCount > 0 ? 'warning' : 'ok',
  currency: null,
  booksUnits: null,
  actualUnits: null,
  differenceUnits: null,
  allowedLowUnits: null,
  allowedHighUnits: null,
  offendingCount,
  details: { ...noDetails(), offending },
});

/**
 * `count_stale`: Sham Cash is in use (its receipts accounts hold postings) and no count, in
 * either currency, was entered in the last `staleDays` days.
 */
export async function countStaleCheck(
  db: Executor,
  input: { now: Date; staleDays: number },
): Promise<CheckResult> {
  const since = new Date(input.now.getTime() - input.staleDays * 86_400_000);
  const { rows } = await db.execute<{ stale: boolean }>(sql`
    select exists (
      select 1 from ledger_postings p join ledger_accounts a on a.id = p.account_id
      where a.kind = 'sham_cash_receipts'
    ) and not exists (
      select 1 from reconciliation_runs
      where "trigger" = 'count' and status = 'finished' and started_at >= ${since}
    ) as stale`);
  return warningResult('count_stale', 'sham_cash', [], rows[0]?.stale === true ? 1 : 0);
}

/**
 * `order_conflicts`: supplier results that conflicted with a closed attempt (S08 F5) in
 * `[from, to)`, a possible double delivery to settle with a supplier correction. Lists the orders.
 */
export async function orderConflictsCheck(
  db: Executor,
  input: { from: Date; to: Date },
): Promise<CheckResult> {
  const { rows } = await db.execute<{ id: string; total: string }>(sql`
    select order_id as id, count(*) over ()::text as total from (
      select order_id, max(created_at) as newest from order_events
      where kind = 'note' and reason in ('webhook_conflict', 'late_result_conflict')
        and created_at >= ${input.from} and created_at < ${input.to}
      group by order_id
    ) conflicts
    order by newest desc
    limit ${RECONCILIATION_MAX_OFFENDING_IDS}`);
  return warningResult(
    'order_conflicts',
    'orders',
    rows.map((row) => ({ kind: 'order' as const, id: row.id })),
    units(rows[0]?.total),
  );
}
