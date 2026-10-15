import { testDatabaseUrl } from '@vertex-digital/db/testing';

/*
 * Each Vitest worker has its own test database, fake supplier state, bot and email logs and files
 * (packages/db testing.ts), so test files run in parallel without seeing each other's rows or
 * files. Runs before each test file imports the worker, which reads these at startup.
 */
const worker = process.env.VITEST_POOL_ID;
process.env.DATABASE_URL = testDatabaseUrl();
process.env.FAKE_SUPPLIER_STATE_FILE = process.env.FAKE_SUPPLIER_STATE_FILE?.replace(
  /\.json$/,
  `-${worker}.json`,
);
for (const key of ['TELEGRAM_LOG_DIR', 'EMAIL_LOG_DIR', 'FILES_ROOT']) {
  process.env[key] = `${process.env[key]}-${worker}`;
}
