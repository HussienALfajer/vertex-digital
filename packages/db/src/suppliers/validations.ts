import { and, count, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../client.js';
import { supplierCalls } from '../schema/index.js';

/** The time zone of a validation day (S09 rule PV5). */
export const VALIDATION_DAY_TIME_ZONE = 'Asia/Damascus';

/** 00:00 today in Damascus, as an instant, in SQL. */
const damascusMidnight = sql`((now() at time zone ${VALIDATION_DAY_TIME_ZONE})::date::timestamp at time zone ${VALIDATION_DAY_TIME_ZONE})`;

/**
 * S09 rule PV5: each supplier's player checks since 00:00 Damascus, from `supplier_calls`. Read
 * without a lock: a burst may pass a quota by a few calls.
 */
export async function validationsToday(
  db: Database | Transaction,
  supplierIds: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map(supplierIds.map((id) => [id, 0]));
  if (supplierIds.length === 0) return counts;
  const rows = await db
    .select({ supplierId: supplierCalls.supplierId, calls: count() })
    .from(supplierCalls)
    .where(
      and(
        inArray(supplierCalls.supplierId, [...supplierIds]),
        eq(supplierCalls.operation, 'validate_player'),
        gte(supplierCalls.createdAt, damascusMidnight),
      ),
    )
    .groupBy(supplierCalls.supplierId);
  for (const row of rows) counts.set(row.supplierId, row.calls);
  return counts;
}

/** Today's date in Damascus, `YYYY-MM-DD` (the quota alert's dedupe key). */
export function damascusDate(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: VALIDATION_DAY_TIME_ZONE }).format(at);
}
