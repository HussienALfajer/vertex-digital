import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEST_WORKERS } from '@vertex-digital/db/testing';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Nest injects by the constructor parameter types: emit legacy decorators and their metadata.
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
  test: {
    // Each worker has its own test database (packages/db testing.ts): files run in parallel, and
    // files in one worker run one after another on it, so a job that acts on global rows
    // (`deposits.expire` expires every overdue pending deposit) sees only its worker's files.
    maxWorkers: TEST_WORKERS,
    // A worker keeps its modules from one file to the next instead of loading the whole app again
    // for each file. Each file still starts its own app and seeds its own rows; test/worker-env.ts
    // puts process.env and the spies back after each file, and the setup files' guards report per
    // file (packages/db testing.ts). A run with shuffled files passed whole (2026-10-26).
    isolate: false,
    globalSetup: ['./test/global-setup.ts'],
    // worker-env.ts last: hooks run in reverse, so its afterAll puts the environment back first,
    // even when a guard's afterAll fails the file and skips the hooks after it.
    setupFiles: [
      './test/no-concurrent-queries.ts',
      './test/no-pool-reads-in-transactions.ts',
      './test/worker-env.ts',
    ],
    // Set explicitly: the root .env (loaded to find the test database) must not leak in.
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      // Each worker's app opens at most 4 connections, so both suites' workers fit PostgreSQL's
      // default 100 while Turborepo runs them at the same time (packages/db test-workers.ts).
      DATABASE_POOL_MAX: '4',
      WORKER_NAME: `test-${randomUUID()}`,
      // test/worker-env.ts sets DATABASE_URL to the worker's database.
      TEST_DATABASE_SUITE: 'worker',
      SENTRY_DSN: '',
      TELEGRAM_BOT_TOKEN: '',
      // Bot messages are files in a directory of their own per run.
      TELEGRAM_TRANSPORT: 'log',
      TELEGRAM_LOG_DIR: join(tmpdir(), `vertex-digital-telegram-${randomUUID()}`),
      // Emails are files in a directory of their own per run (rule E5).
      EMAIL_TRANSPORT: 'log',
      // No chain is ever read in tests; the USDT tests give their own readers.
      CHAIN_READER: 'fake',
      EMAIL_LOG_DIR: join(tmpdir(), `vertex-digital-emails-${randomUUID()}`),
      // Receipts the card tests write for themselves (S05 rule TC2).
      FILES_ROOT: join(tmpdir(), `vertex-digital-files-${randomUUID()}`),
      ADMIN_URL: 'http://127.0.0.1:5173',
      // The supplier jobs run against the fake supplier (S07); its state file is this run's own.
      SUPPLIER_FAKE_ENABLED: 'true',
      SUPPLIER_KEYS_SECRET: '',
      FAKE_SUPPLIER_STATE_FILE: join(tmpdir(), `vertex-digital-fake-supplier-${randomUUID()}.json`),
    },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
