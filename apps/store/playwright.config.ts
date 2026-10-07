import { defineConfig, devices } from '@playwright/test';

const baseURL = 'http://127.0.0.1:4001';

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
  // test in the browser (e2e/test.ts), so no database or API process is needed.
  webServer: {
    command: 'pnpm start --port 4001',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
  },
});
