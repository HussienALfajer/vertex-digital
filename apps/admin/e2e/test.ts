import { test as base, expect, type Page, type TestInfo } from '@playwright/test';
import openapi from '../../api/openapi.json' with { type: 'json' };

/*
 * The `test` every admin spec uses: Playwright's, with a mocked API (`admin`) and failing a test
 * when the page throws, React or Base UI log an error, or the page calls a route the mock does not
 * answer or the API does not declare (`apps/api/openapi.json`; Better Auth routes are outside it).
 */

type Route = Parameters<Parameters<Page['route']>[1]>[0];

export const TOTP_CODE = '123456';
export const BACKUP_CODE = 'abcde-fghjk';
export const PASSWORD = 'correct-horse-battery';
export const NEW_PASSWORD = 'a7Kq-blue-moon-river';
/** What the API would generate for a test customer: a test value only. */
export const GENERATED_PASSWORD = 'b8Lr-green-sea-lake';

export const ADMIN_ID = '0199a000-0000-7000-8000-000000000001';
export const CUSTOMER_ID = '0199a000-0000-7000-8000-000000000010';

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

/** Audit entries newest first: each kind of actor, and a change with before and after. */
export const AUDIT_ENTRIES = [
  {
    id: '0199a000-0000-7000-8000-0000000000e4',
    occurredAt: '2026-10-08T09:30:00.000Z',
    actorKind: 'customer',
    actorId: CUSTOMER_ID,
    actorName: 'سارة الأحمد',
    channel: 'store',
    action: 'customer.profile_updated',
    entityType: 'customer',
    entityId: CUSTOMER_ID,
    reason: null,
    details: {
      before: { name: 'سارة', phone: '+963944123456' },
      after: { name: 'سارة الأحمد', phone: '+963933000111' },
    },
    ipAddress: '5.0.0.1',
    userAgent: CHROME_WINDOWS,
  },
  {
    id: '0199a000-0000-7000-8000-0000000000e3',
    occurredAt: '2026-10-08T09:00:00.000Z',
    actorKind: 'admin',
    actorId: ADMIN_ID,
    actorName: 'ريم الخطيب',
    channel: 'admin',
    action: 'customer.test_created',
    entityType: 'customer',
    entityId: CUSTOMER_ID,
    reason: null,
    details: { name: 'سارة الأحمد', email: 'sara@example.com', phone: '+963944123456' },
    ipAddress: '5.0.0.9',
    userAgent: CHROME_WINDOWS,
  },
  {
    id: '0199a000-0000-7000-8000-0000000000e2',
    occurredAt: '2026-10-07T20:00:00.000Z',
    actorKind: 'admin',
    actorId: ADMIN_ID,
    actorName: 'ريم الخطيب',
    channel: 'admin',
    action: 'admin.signed_in',
    entityType: 'admin_user',
    entityId: ADMIN_ID,
    reason: null,
    details: {},
    ipAddress: '5.0.0.9',
    userAgent: CHROME_WINDOWS,
  },
  {
    id: '0199a000-0000-7000-8000-0000000000e1',
    occurredAt: '2026-10-07T19:00:00.000Z',
    actorKind: 'cli',
    actorId: null,
    actorName: null,
    channel: 'cli',
    action: 'admin.created',
    entityType: 'admin_user',
    entityId: ADMIN_ID,
    reason: null,
    details: { name: 'ريم الخطيب', email: 'reem@example.com' },
    ipAddress: null,
    userAgent: null,
  },
];

/** The mock's audit page size: small, so "load more" shows. */
export const AUDIT_PAGE_SIZE = 3;

const declared = Object.entries(openapi.paths as Record<string, Record<string, unknown>>).map(
  ([path, operations]) => ({
    pattern: new RegExp(`^${path.replace(/\{[^}]+\}/g, '[^/]+')}$`),
    methods: new Set(Object.keys(operations).map((method) => method.toUpperCase())),
  }),
);

const RESET_PASSWORD_PATH = /^\/api\/admin\/test-customers\/[^/]+\/reset-password$/;
const OWN_SESSION_PATH = /^\/api\/admin\/me\/sessions\/([^/]+)$/;

interface TestCustomer {
  id: string;
  name: string;
  email: string;
  phone: string;
  createdAt: string;
}

/**
 * The admin Better Auth instance and the API as the panel sees them, with the state a sign-in
 * moves through: signed out, waiting for the TOTP step, signed in (with or without TOTP), and the
 * S01 account state (password change, idle expiry, re-authentication).
 */
export class AdminApi {
  readonly unexpected: string[] = [];
  readonly calls: string[] = [];
  readonly bodies: { key: string; body: unknown }[] = [];
  user = {
    id: ADMIN_ID,
    name: 'ريم الخطيب',
    email: 'reem@example.com',
    twoFactorEnabled: true,
    mustChangePassword: false,
  };
  signedIn = false;
  /** Answers the next sign-in with `ALTCHA_REQUIRED` unless it carries a solved challenge. */
  altchaRequired = false;
  /** The next API request finds the session idle for 30 minutes (rule D4). */
  idleExpired = false;
  /** Sensitive routes answer `REAUTHENTICATION_REQUIRED` until a re-authentication (rule D5). */
  reauthenticationRequired = false;
  testCustomers: TestCustomer[] = [];
  sessions = [
    {
      id: '0199a000-0000-7000-8000-0000000000a1',
      createdAt: '2026-10-08T08:00:00.000Z',
      lastActiveAt: '2026-10-08T09:40:00.000Z',
      expiresAt: '2026-10-08T20:00:00.000Z',
      ipAddress: '5.0.0.9',
      userAgent: CHROME_WINDOWS,
      current: true,
    },
    {
      id: '0199a000-0000-7000-8000-0000000000a2',
      createdAt: '2026-10-08T07:00:00.000Z',
      lastActiveAt: '2026-10-08T07:10:00.000Z',
      expiresAt: '2026-10-08T19:00:00.000Z',
      ipAddress: '5.0.0.7',
      userAgent: SAFARI_IPHONE,
      current: false,
    },
  ];
  private pendingTwoFactor = false;

  /** The body of the last request to `key`. */
  lastBody(key: string): unknown {
    return this.bodies.findLast((entry) => entry.key === key)?.body;
  }

  async answer(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const key = `${request.method()} ${path}`;
    this.calls.push(key);
    const body = request.postDataJSON() as Record<string, unknown> | null;
    this.bodies.push({ key, body });
    const json = (status: number, value: unknown) => route.fulfill({ status, json: value });
    const apiError = (status: number, code: string) =>
      json(status, { statusCode: status, code, message: code });

    if (
      this.idleExpired &&
      path.startsWith('/api/admin/') &&
      !path.startsWith('/api/admin/auth/')
    ) {
      this.idleExpired = false;
      this.signedIn = false;
      return apiError(401, 'SESSION_IDLE_EXPIRED');
    }
    if (request.method() === 'POST' && RESET_PASSWORD_PATH.test(path)) {
      if (this.reauthenticationRequired) return apiError(403, 'REAUTHENTICATION_REQUIRED');
      return json(200, { password: GENERATED_PASSWORD });
    }
    const ownSession = path.match(OWN_SESSION_PATH);
    if (request.method() === 'DELETE' && ownSession) {
      this.sessions = this.sessions.filter((session) => session.id !== ownSession[1]);
      return route.fulfill({ status: 204 });
    }

    switch (key) {
      case 'GET /api/admin/auth/get-session':
        return json(200, this.signedIn ? { session: { id: 's' }, user: this.user } : null);
      case 'POST /api/admin/auth/sign-in/email': {
        if (this.altchaRequired && !request.headers()['x-altcha']) {
          return json(400, { code: 'ALTCHA_REQUIRED', message: 'Solve the challenge first' });
        }
        if (body?.password !== PASSWORD) {
          return json(401, { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid' });
        }
        if (this.user.twoFactorEnabled) {
          this.pendingTwoFactor = true;
          return json(200, { twoFactorRedirect: true });
        }
        this.signedIn = true;
        return json(200, { redirect: false, token: 't', user: this.user });
      }
      case 'POST /api/admin/auth/two-factor/verify-totp':
        if (body?.code !== TOTP_CODE) return json(401, { code: 'INVALID_CODE', message: 'x' });
        // At sign-in it opens the session; during enrolment it turns TOTP on.
        if (this.pendingTwoFactor) this.signedIn = true;
        this.pendingTwoFactor = false;
        this.user = { ...this.user, twoFactorEnabled: true };
        return json(200, { token: 't', user: this.user });
      case 'POST /api/admin/auth/two-factor/verify-backup-code':
        if (body?.code !== BACKUP_CODE) {
          return json(401, { code: 'INVALID_BACKUP_CODE', message: 'x' });
        }
        this.signedIn = true;
        return json(200, { token: 't', user: this.user });
      case 'POST /api/admin/auth/two-factor/enable':
        if (body?.password !== PASSWORD)
          return json(400, { code: 'INVALID_PASSWORD', message: 'x' });
        return json(200, {
          totpURI:
            'otpauth://totp/Vertex%20Digital:reem?secret=JBSWY3DPEHPK3PXP&issuer=Vertex%20Digital',
          backupCodes: [BACKUP_CODE, 'bcdef-ghjkm'],
        });
      case 'POST /api/admin/auth/two-factor/generate-backup-codes':
        if (body?.password !== PASSWORD) {
          return json(400, { code: 'INVALID_PASSWORD', message: 'x' });
        }
        return json(200, { status: true, backupCodes: ['hjkmn-pqrst', 'uvwxy-z2345'] });
      case 'POST /api/admin/auth/change-password':
        if (body?.currentPassword !== PASSWORD) return apiError(400, 'INVALID_PASSWORD');
        this.user = { ...this.user, mustChangePassword: false };
        return json(200, { success: true });
      case 'POST /api/admin/auth/sign-out':
        this.signedIn = false;
        return json(200, { success: true });
      case 'POST /api/admin/me/reauthenticate':
        if (body?.password !== PASSWORD) return apiError(400, 'INVALID_PASSWORD');
        if (body?.totpCode !== TOTP_CODE) return apiError(400, 'INVALID_CODE');
        this.reauthenticationRequired = false;
        return json(200, { reauthenticatedUntil: '2026-10-08T10:05:00.000Z' });
      case 'GET /api/admin/me/sessions':
        return json(200, this.sessions);
      case 'GET /api/admin/audit': {
        const filter = (name: string, value: string | null) => {
          const wanted = url.searchParams.get(name);
          return !wanted || wanted === value;
        };
        const matching = AUDIT_ENTRIES.filter(
          (entry) =>
            filter('actorKind', entry.actorKind) &&
            filter('actorId', entry.actorId) &&
            filter('action', entry.action) &&
            filter('entityType', entry.entityType) &&
            filter('entityId', entry.entityId),
        );
        const start = Number(url.searchParams.get('cursor') ?? 0);
        const end = start + AUDIT_PAGE_SIZE;
        return json(200, {
          items: matching.slice(start, end),
          nextCursor: end < matching.length ? String(end) : null,
        });
      }
      case 'GET /api/admin/test-customers':
        return json(200, { items: this.testCustomers, nextCursor: null });
      case 'POST /api/admin/test-customers': {
        if (this.testCustomers.some((customer) => customer.email === body?.email)) {
          return apiError(409, 'EMAIL_TAKEN');
        }
        const customer = {
          id: CUSTOMER_ID,
          name: String(body?.name),
          email: String(body?.email),
          phone: String(body?.phone),
          createdAt: '2026-10-08T09:00:00.000Z',
        };
        this.testCustomers = [customer, ...this.testCustomers];
        return json(201, { ...customer, password: GENERATED_PASSWORD });
      }
      case 'GET /api/altcha/challenge':
        // A real challenge needs the API's key; the mock only checks that one is fetched and sent.
        return json(200, {
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
        });
    }
    const isDeclared =
      path.startsWith('/api/admin/auth/') ||
      declared.some((route) => route.pattern.test(path) && route.methods.has(request.method()));
    this.unexpected.push(isDeclared ? key : `${key} (not in openapi.json)`);
    return json(404, { statusCode: 404, code: 'NOT_FOUND', message: 'Not mocked' });
  }
}

export const test = base.extend<{ admin: AdminApi }>({
  admin: async ({ page }, use) => {
    const admin = new AdminApi();
    await page.route('**/api/**', (route) => admin.answer(route));
    await use(admin);
    expect(admin.unexpected, 'API requests without a mock').toEqual([]);
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

/** A screenshot attached to the report: the RTL review evidence of each run. */
export async function screenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

export { expect };
