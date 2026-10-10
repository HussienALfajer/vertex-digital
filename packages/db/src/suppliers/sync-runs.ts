import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../client.js';
import { supplierSyncRuns } from '../schema/index.js';

type Executor = Database | Transaction;

/** The failed runs since the supplier's last successful one (for the failing-sync alerts). */
export async function failedRunStreak(
  db: Executor,
  supplierId: string,
): Promise<{ count: number; firstRunId: string | null; lastErrorCode: string | null }> {
  const [lastSuccess] = await db
    .select({ id: supplierSyncRuns.id })
    .from(supplierSyncRuns)
    .where(
      and(eq(supplierSyncRuns.supplierId, supplierId), eq(supplierSyncRuns.status, 'succeeded')),
    )
    .orderBy(desc(supplierSyncRuns.startedAt), desc(supplierSyncRuns.id))
    .limit(1);
  const failed = and(
    eq(supplierSyncRuns.supplierId, supplierId),
    eq(supplierSyncRuns.status, 'failed'),
    lastSuccess
      ? // Compared in the database: a timestamp read back into JavaScript loses its microseconds.
        sql`(${supplierSyncRuns.startedAt}, ${supplierSyncRuns.id}) > (select started_at, id from ${supplierSyncRuns} where id = ${lastSuccess.id})`
      : undefined,
  );
  const [[total], [first], [last]] = await Promise.all([
    db.select({ count: count() }).from(supplierSyncRuns).where(failed),
    db
      .select({ id: supplierSyncRuns.id })
      .from(supplierSyncRuns)
      .where(failed)
      .orderBy(asc(supplierSyncRuns.startedAt), asc(supplierSyncRuns.id))
      .limit(1),
    db
      .select({ errorCode: supplierSyncRuns.errorCode })
      .from(supplierSyncRuns)
      .where(failed)
      .orderBy(desc(supplierSyncRuns.startedAt), desc(supplierSyncRuns.id))
      .limit(1),
  ]);
  return {
    count: total?.count ?? 0,
    firstRunId: first?.id ?? null,
    lastErrorCode: last?.errorCode ?? null,
  };
}
