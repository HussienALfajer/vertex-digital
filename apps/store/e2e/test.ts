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

/** A challenge the browser solves at once (cost 1); the API's signature is not checked here. */
const ALTCHA_CHALLENGE = {
  parameters: {
    algorithm: 'PBKDF2/SHA-256',
    nonce: 'aa',
    salt: 'bb',
    cost: 1,
    keyLength: 32,
    keyPrefix: '0',
    expiresAt: Math.floor(Date.now() / 1000) + 600,
  },
  signature: 'test',
};

/** Every event with an email (and a push): all on, as a customer without a choice has them. */
const ALL_ON = Object.fromEntries(
  [
    'deposit_credited',
    'deposit_rejected',
    'deposit_receipt_requested',
    'wallet_adjusted',
    'order_delivered',
    'order_partially_refunded',
    'order_refunded',
    'order_cancelled',
    'checkout_finished',
    'ticket_replied',
    'order_placed_for_you',
    'merchant_info_requested',
    'merchant_approved',
    'merchant_rejected',
    'merchant_revoked',
  ].map((event) => [event, true]),
);

type Route = Parameters<Parameters<Page['route']>[1]>[0];
type Answer =
  | { status: number; body: unknown }
  | { status: 200; image: true }
  | { status: 200; events: string; delayMs: number };

/**
 * Server-sent events as the API writes them (S05 rule NT6). The body ends after the events, so
 * `retry` keeps `EventSource` from reconnecting during the test.
 */
const eventStream = (events: { event: string; data: unknown }[]) =>
  `retry: 600000\n\n${events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')}`;

/** A 1×1 PNG: what the QR route answers in tests. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** The API as the browser sees it: answers keyed by `METHOD /path`, everything else recorded. */
export class MockApi {
  readonly unexpected: string[] = [];
  readonly requests: { key: string; body: unknown; headers: Record<string, string> }[] = [];
  private readonly answers = new Map<string, Answer>([
    // Signed out unless a test says otherwise: Better Auth answers `null`.
    ['GET /api/auth/get-session', { status: 200, body: null }],
    // Registration open, as locally and in E2E (rule C16).
    ['GET /api/auth/registration', { status: 200, body: { open: true } }],
    // Nothing stopped: the stop banner reads it on every page (S05 rule SW9).
    [
      'GET /api/store/status',
      {
        status: 200,
        body: { registrationOpen: true, purchasesStopped: false, depositsStopped: false },
      },
    ],
    // A real challenge needs the API's key; the mock only checks that one is fetched and sent.
    ['GET /api/altcha/challenge', { status: 200, body: ALTCHA_CHALLENGE }],
    // An empty wallet: the header's balance chip reads it on every page once signed in (S02 W8).
    ['GET /api/wallet', { status: 200, body: { balanceUnits: 0, syp: null } }],
    // Every email and push on (S05 rule NT8, S15 PP1): the account page reads the choices.
    [
      'GET /api/account/notification-preferences',
      { status: 200, body: { email: ALL_ON, push: ALL_ON } },
    ],
    // Push not configured (S15): no push control shows unless a test serves a key.
    ['GET /api/push/config', { status: 200, body: { publicKey: null } }],
    // A retail account (S20 AT4): the search reads the price kind on open once signed in.
    [
      'GET /api/account',
      {
        status: 200,
        body: {
          id: '0199e000-0000-7000-8000-0000000000aa',
          name: 'سارة الأحمد',
          email: 'sara@example.com',
          phone: '+963944123456',
          createdAt: '2026-10-01T09:00:00.000Z',
          priceKind: 'retail',
          accountType: 'customer',
          merchant: null,
        },
      },
    ],
    // S20: no merchant terms published and no application: the account page's card says "soon".
    [
      'GET /api/merchant/application',
      {
        status: 200,
        body: { application: null, canApply: false, availableAt: null, termsVersionId: null },
      },
    ],
    // No saved player ID: the buy box reads them once signed in (S10 rule SP3).
    ['GET /api/saved-players', { status: 200, body: { items: [] } }],
    // No unread notification: the header's bell opens the stream once signed in (S05 NT6).
    [
      'GET /api/notifications/stream',
      {
        status: 200,
        events: eventStream([{ event: 'unread', data: { unreadCount: 0 } }]),
        delayMs: 0,
      },
    ],
  ]);

  /** The last request sent to `key`. */
  last(key: string) {
    return this.requests.findLast((request) => request.key === key);
  }

  on(key: string, status: number, body: unknown = {}): this {
    this.answers.set(key, { status, body });
    return this;
  }

  /**
   * Answers `key` with server-sent events (the notification stream), after `delayMs`: a test can
   * change what the page reads next before the events arrive (S09 rule LT2).
   */
  stream(key: string, events: { event: string; data: unknown }[], delayMs = 0): this {
    this.answers.set(key, { status: 200, events: eventStream(events), delayMs });
    return this;
  }

  /** Answers `key` with an image (a QR code). */
  image(key: string): this {
    this.answers.set(key, { status: 200, image: true });
    return this;
  }

  async answer(route: Route): Promise<void> {
    const request = route.request();
    const key = `${request.method()} ${new URL(request.url()).pathname}`;
    this.requests.push({ key, body: bodyOf(request), headers: request.headers() });
    // Catalog images are public files on every catalog page (S09 rule SF5): a PNG by default.
    const answer =
      this.answers.get(key) ??
      (key.startsWith('GET /api/catalog/images/')
        ? ({ status: 200, image: true } as const)
        : null) ??
      // S20 AT4: a signed-in account reads its own prices of a game: retail unless a test says.
      (/^GET \/api\/catalog\/games\/[^/]+\/prices$/.test(key)
        ? { status: 200, body: { priceKind: 'retail', products: [], rateId: null } }
        : null);
    if (!answer) {
      this.unexpected.push(key);
      await route.fulfill({ status: 404, json: { statusCode: 404, code: 'NOT_FOUND' } });
      return;
    }
    if ('image' in answer) {
      await route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
      return;
    }
    if ('events' in answer) {
      if (answer.delayMs > 0) await new Promise((done) => setTimeout(done, answer.delayMs));
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: answer.events });
      return;
    }
    await route.fulfill({ status: answer.status, json: answer.body });
  }
}

/** A JSON body as sent, the raw text of a multipart one (a receipt), or null. */
function bodyOf(request: ReturnType<Route['request']>): unknown {
  try {
    return request.postDataJSON();
  } catch {
    return request.postData();
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
