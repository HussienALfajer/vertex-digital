import { testDatabaseUrl } from '@vertex-digital/db/testing';
import { afterAll, vi } from 'vitest';

// A worker runs one file after another without isolation (vitest.config.ts) and this file before
// each of them: what a file sets in process.env (USDT addresses, the worker's paths below) and the
// spies it leaves on shared prototypes are put back after it, so they never reach the next file.
const environment = { ...process.env };
afterAll(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in environment)) delete process.env[key];
  }
  Object.assign(process.env, environment);
  vi.restoreAllMocks();
});

/*
 * Each Vitest worker has its own test database and fake supplier state (packages/db testing.ts),
 * so test files run in parallel without seeing each other's rows or scripted supplier answers.
 * Runs before each test file imports the app, which reads these at startup.
 */
const worker = process.env.VITEST_POOL_ID;
process.env.DATABASE_URL = testDatabaseUrl();
process.env.FAKE_SUPPLIER_STATE_FILE = process.env.FAKE_SUPPLIER_STATE_FILE?.replace(
  /\.json$/,
  `-${worker}.json`,
);
process.env.FILES_ROOT = `${process.env.FILES_ROOT}-${worker}`;
