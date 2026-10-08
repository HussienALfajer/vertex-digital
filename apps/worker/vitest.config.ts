import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDatabaseUrl } from '@vertex-digital/db/testing';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Nest injects by the constructor parameter types: emit legacy decorators and their metadata.
  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
  test: {
    globalSetup: ['./test/global-setup.ts'],
    // Set explicitly: the root .env (loaded to find the test database) must not leak in.
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      WORKER_NAME: `test-${randomUUID()}`,
      DATABASE_URL: testDatabaseUrl(),
      SENTRY_DSN: '',
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_ALERTS_CHAT_ID: '',
      // Emails are files in a directory of their own per run (rule E5).
      EMAIL_TRANSPORT: 'log',
      // No chain is ever read in tests; the USDT tests give their own readers.
      CHAIN_READER: 'fake',
      EMAIL_LOG_DIR: join(tmpdir(), `vertex-digital-emails-${randomUUID()}`),
    },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
