import { AsyncLocalStorage } from 'node:async_hooks';
import { TREASURY_ACCOUNTS } from '@vertex-digital/contracts';
import { NodePgSession } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { createDatabase } from './client.js';
import { databaseAccessStatements } from './database-access.js';
import { loadRootEnv } from './env.js';
import { ensureSystemAccount } from './ledger/wallet.js';
import { runMigrations } from './migrate.js';
import { seedRootListRules } from './pricing/lists.js';
import { testWorkers } from './test-workers.js';

function requireEnv(key: string): string {
  loadRootEnv();
  const url = process.env[key];
  if (!url) throw new Error(`${key} is not set. Run \`pnpm db:setup-local\` (see README).`);
  return url;
}

/**
 * Parallel Vitest workers of each app suite (`api`, `worker`): `TEST_WORKERS` from the environment
 * or .env, else sized to the machine (test-workers.ts). Each worker has a test database of its own,
 * so test files run in parallel without seeing each other's rows; files in one worker run one after
 * another. The suites' global setups create the ones that are missing (`createMissingDatabases`).
 */
export const TEST_WORKERS = loadedTestWorkers();

function loadedTestWorkers(): number {
  loadRootEnv();
  return testWorkers();
}

/** How long a test run waits for another run of the same suite to end. */
const HOLD_WAIT_MS = 20 * 60_000;

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
 * Holds the test databases of `suite` (`db`, `api`, `worker`) for one test run, with a session
 * advisory lock on the test database: a second run of the same suite (another session, a forgotten
 * background run) waits for the first to end instead of sharing its rows, which failed both.
 * PostgreSQL releases the lock when a run dies. Returns the release, for the global setup's
 * teardown.
 */
export async function holdTestDatabases(suite: string): Promise<() => Promise<void>> {
  const client = new pg.Client({
    connectionString: requireEnv('TEST_DATABASE_URL'),
    application_name: `vertex-digital ${suite} tests (pid ${process.pid})`,
  });
  await client.connect();
  const started = Date.now();
  let toldAt = 0;
  for (;;) {
    const { rows } = await client.query<{ held: boolean }>(
      'select pg_try_advisory_lock(hashtext($1)) as held',
      [`vertex-digital-tests:${suite}`],
    );
    if (rows[0]?.held) return () => client.end();
    if (Date.now() - started > HOLD_WAIT_MS) {
      await client.end();
      throw new Error(`Another ${suite} test run has held the test databases for 20 minutes.`);
    }
    if (Date.now() - toldAt > 15_000) {
      process.stderr.write(`Another ${suite} test run is using the test databases; waiting.\n`);
      toldAt = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/**
 * Creates the worker databases that do not exist yet (a new machine, a larger TEST_WORKERS) as the
 * owner role, with the app role's access (database-access.ts). `pnpm db:setup-local` lets the
 * owner role create databases, locally and in CI only.
 */
export async function createMissingDatabases(
  databases: readonly { url: string; ownerUrl: string }[],
): Promise<void> {
  const ownerUrl = requireEnv('TEST_DATABASE_OWNER_URL');
  const owner = decodeURIComponent(new URL(ownerUrl).username);
  const app = decodeURIComponent(new URL(requireEnv('TEST_DATABASE_URL')).username);
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  const created: { name: string; ownerUrl: string }[] = [];
  try {
    for (const database of databases) {
      const name = decodeURIComponent(new URL(database.ownerUrl).pathname.slice(1));
      const found = await client.query('select 1 from pg_database where datname = $1', [name]);
      if (found.rowCount) continue;
      try {
        await client.query(`create database ${client.escapeIdentifier(name)}`);
      } catch (error) {
        throw new Error(
          `Test database ${name} is missing and the owner role cannot create it: run pnpm db:setup-local.`,
          { cause: error },
        );
      }
      created.push({ name, ownerUrl: database.ownerUrl });
    }
  } finally {
    await client.end();
  }
  for (const database of created) {
    const access = new pg.Client({ connectionString: database.ownerUrl });
    await access.connect();
    try {
      for (const statement of databaseAccessStatements(database.name, owner, app)) {
        await access.query(statement);
      }
    } finally {
      await access.end();
    }
  }
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

/**
 * Vitest global setup of this package's suite on the test database: holds it for the run and
 * brings its schema up to date before any test runs. Returns the teardown that releases it.
 */
export async function setup(): Promise<() => Promise<void>> {
  const release = await holdTestDatabases('db');
  try {
    await prepareTestDatabase(testOwnerDatabaseUrl(), testDatabaseUrl());
  } catch (error) {
    await release();
    throw error;
  }
  return release;
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

/**
 * What the setup files' recorders collected for the test file that runs now. The recorders patch
 * pg and drizzle once per process, and each test file's setup starts a fresh list: a suite without
 * Vitest's isolation (the api and the worker) runs its setup files again before every file in the
 * same process, and each file must fail for what it triggered, however many ran before it.
 */
const RECORDED = Symbol.for('vertex-digital.testing.recorded');
const PATCHED = Symbol.for('vertex-digital.testing.patched');

interface Recorded {
  concurrentQueries: string[];
  poolReads: string[];
}

function recorded(): Recorded {
  const holder = globalThis as { [RECORDED]?: Recorded };
  holder[RECORDED] ??= { concurrentQueries: [], poolReads: [] };
  return holder[RECORDED];
}

/** Marks `target` as patched; false when it already was (an earlier test file in this process). */
function patchOnce(target: object): boolean {
  const marked = target as { [PATCHED]?: true };
  if (marked[PATCHED]) return false;
  marked[PATCHED] = true;
  return true;
}

/**
 * Collects, for the current test file, every query sent on a pg client already running one
 * (launch hardening, 2026-10-14), under the condition on which pg 8 warns ("Calling client.query()
 * when the client is already executing a query"); pg 9 refuses the query. Node prints that
 * deprecation only once per process, so the guard checks the client itself on every query rather
 * than listening for the warning. Each app's Vitest setup file fails a test file that triggered it.
 */
export function concurrentQueries(): string[] {
  const seen: string[] = [];
  recorded().concurrentQueries = seen;
  if (!patchOnce(pg.Client.prototype)) return seen;
  // pg's own state: the queries waiting behind the running one, unless the client pipelines.
  const waiting = (client: pg.Client) =>
    client as unknown as { _queryQueue?: unknown[]; pipeline?: boolean };
  if (!Array.isArray(waiting(new pg.Client())._queryQueue)) {
    throw new Error('pg no longer keeps `_queryQueue`: update concurrentQueries (testing.ts).');
  }
  const query = pg.Client.prototype.query;
  pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
    const { _queryQueue: queue = [], pipeline } = waiting(this);
    if (!pipeline && queue.length > 0) {
      recorded().concurrentQueries.push(
        new Error('a query was sent on a pg client already running one').stack ?? '',
      );
    }
    return (query as (...args: unknown[]) => unknown).apply(this, args);
  } as typeof query;
  return seen;
}

/**
 * Collects, for the current test file, every query sent through a pool while a transaction of the
 * same async flow holds one of that pool's connections (F3-4, 2026-10-15): the transaction keeps
 * its connection, and often a row or advisory lock, while the read waits for another; ten such
 * requests take every connection of the pool and stop the app. Reads inside a transaction go
 * through it. pg-boss's own pool (its start and queue creation on a process's first send) is
 * another pool and not counted. Each app's Vitest setup file fails a test file that triggered it.
 * Patches drizzle's node-postgres session and pg's pool, so it must run before the first
 * transaction.
 */
export function poolReadsInTransactions(): string[] {
  const seen: string[] = [];
  recorded().poolReads = seen;
  const sessionPatched = patchOnce(NodePgSession.prototype);
  const poolPatched = patchOnce(pg.Pool.prototype);
  if (!sessionPatched && !poolPatched) return seen;
  if (!sessionPatched || !poolPatched)
    throw new Error('poolReadsInTransactions found one of its patches only.');
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
    recorded().poolReads.push(`${appFrames(what)}\n  inside the transaction begun:\n${begun}`);
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
