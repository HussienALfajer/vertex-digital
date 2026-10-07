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

const declared = Object.entries(openapi.paths as Record<string, Record<string, unknown>>).map(
  ([path, operations]) => ({
    pattern: new RegExp(`^${path.replace(/\{[^}]+\}/g, '[^/]+')}$`),
    methods: new Set(Object.keys(operations).map((method) => method.toUpperCase())),
  }),
);

/**
 * The admin Better Auth instance and the API as the panel sees them, with the state a sign-in
 * moves through: signed out, waiting for the TOTP step, signed in (with or without TOTP).
 */
export class AdminApi {
  readonly unexpected: string[] = [];
  readonly calls: string[] = [];
  user = {
    id: '0199a000-0000-7000-8000-000000000001',
    name: 'ريم الخطيب',
    email: 'reem@example.com',
    twoFactorEnabled: true,
  };
  signedIn = false;
  /** Answers the next sign-in with `ALTCHA_REQUIRED` unless it carries a solved challenge. */
  altchaRequired = false;
  private pendingTwoFactor = false;

  async answer(route: Route): Promise<void> {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const key = `${request.method()} ${path}`;
    this.calls.push(key);
    const body = request.postDataJSON() as Record<string, unknown> | null;
    const json = (status: number, value: unknown) => route.fulfill({ status, json: value });

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
      case 'POST /api/admin/auth/sign-out':
        this.signedIn = false;
        return json(200, { success: true });
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
