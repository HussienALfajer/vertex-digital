import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase } from './client.js';

export const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

/** Arbitrary constant shared by every process that migrates this database. */
const MIGRATION_LOCK_ID = 7_140_301;

/**
 * Applies pending migrations. Concurrent callers (parallel test runs, a deploy while a process
 * starts) are serialized with a session-level advisory lock, so only one runs at a time and the
 * others find nothing left to apply.
 */
export async function runMigrations(connectionString: string): Promise<void> {
  const { db, pool, close } = createDatabase(connectionString);
  const lock = await pool.connect();
  try {
    await lock.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    try {
      await migrate(db, { migrationsFolder });
    } finally {
      await lock.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    }
  } finally {
    lock.release();
    await close();
  }
}
