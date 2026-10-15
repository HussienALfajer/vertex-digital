import { defineConfig } from 'vitest/config';
import { testDatabaseUrl, testOwnerDatabaseUrl } from './src/testing.ts';

export default defineConfig({
  test: {
    globalSetup: ['./src/testing.ts'],
    setupFiles: ['./src/no-concurrent-queries.setup.ts'],
    env: { DATABASE_URL: testDatabaseUrl(), DATABASE_OWNER_URL: testOwnerDatabaseUrl() },
  },
});
