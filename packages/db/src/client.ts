import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PgTransaction } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;

/** The handle inside `db.transaction(async (tx) => ...)`. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** The pool or a transaction: what read helpers that serve both accept. */
export type Executor = Database | Transaction;

type Reads = readonly (() => unknown)[];

/**
 * Runs independent reads: in parallel through the pool, one after another in a transaction. A
 * transaction holds one client, and a client runs one query at a time: `Promise.all` there only
 * queued them inside pg, which warns since pg 8.20 and refuses from pg 9 ("Calling client.query()
 * when the client is already executing a query"). Each read is a function, so none starts before
 * its turn (a Drizzle query starts when awaited, an async helper when called).
 */
export async function readAll<const T extends Reads>(
  db: Executor,
  reads: T,
): Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  type Results = { -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> };
  if (!(db instanceof PgTransaction)) {
    return (await Promise.all(reads.map((read) => read()))) as Results;
  }
  const results: unknown[] = [];
  for (const read of reads) results.push(await read());
  return results as Results;
}

export interface DatabaseConnection {
  db: Database;
  pool: pg.Pool;
  close: () => Promise<void>;
}

/**
 * The limits of the API's and the worker's pools (F3-4 safeguard): a request or job that waits
 * 10 s for a connection, or a statement that waits 15 s for a lock, fails instead of queueing for
 * ever. A transaction that reads through the pool while holding a lock (the F3-4 slip) then fails
 * in seconds, rolls back and frees its connection and lock, where ten of them used to stop the
 * process. CLIs and migrations keep no limit: a migration may wait on its advisory lock.
 */
export const APP_POOL_LIMITS = {
  connectionTimeoutMillis: 10_000,
  lock_timeout: 15_000,
} satisfies pg.PoolConfig;

export function createDatabase(
  connectionString: string,
  limits: Pick<pg.PoolConfig, 'connectionTimeoutMillis' | 'lock_timeout'> = {},
): DatabaseConnection {
  const pool = new pg.Pool({ ...limits, connectionString });
  const db = drizzle({ client: pool, schema, casing: 'snake_case' });
  return { db, pool, close: () => pool.end() };
}
