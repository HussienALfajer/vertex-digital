import { defineConfig, devices } from '@playwright/test';
import { CATALOG_PORT, E2E_REVALIDATE_SECRET, EMPTY_STORE_URL } from './e2e/servers';

const baseURL = 'http://127.0.0.1:4001';

const storeEnv = (api: string, port: number) => ({
  API_INTERNAL_URL: api,
  STORE_URL: `http://127.0.0.1:${port}`,
  STORE_REVALIDATE_SECRET: E2E_REVALIDATE_SECRET,
});

export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  // One retry keeps a runner hiccup from failing CI, but a test that only passes on retry fails
  // the run: flaky tests hide real intermittent bugs.
  retries: process.env.CI ? 1 : 0,
  failOnFlakyTests: !!process.env.CI,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    locale: 'ar',
    timezoneId: 'Asia/Damascus',
    trace: 'retain-on-failure',
  },
  // Phone width first (brand/identity.md §6), then desktop.
  projects: [
    { name: 'phone', use: { ...devices['Desktop Chrome'], viewport: { width: 360, height: 780 } } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
  ],
  // The production build; `pnpm test:e2e` from the root builds it first. The API is mocked per
  // test in the browser (e2e/test.ts), and the catalog the server components read is served by
  // e2e/catalog-server.mjs, so no database or API process is needed.
  webServer: [
    {
      command: `node e2e/catalog-server.mjs ${CATALOG_PORT}`,
      url: `http://127.0.0.1:${CATALOG_PORT}/health`,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'pnpm start --port 4001',
      url: baseURL,
      env: storeEnv(`http://127.0.0.1:${CATALOG_PORT}`, 4001),
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'pnpm start --port 4003',
      url: EMPTY_STORE_URL,
      env: storeEnv(`http://127.0.0.1:${CATALOG_PORT}/empty`, 4003),
      reuseExistingServer: !process.env.CI,
    },
  ],
});
