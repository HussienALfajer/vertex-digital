import { TREASURY_ACCOUNTS } from '@vertex-digital/contracts';
import { createDatabase } from './client.js';
import { loadRootEnv } from './env.js';
import { ensureSystemAccount } from './ledger/wallet.js';
import { runMigrations } from './migrate.js';

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
