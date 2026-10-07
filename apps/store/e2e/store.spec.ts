import { gzipSync } from 'node:zlib';
import ar from '../src/messages/ar.json' with { type: 'json' };
import { expect, screenshot, test } from './test';

const lightTheme = () => localStorage.setItem('vertex-theme', 'light');

test.describe('shell', () => {
  test('home renders in Arabic, right to left, dark by default', async ({ page, api: _api }) => {
    await page.goto('/');
    const html = page.locator('html');
    await expect(html).toHaveAttribute('lang', 'ar');
    await expect(html).toHaveAttribute('dir', 'rtl');
    await expect(html).toHaveClass(/dark/);
    await expect(page.getByRole('heading', { level: 1, name: ar.home.title })).toBeVisible();
    await expect(page.getByRole('link', { name: ar.header.signIn })).toBeVisible();
    // Nothing overflows the phone width.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
  });

  test('the light theme is a switch away and is remembered', async ({ page, api: _api }) => {
    await page.goto('/');
    await page.getByRole('button', { name: ar.theme.toLight }).click();
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await page.reload();
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await expect(page.getByRole('button', { name: ar.theme.toDark })).toBeVisible();
  });

  test('an unknown page says what to do next', async ({ page, api: _api }) => {
    await page.goto('/no-such-page');
    await expect(page.getByText(ar.notFound.title)).toBeVisible();
    await page.getByRole('link', { name: ar.notFound.back }).click();
    await expect(page).toHaveURL('/');
  });
});

test.describe('sign-in', () => {
  test('signs a customer in and shows the account in the header', async ({ page, api }) => {
    api.on('POST /api/auth/sign-in/email', 200, { redirect: false, token: 'x' });
    await page.goto('/sign-in');
    await page.getByLabel(ar.signIn.email).fill('customer@example.com');
    await page.getByLabel(ar.signIn.password, { exact: true }).fill('a-long-password');
    api.on('GET /api/auth/get-session', 200, {
      user: { name: 'سامي', email: 'customer@example.com' },
      session: {},
    });
    await page.getByRole('button', { name: ar.signIn.submit }).click();
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('button', { name: ar.header.signOut })).toBeVisible();
    expect(api.requests.find((r) => r.key === 'POST /api/auth/sign-in/email')?.body).toEqual({
      email: 'customer@example.com',
      password: 'a-long-password',
    });
  });

  test('a wrong password says what to do', async ({ page, api }) => {
    api.on('POST /api/auth/sign-in/email', 401, { code: 'INVALID_EMAIL_OR_PASSWORD' });
    await page.goto('/sign-in');
    await page.getByLabel(ar.signIn.email).fill('customer@example.com');
    await page.getByLabel(ar.signIn.password, { exact: true }).fill('wrong-password');
    await page.getByRole('button', { name: ar.signIn.submit }).click();
    // Next.js adds its own route announcer with the same role.
    await expect(
      page.getByRole('alert').filter({ hasText: ar.errors.INVALID_EMAIL_OR_PASSWORD }),
    ).toBeVisible();
    await expect(page).toHaveURL('/sign-in');
  });

  test('empty fields are refused before any request', async ({ page, api }) => {
    await page.goto('/sign-in');
    await page.getByRole('button', { name: ar.signIn.submit }).click();
    await expect(page.getByText(ar.signIn.emailRequired)).toBeVisible();
    await expect(page.getByText(ar.signIn.passwordRequired)).toBeVisible();
    await expect(page.getByLabel(ar.signIn.email)).toBeFocused();
    expect(api.requests.some((r) => r.key.startsWith('POST'))).toBe(false);
  });
});

// RTL screenshots in both themes: the design review evidence (ADR 0011).
for (const theme of ['dark', 'light'] as const) {
  test(`screenshots, ${theme} theme`, async ({ page, api: _api }, testInfo) => {
    if (theme === 'light') await page.addInitScript(lightTheme);
    for (const [name, path] of [
      ['home', '/'],
      ['sign-in', '/sign-in'],
    ] as const) {
      await page.goto(path);
      await expect(page.locator('h1')).toBeVisible();
      await screenshot(page, testInfo, `${name}-${theme}`);
    }
  });
}

/**
 * Performance budget of the first page (ADR 0008: Syrian connections). Sizes are gzipped, as
 * nginx sends them; Brotli is smaller still. Raise a budget only with a reason in the PR.
 */
const BUDGET_KB = { script: 200, stylesheet: 20 };

test('the home page stays within its performance budget', async ({ page, api: _api }) => {
  test.skip(test.info().project.name !== 'desktop', 'measured once');
  const sizes = { script: 0, stylesheet: 0 };
  const pending: Promise<void>[] = [];
  page.on('response', (response) => {
    const type = response.request().resourceType();
    if (type !== 'script' && type !== 'stylesheet') return;
    pending.push(
      response.body().then((body) => {
        sizes[type] += gzipSync(body).length;
      }),
    );
  });
  await page.goto('/', { waitUntil: 'networkidle' });
  await Promise.all(pending);
  const kb = (bytes: number) => Math.round(bytes / 1024);
  test.info().annotations.push({
    type: 'first load (gzip)',
    description: `JS ${kb(sizes.script)} KB, CSS ${kb(sizes.stylesheet)} KB`,
  });
  expect(kb(sizes.script)).toBeLessThanOrEqual(BUDGET_KB.script);
  expect(kb(sizes.stylesheet)).toBeLessThanOrEqual(BUDGET_KB.stylesheet);
});
