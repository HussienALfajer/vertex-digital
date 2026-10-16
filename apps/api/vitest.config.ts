import { fileURLToPath } from 'node:url';
import { TEST_WORKERS } from '@vertex-digital/db/testing';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Nest injects by the constructor parameter types: emit legacy decorators and their metadata.
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
  test: {
    // Each worker has its own test database (packages/db testing.ts): files run in parallel, and
    // files in one worker run one after another on it, so a check that reads global rows (the
    // active owner) sees only its worker's files.
    maxWorkers: TEST_WORKERS,
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: [
      './test/worker-env.ts',
      './test/no-concurrent-queries.ts',
      './test/no-pool-reads-in-transactions.ts',
    ],
    // Set explicitly: the root .env (loaded to find the test database) must not leak in.
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      // test/worker-env.ts sets DATABASE_URL to the worker's database.
      TEST_DATABASE_SUITE: 'api',
      STORE_URL: 'http://127.0.0.1:3001',
      ADMIN_URL: 'http://127.0.0.1:5173',
      SENTRY_DSN: '',
      // Challenges solve in milliseconds in tests.
      ALTCHA_MAX_COUNTER: '20',
      // Uploaded files of the tests, git-ignored.
      FILES_ROOT: './.data/test-files',
      // The Telegram bot is configured; a test turns it off to see the refusal.
      TELEGRAM_BOT_USERNAME: 'vertex_test_bot',
      TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret-0123456789abcdef',
      // S15: push is configured with a fake public key (87 base64url characters, 65 bytes).
      VAPID_PUBLIC_KEY: `BTest${'A'.repeat(82)}`,
      // S07: suppliers are tested with the fake supplier.
      SUPPLIER_FAKE_ENABLED: 'true',
      // S09: the fake's scripted state the player checks read, the tests' own (git-ignored).
      FAKE_SUPPLIER_STATE_FILE: fileURLToPath(
        new URL('./.data/test-fake-supplier.json', import.meta.url),
      ),
    },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
