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

/** The test database as the app role, which the tests use (ADR 0014). */
export function testDatabaseUrl(): string {
  return requireEnv('TEST_DATABASE_URL');
}

/** The test database as the owner role: migrations, and tests that prove a guard refuses even it. */
export function testOwnerDatabaseUrl(): string {
  return requireEnv('TEST_DATABASE_OWNER_URL');
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
  await runMigrations(testOwnerDatabaseUrl());
  const connection = createDatabase(testDatabaseUrl());
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
