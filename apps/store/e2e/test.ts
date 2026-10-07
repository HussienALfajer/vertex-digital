import { test as base, expect, type Page, type TestInfo } from '@playwright/test';

/*
 * The `test` every store spec uses: Playwright's, failing a test when the page throws, React or
 * Base UI report an error, or the page calls an API route the test did not mock.
 */
export const test = base.extend<{ api: MockApi }>({
  api: async ({ page }, use) => {
    const api = new MockApi();
    await page.route('**/api/**', (route) => api.answer(route));
    await use(api);
    expect(api.unexpected, 'API requests without a mock').toEqual([]);
  },
  page: async ({ page }, use) => {
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(`Page error: ${error.message}`));
    page.on('console', (message) => {
      // Mocked HTTP errors are logged by the browser; they are the behaviour under test.
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) {
        failures.push(`Console: ${message.text()}`);
      }
    });
    await use(page);
    expect(failures).toEqual([]);
  },
});

type Route = Parameters<Parameters<Page['route']>[1]>[0];
type Answer = { status: number; body: unknown };

/** The API as the browser sees it: answers keyed by `METHOD /path`, everything else recorded. */
export class MockApi {
  readonly unexpected: string[] = [];
  readonly requests: { key: string; body: unknown }[] = [];
  private readonly answers = new Map<string, Answer>([
    // Signed out unless a test says otherwise: Better Auth answers `null`.
    ['GET /api/auth/get-session', { status: 200, body: null }],
  ]);

  on(key: string, status: number, body: unknown = {}): this {
    this.answers.set(key, { status, body });
    return this;
  }

  async answer(route: Route): Promise<void> {
    const request = route.request();
    const key = `${request.method()} ${new URL(request.url()).pathname}`;
    this.requests.push({ key, body: request.postDataJSON() });
    const answer = this.answers.get(key);
    if (!answer) {
      this.unexpected.push(key);
      await route.fulfill({ status: 404, json: { statusCode: 404, code: 'NOT_FOUND' } });
      return;
    }
    await route.fulfill({ status: answer.status, json: answer.body });
  }
}

/** A full-page screenshot attached to the report: the RTL review evidence of each run. */
export async function screenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

export { expect };
