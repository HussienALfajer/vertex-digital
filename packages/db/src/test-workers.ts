import { availableParallelism } from 'node:os';

/**
 * Parallel Vitest workers of each app suite (`api`, `worker`), each with a test database of its own
 * (testing.ts). `TEST_WORKERS` sets the number; otherwise half the logical CPUs, from 4 (CI
 * runners) to 12. The suites mostly wait on their HTTP and database round trips, so a worker per
 * two CPUs keeps a large machine busy. Pools open connections on demand: with the test apps' pool
 * limit (`DATABASE_POOL_MAX` in each app's vitest.config.ts), the db, api and worker suites at 12
 * workers each peaked at 41 connections of PostgreSQL's default 100 (docs/testing.md), although
 * their caps (pg-boss's and the test files' own pools too) add up to more. Shared with
 * scripts/setup-local-db.mjs, which creates the databases: it imports nothing local.
 */
export function testWorkers(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.TEST_WORKERS;
  if (value === undefined || value === '') {
    return Math.min(12, Math.max(4, Math.floor(availableParallelism() / 2)));
  }
  const workers = Number(value);
  if (!Number.isInteger(workers) || workers < 1 || workers > 32) {
    throw new Error(`TEST_WORKERS must be a whole number from 1 to 32, not "${value}".`);
  }
  return workers;
}
