import { customerRateLimits, type Database, newId } from '@vertex-digital/db';
import { lt, sql } from 'drizzle-orm';

/*
 * Counters that survive a restart (ADR 0008, S01 rule C5), in `customer_rate_limits`: fixed
 * windows per key, `last_request` holding the window's start in milliseconds. Each hit counts,
 * refused or not, so a client hammering a limit stays refused until the window ends.
 */

/** The longest window: rows older than twice this are pruned. */
const LONGEST_WINDOW_MS = 24 * 60 * 60 * 1000;

let lastPrune = 0;

/** Counts a hit on `key` and returns the hits in the current window, this one included. */
export async function countHit(db: Database, key: string, windowMs: number): Promise<number> {
  const now = Date.now();
  const windowStart = now - windowMs;
  const [row] = await db
    .insert(customerRateLimits)
    .values({ id: newId(), key, count: 1, lastRequest: now })
    .onConflictDoUpdate({
      target: customerRateLimits.key,
      set: {
        count: sql`case when ${customerRateLimits.lastRequest} <= ${windowStart} then 1 else ${customerRateLimits.count} + 1 end`,
        lastRequest: sql`case when ${customerRateLimits.lastRequest} <= ${windowStart} then ${now} else ${customerRateLimits.lastRequest} end`,
      },
    })
    .returning({ count: customerRateLimits.count });
  if (now - lastPrune > 60 * 60 * 1000) {
    lastPrune = now;
    await db
      .delete(customerRateLimits)
      .where(lt(customerRateLimits.lastRequest, now - 2 * LONGEST_WINDOW_MS));
  }
  return row?.count ?? 1;
}

export interface Limit {
  key: string;
  max: number;
  windowMs: number;
}

/** Counts a hit on every limit; true when all of them still allow it. */
export async function withinLimits(db: Database, limits: readonly Limit[]): Promise<boolean> {
  const counts = await Promise.all(limits.map((limit) => countHit(db, limit.key, limit.windowMs)));
  return counts.every((count, index) => count <= (limits[index] as Limit).max);
}
