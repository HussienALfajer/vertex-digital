import {
  RECONCILIATION_STALE_RUN_MINUTES,
  type ReconciliationSettings,
} from '@vertex-digital/contracts';
import { desc, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../client.js';
import { reconciliationRuns, reconciliationSettings } from '../schema/index.js';

type Executor = Database | Transaction;

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
