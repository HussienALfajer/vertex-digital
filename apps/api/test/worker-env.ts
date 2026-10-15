import { testDatabaseUrl } from '@vertex-digital/db/testing';

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
