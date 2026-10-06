import { loadRootEnv } from './env.js';
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

/** Vitest global setup: bring the test database schema up to date before any test runs. */
export async function setup(): Promise<void> {
  await runMigrations(testOwnerDatabaseUrl());
}
