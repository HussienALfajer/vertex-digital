import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * The last time each worker process ran its heartbeat job (`system.heartbeat`, every minute). The
 * deploy health check and the staff dashboard read it to tell a stopped worker apart.
 */
export const workerHeartbeats = pgTable('worker_heartbeats', {
  worker: text('worker').primaryKey(),
  beatAt: timestamp('beat_at', { withTimezone: true }).notNull(),
});
