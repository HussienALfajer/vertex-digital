import { AsyncLocalStorage } from 'node:async_hooks';
import { TREASURY_ACCOUNTS } from '@vertex-digital/contracts';
import { NodePgSession } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { createDatabase } from './client.js';
import { loadRootEnv } from './env.js';
import { ensureSystemAccount } from './ledger/wallet.js';
import { runMigrations } from './migrate.js';
import { seedRootListRules } from './pricing/lists.js';

function requireEnv(key: string): string {
  loadRootEnv();
  const url = process.env[key];
  if (!url) throw new Error(`${key} is not set. Run \`pnpm db:setup-local\` (see README).`);
  return url;
}

/**
 * Parallel Vitest workers of each app suite (`api`, `worker`). Each worker has a test database of
 * its own, so test files run in parallel without seeing each other's rows; files in one worker
 * run one after another, as the whole suite did on a single database before. Keep in step with
 * TEST_WORKERS in scripts/setup-local-db.mjs, which creates the databases.
 */
export const TEST_WORKERS = 4;

/** `<test database>_<suite>_<worker>`: the database of one Vitest worker of an app suite. */
export function workerDatabaseUrl(url: string, suite: string, worker: number | string): string {
  const parsed = new URL(url);
  parsed.pathname = `${parsed.pathname}_${suite}_${worker}`;
  return parsed.href;
}

/**
 * Inside a Vitest worker of an app suite (TEST_DATABASE_SUITE set by its config), the worker's
 * own database; elsewhere (the db package's tests, the config, global setup) the test database.
 */
function forWorker(url: string): string {
  const suite = process.env.TEST_DATABASE_SUITE;
  const worker = process.env.VITEST_POOL_ID;
  return suite && worker ? workerDatabaseUrl(url, suite, worker) : url;
}

/** The test database as the app role, which the tests use (ADR 0014). */
export function testDatabaseUrl(): string {
  return forWorker(requireEnv('TEST_DATABASE_URL'));
}

/** The test database as the owner role: migrations, and tests that prove a guard refuses even it. */
export function testOwnerDatabaseUrl(): string {
  return forWorker(requireEnv('TEST_DATABASE_OWNER_URL'));
}

/** The app-role and owner-role URLs of every worker database of an app suite. */
export function workerDatabases(suite: string): { url: string; ownerUrl: string }[] {
  const url = requireEnv('TEST_DATABASE_URL');
  const ownerUrl = requireEnv('TEST_DATABASE_OWNER_URL');
  return Array.from({ length: TEST_WORKERS }, (_, index) => ({
    url: workerDatabaseUrl(url, suite, index + 1),
    ownerUrl: workerDatabaseUrl(ownerUrl, suite, index + 1),
  }));
}

/**
 * The treasury's accounts (S13 rule T1) and the fee and exchange accounts its journals post to.
 * Created once before the tests, so tests in parallel never race to create one inside their
 * transactions (two first inserts in opposite orders deadlock).
 */
const SHARED_ACCOUNTS = [
  ...Object.values(TREASURY_ACCOUNTS),
  ...(['USD', 'SYP'] as const).flatMap((currency) => [
    { code: `transfer_fees:${currency}`, kind: 'transfer_fees' as const, currency },
    { code: `currency_exchange:${currency}`, kind: 'currency_exchange' as const, currency },
  ]),
];

/** Vitest global setup: bring the test database schema up to date before any test runs. */
export async function setup(): Promise<void> {
  await prepareTestDatabase(testOwnerDatabaseUrl(), testDatabaseUrl());
}

/** Migrates a test database as the owner, then creates the shared accounts as the app role. */
export async function prepareTestDatabase(ownerUrl: string, url: string): Promise<void> {
  await runMigrations(ownerUrl);
  const connection = createDatabase(url);
  try {
    for (const account of SHARED_ACCOUNTS) {
      await connection.db.transaction((tx) => ensureSystemAccount(tx, account));
    }
    // S20: the wholesale and cost rules, as `pricing:reprice-lists` adds them after a deploy.
    await seedRootListRules(connection.db);
  } finally {
    await connection.close();
  }
}

/** pg's warning for a query sent on a client already running one; pg 9 refuses the query. */
const CONCURRENT_QUERY = /already executing a query/;

/**
 * Collects pg's concurrent-query warning from now on (launch hardening, 2026-10-14): each app's
 * Vitest setup file fails a test file that triggered it. Node prints a deprecation only once per
 * process, so the listener must be in place before the first query.
 */
export function concurrentQueryWarnings(): string[] {
  const seen: string[] = [];
  process.on('warning', (warning) => {
    if (warning.name === 'DeprecationWarning' && CONCURRENT_QUERY.test(warning.message)) {
      seen.push(warning.stack ?? warning.message);
    }
  });
  return seen;
}

/**
 * Collects every query sent through a pool while a transaction of the same async flow holds one
 * of that pool's connections (F3-4, 2026-10-15): the transaction keeps its connection, and often a
 * row or advisory lock, while the read waits for another; ten such requests take every connection
 * of the pool and stop the app. Reads inside a transaction go through it. pg-boss's own pool (its
 * start and queue creation on a process's first send) is another pool and not counted. Each app's
 * Vitest setup file fails a test file that triggered it. Patches drizzle's node-postgres session
 * and pg's pool, so it must run before the first transaction.
 */
export function poolReadsInTransactions(): string[] {
  const seen: string[] = [];
  const open = new AsyncLocalStorage<{ pool: pg.Pool; open: boolean; begun: string }>();
  // The app's own frames: drizzle, pg and this guard say nothing about where the code is.
  const appFrames = (message: string) => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 60;
    const stack = new Error(message).stack ?? message;
    Error.stackTraceLimit = limit;
    return stack
      .split('\n')
      .filter((line) => !/node_modules|node:internal|testing\.ts/.test(line))
      .join('\n');
  };
  const holding = (pool: pg.Pool) => {
    const state = open.getStore();
    return state?.open === true && state.pool === pool ? state : undefined;
  };
  // A Drizzle query is a thenable, which drops the async stack: the read's own frames often say
  // nothing, so each entry also names where the holding transaction began.
  const record = (what: string, begun: string) => {
    seen.push(`${appFrames(what)}\n  inside the transaction begun:\n${begun}`);
  };
  const begin = NodePgSession.prototype.transaction;
  NodePgSession.prototype.transaction = function (this: NodePgSession<never, never>, ...args) {
    // `client` is private: the pool for `db.transaction`, a client for a transaction's own.
    const { client } = this as unknown as { client: unknown };
    if (!(client instanceof pg.Pool)) return begin.apply(this, args);
    const outer = holding(client);
    if (outer) record('a transaction was started through the pool', outer.begun);
    const state = { pool: client, open: true, begun: appFrames('transaction') };
    return open.run(state, async () => {
      try {
        return await begin.apply(this, args);
      } finally {
        state.open = false;
      }
    });
  } as typeof begin;
  const query = pg.Pool.prototype.query;
  pg.Pool.prototype.query = function (this: pg.Pool, ...args: unknown[]) {
    const outer = holding(this);
    if (outer) {
      const [sent] = args as [string | { text?: string } | undefined];
      const text = typeof sent === 'string' ? sent : sent?.text;
      record(`a query was sent through the pool: ${String(text).slice(0, 120)}`, outer.begun);
    }
    return (query as (...args: unknown[]) => unknown).apply(this, args);
  } as typeof query;
  return seen;
}
