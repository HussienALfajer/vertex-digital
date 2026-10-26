import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import { BACKUP_CODE, expect, PASSWORD, screenshot, TOTP_CODE, test } from './test';

async function signInWithPassword(page: import('@playwright/test').Page, password = PASSWORD) {
  await page.getByLabel(ar.login.email).fill('reem@example.com');
  await page.getByLabel(ar.login.password, { exact: true }).fill(password);
  await page.getByRole('button', { name: ar.login.submit }).click();
}

test('a signed-out visitor lands on the sign-in page, in Arabic, right to left', async ({
  page,
  admin: _admin,
}) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login\?redirect=%2F$/);
  const html = page.locator('html');
  await expect(html).toHaveAttribute('lang', 'ar');
  await expect(html).toHaveAttribute('dir', 'rtl');
  await expect(page.getByRole('heading', { level: 1, name: ar.login.title })).toBeVisible();
});

test('signs in with the password and the TOTP code, then signs out', async ({ page, admin }) => {
  await page.goto('/');
  await signInWithPassword(page);
  await expect(page.getByRole('heading', { name: ar.login.twoFactor.title })).toBeVisible();
  await page.getByRole('textbox').first().pressSequentially(TOTP_CODE);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    ar.home.title.replace('{{name}}', admin.user.name),
  );
  await expect(page.getByRole('navigation', { name: ar.nav.label })).toBeVisible();

  await page.getByRole('button', { name: ar.user.menu }).click();
  await page.getByRole('menuitem', { name: ar.user.signOut }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(admin.calls).toContain('POST /api/admin/auth/sign-out');
});

test('a sign-out the server did not confirm says so and stays signed in (A01-20)', async ({
  page,
  admin,
}) => {
  admin.signedIn = true;
  await page.goto('/account');
  await page.route(
    '**/api/admin/auth/sign-out',
    (route) => route.fulfill({ status: 500, json: { code: 'INTERNAL_ERROR' } }),
    { times: 1 },
  );
  await page.getByRole('button', { name: ar.user.menu }).click();
  await page.getByRole('menuitem', { name: ar.user.signOut }).click();
  await expect(page.getByText(ar.user.signOutFailed)).toBeVisible();
  await expect(page).toHaveURL(/\/account$/);
  // Once the server answers, the sign-out leaves.
  await page.getByRole('button', { name: ar.user.menu }).click();
  await page.getByRole('menuitem', { name: ar.user.signOut }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect(admin.signedIn).toBe(false);
});

test('the setup pages sign out the same way (A01-20)', async ({ page, admin }) => {
  admin.user.mustChangePassword = true;
  admin.signedIn = true;
  await page.goto('/change-password');
  await page.route(
    '**/api/admin/auth/sign-out',
    (route) => route.fulfill({ status: 500, json: { code: 'INTERNAL_ERROR' } }),
    { times: 1 },
  );
  await page.getByRole('button', { name: ar.changePassword.signOut }).click();
  await expect(page.getByText(ar.user.signOutFailed)).toBeVisible();
  await expect(page).toHaveURL(/\/change-password$/);
  await page.getByRole('button', { name: ar.changePassword.signOut }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test('a failed session read after the code says so, and its retry enters (A01-27)', async ({
  page,
  admin: _admin,
}) => {
  await page.goto('/login');
  await signInWithPassword(page);
  await expect(page.getByRole('heading', { name: ar.login.twoFactor.title })).toBeVisible();
  await page.route(
    '**/api/admin/auth/get-session',
    (route) => route.fulfill({ status: 500, json: { code: 'INTERNAL_ERROR' } }),
    { times: 1 },
  );
  await page.getByRole('textbox').first().pressSequentially(TOTP_CODE);
  await expect(page.getByText(ar.errors.network)).toBeVisible();
  await page.getByRole('button', { name: ar.common.retry }).click();
  await expect(page.getByRole('navigation', { name: ar.nav.label })).toBeVisible();
});

test('a wrong password and a wrong code say what happened', async ({ page, admin: _admin }) => {
  await page.goto('/login');
  await signInWithPassword(page, 'wrong');
  await expect(
    page.getByRole('alert').filter({ hasText: ar.errors.auth.INVALID_EMAIL_OR_PASSWORD }),
  ).toBeVisible();

  await signInWithPassword(page);
  await page.getByRole('textbox').first().pressSequentially('000000');
  await expect(
    page.getByRole('alert').filter({ hasText: ar.errors.auth.INVALID_CODE }),
  ).toBeVisible();
});

test('signs in with a backup code instead of the app', async ({ page, admin: _admin }) => {
  await page.goto('/login');
  await signInWithPassword(page);
  await page.getByRole('button', { name: ar.login.twoFactor.useBackup }).click();
  await page.getByLabel(ar.login.twoFactor.backupCode).fill(` ${BACKUP_CODE.toUpperCase()} `);
  await page.getByRole('button', { name: ar.login.twoFactor.submit }).click();
  await expect(page.getByRole('navigation', { name: ar.nav.label })).toBeVisible();
});

test('solves the ALTCHA challenge when the API asks for it, then signs in', async ({
  page,
  admin,
}) => {
  admin.altchaRequired = true;
  await page.goto('/login');
  await signInWithPassword(page);
  await expect(page.getByRole('heading', { name: ar.login.twoFactor.title })).toBeVisible();
  expect(admin.calls).toContain('GET /api/altcha/challenge');
  expect(admin.calls.filter((call) => call === 'POST /api/admin/auth/sign-in/email')).toHaveLength(
    2,
  );
});

test('the admin without TOTP enrols before reaching the panel', async ({ page, admin }) => {
  admin.user.twoFactorEnabled = false;
  await page.goto('/login');
  await signInWithPassword(page);
  await expect(page).toHaveURL(/\/setup-two-factor$/);
  // The sign-in page has a password field with the same label: fill only once it is gone.
  await expect(page.getByRole('heading', { name: ar.twoFactorSetup.title })).toBeVisible();

  await page.getByLabel(ar.twoFactorSetup.password, { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: ar.twoFactorSetup.start }).click();
  await expect(page.getByRole('img', { name: ar.twoFactorSetup.qrLabel })).toBeVisible();
  await page.getByRole('textbox').first().pressSequentially(TOTP_CODE);

  await expect(page.getByText(BACKUP_CODE)).toBeVisible();
  // Copy or download as text, wherever the codes are shown (S01 screens, A01-28).
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: ar.account.backupCodes.download }).click();
  expect((await download).suggestedFilename()).toBe(ar.account.backupCodes.fileName);
  await page.getByRole('checkbox', { name: ar.twoFactorSetup.confirmSaved }).click();
  await page.getByRole('button', { name: ar.twoFactorSetup.finish }).click();
  await expect(page.getByRole('navigation', { name: ar.nav.label })).toBeVisible();
});

// RTL screenshots in both themes: the design review evidence (ADR 0011).
for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('screenshots', async ({ page, admin }, testInfo) => {
      await page.goto('/login');
      await expect(page.locator('html')).toHaveClass(colorScheme === 'dark' ? /dark/ : /^$/);
      await screenshot(page, testInfo, `login-${colorScheme}`);

      await signInWithPassword(page);
      await expect(page.getByRole('heading', { name: ar.login.twoFactor.title })).toBeVisible();
      await screenshot(page, testInfo, `totp-${colorScheme}`);

      admin.signedIn = true;
      await page.goto('/');
      await expect(page.getByRole('navigation', { name: ar.nav.label })).toBeVisible();
      await screenshot(page, testInfo, `shell-${colorScheme}`);

      admin.user.twoFactorEnabled = false;
      await page.goto('/setup-two-factor');
      await page.getByLabel(ar.twoFactorSetup.password, { exact: true }).fill(PASSWORD);
      await page.getByRole('button', { name: ar.twoFactorSetup.start }).click();
      await expect(page.getByRole('img', { name: ar.twoFactorSetup.qrLabel })).toBeVisible();
      await screenshot(page, testInfo, `setup-two-factor-${colorScheme}`);
    });
  });
}

test('the theme switch is remembered over the system setting', async ({ page, admin }) => {
  admin.signedIn = true;
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await page.getByRole('button', { name: ar.theme.toDark }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
});
