import { testDatabaseUrl } from '@vertex-digital/db/testing';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Nest injects by the constructor parameter types: emit legacy decorators and their metadata.
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
  test: {
    // Files share one test database; some checks read global rows (the active owner).
    fileParallelism: false,
    globalSetup: ['./test/global-setup.ts'],
    // Set explicitly: the root .env (loaded to find the test database) must not leak in.
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: testDatabaseUrl(),
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
      // S07: suppliers are tested with the fake supplier.
      SUPPLIER_FAKE_ENABLED: 'true',
    },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
