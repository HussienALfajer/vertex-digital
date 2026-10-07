import type { Page } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import { expect, type MockApi, screenshot, test } from './test';

/*
 * Customer accounts (S01): sign-up, the email code, sign-in, recovery and the account page,
 * against the mocked API. Codes and passwords here are test values only.
 */

const EMAIL = 'sara@example.com';
const PASSWORD = 'a7Kq-blue-moon-river';
const CODE = '123456';

const PROFILE = {
  id: '0199a000-0000-7000-8000-000000000010',
  name: 'سارة الأحمد',
  email: EMAIL,
  phone: '+963944123456',
  createdAt: '2026-10-01T09:00:00.000Z',
};

const SESSIONS = [
  {
    id: 's-1',
    token: 'this-device',
    createdAt: '2026-10-07T08:00:00.000Z',
    updatedAt: '2026-10-08T08:00:00.000Z',
    ipAddress: '5.0.0.1',
    userAgent:
      'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
  },
  {
    id: 's-2',
    token: 'other-device',
    createdAt: '2026-10-02T08:00:00.000Z',
    updatedAt: '2026-10-05T08:00:00.000Z',
    ipAddress: '5.0.0.2',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  },
];

/** A signed-in customer with two devices. */
function signedIn(api: MockApi): MockApi {
  return api
    .on('GET /api/auth/get-session', 200, {
      user: { name: PROFILE.name, email: EMAIL },
      session: { token: 'this-device' },
    })
    .on('GET /api/account', 200, PROFILE)
    .on('GET /api/auth/list-sessions', 200, SESSIONS);
}

/**
 * A form field by its label. Next.js keeps the previous page mounted but hidden after a client
 * navigation, so only the visible one counts.
 */
const field = (page: Page, label: string) =>
  page.getByLabel(label, { exact: true }).filter({ visible: true });

async function signUp(page: Page, phone = '0944123456', password = PASSWORD) {
  await field(page, ar.fields.name).fill(PROFILE.name);
  await field(page, ar.fields.email).fill(EMAIL);
  await field(page, ar.fields.password).fill(password);
  await field(page, ar.fields.phone).fill(phone);
  await page.getByRole('button', { name: ar.signUp.submit }).click();
}

test.describe('sign-up and the email code', () => {
  test('signs up with a Syrian number written as 09…, then the code signs in', async ({
    page,
    api,
  }) => {
    api.on('POST /api/auth/sign-up/email', 200, { status: 'code_sent' });
    await page.goto('/sign-up');
    await signUp(page);
    await expect(page).toHaveURL('/verify-email');
    await expect(page.getByText(EMAIL)).toBeVisible();

    const sent = api.last('POST /api/auth/sign-up/email');
    expect(sent?.body).toEqual({
      name: PROFILE.name,
      email: EMAIL,
      password: PASSWORD,
      phone: '+963944123456',
    });
    expect(sent?.headers['x-altcha']).toBeTruthy();

    api.on('POST /api/auth/email-otp/verify-email', 400, { code: 'INVALID_OTP' });
    await field(page, ar.fields.code).fill('111111');
    await page.getByRole('button', { name: ar.verifyEmail.submit }).click();
    await expect(page.getByText(ar.errors.INVALID_OTP)).toBeVisible();

    api.on('POST /api/auth/email-otp/verify-email', 200, { status: true });
    signedIn(api);
    // The code pasted with a space, as some mail apps copy it.
    await field(page, ar.fields.code).fill('123 456');
    await page.getByRole('button', { name: ar.verifyEmail.submit }).click();
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('button', { name: ar.header.menu })).toBeVisible();
    expect(api.last('POST /api/auth/email-otp/verify-email')?.body).toEqual({
      email: EMAIL,
      otp: CODE,
    });
  });

  test('the phone shows as an international number and a bad one is refused', async ({
    page,
    api,
  }) => {
    await page.goto('/sign-up');
    const phone = field(page, ar.fields.phone);
    await phone.fill('0944 123 456');
    await phone.blur();
    await expect(phone).toHaveValue('+963 944 123 456');
    await signUp(page, '0944');
    await expect(page.getByText(ar.validation.phoneInvalid)).toBeVisible();
    expect(api.last('POST /api/auth/sign-up/email')).toBeUndefined();
  });

  test('a common password is refused before any request', async ({ page, api }) => {
    await page.goto('/sign-up');
    await signUp(page, '0944123456', 'PassWord1');
    await expect(page.getByText(ar.validation.passwordCommon)).toBeVisible();
    expect(api.last('POST /api/auth/sign-up/email')).toBeUndefined();
  });

  test('the resend button waits 60 seconds, and a new code needs a challenge', async ({
    page,
    api,
  }) => {
    await page.clock.install();
    api.on('POST /api/auth/sign-up/email', 200, { status: 'code_sent' });
    api.on('POST /api/auth/email-otp/send-verification-otp', 200, { success: true });
    await page.goto('/sign-up');
    await signUp(page);
    await expect(page).toHaveURL('/verify-email');
    const waiting = page.getByRole('button', {
      name: ar.verifyEmail.resendIn.replace('{seconds}', '60'),
    });
    await expect(waiting).toBeDisabled();
    await page.clock.runFor(61_000);
    await page.getByRole('button', { name: ar.verifyEmail.resend }).click();
    await expect(page.getByText(ar.verifyEmail.resent)).toBeVisible();
    const resend = api.last('POST /api/auth/email-otp/send-verification-otp');
    expect(resend?.body).toEqual({ email: EMAIL });
    expect(resend?.headers['x-altcha']).toBeTruthy();
  });

  test('closed registration hides the link and shows a calm message', async ({ page, api }) => {
    api.on('GET /api/auth/registration', 200, { open: false });
    await page.goto('/sign-in');
    await expect(page.getByRole('heading', { level: 1, name: ar.signIn.title })).toBeVisible();
    await expect(page.getByRole('link', { name: ar.header.signUp })).toHaveCount(0);
    await expect(page.getByRole('link', { name: ar.signIn.signUpLink })).toHaveCount(0);
    await page.goto('/sign-up');
    await expect(page.getByText(ar.signUp.closedTitle)).toBeVisible();
    await expect(field(page, ar.fields.name)).toHaveCount(0);
  });
});

test('a failed read of the registration state offers a retry, not "closed"', async ({
  page,
  api,
}) => {
  api.on('GET /api/auth/registration', 429, { code: 'RATE_LIMITED' });
  await page.goto('/sign-up');
  await expect(page.getByText(ar.errors.NETWORK)).toBeVisible();
  await expect(page.getByText(ar.signUp.closedTitle)).toHaveCount(0);
  api.on('GET /api/auth/registration', 200, { open: true });
  await page.getByRole('button', { name: ar.signUp.retry }).click();
  await expect(field(page, ar.fields.name)).toBeVisible();
});

test.describe('sign-in', () => {
  test('an unverified account goes to the code screen', async ({ page, api }) => {
    api.on('POST /api/auth/sign-in/email', 403, { code: 'EMAIL_NOT_VERIFIED' });
    await page.goto('/sign-in');
    await field(page, ar.fields.email).fill(EMAIL);
    await field(page, ar.fields.password).fill(PASSWORD);
    await page.getByRole('button', { name: ar.signIn.submit }).click();
    await expect(page).toHaveURL('/verify-email');
    await expect(page.getByText(EMAIL)).toBeVisible();
  });

  test('solves the challenge after repeated failures, then returns to the page asked for', async ({
    page,
    api,
  }) => {
    api.on('POST /api/auth/sign-in/email', 400, { code: 'ALTCHA_REQUIRED' });
    await page.goto('/sign-in?next=%2Faccount');
    await field(page, ar.fields.email).fill(EMAIL);
    await field(page, ar.fields.password).fill(PASSWORD);
    // The second sign-in (with the solved challenge) succeeds.
    await page.route('**/api/altcha/challenge', async (route) => {
      api.on('POST /api/auth/sign-in/email', 200, { token: 'x' });
      signedIn(api);
      await route.fallback();
    });
    await page.getByRole('button', { name: ar.signIn.submit }).click();
    await expect(page).toHaveURL('/account');
    expect(api.last('POST /api/auth/sign-in/email')?.headers['x-altcha']).toBeTruthy();
  });
});

test('forgot password: the code and a new password, then sign in', async ({ page, api }) => {
  api.on('POST /api/auth/email-otp/request-password-reset', 200, { success: true });
  api.on('POST /api/auth/email-otp/reset-password', 400, { code: 'OTP_EXPIRED' });
  await page.goto('/sign-in');
  await page.getByRole('link', { name: ar.signIn.forgotPassword }).click();
  await expect(page.getByRole('heading', { name: ar.forgotPassword.title })).toBeVisible();
  await field(page, ar.fields.email).fill(EMAIL);
  await page.getByRole('button', { name: ar.forgotPassword.send }).click();
  await expect(page.getByText(EMAIL)).toBeVisible();
  expect(
    api.last('POST /api/auth/email-otp/request-password-reset')?.headers['x-altcha'],
  ).toBeTruthy();

  await field(page, ar.fields.code).fill(CODE);
  await field(page, ar.fields.newPassword).fill(PASSWORD);
  await page.getByRole('button', { name: ar.forgotPassword.submit }).click();
  await expect(page.getByText(ar.errors.OTP_EXPIRED)).toBeVisible();

  api.on('POST /api/auth/email-otp/reset-password', 200, { success: true });
  await page.getByRole('button', { name: ar.forgotPassword.submit }).click();
  await expect(page).toHaveURL('/sign-in?notice=password-reset');
  await expect(page.getByText(ar.signIn.passwordReset)).toBeVisible();
  expect(api.last('POST /api/auth/email-otp/reset-password')?.body).toEqual({
    email: EMAIL,
    otp: CODE,
    password: PASSWORD,
  });
});

test.describe('account', () => {
  test('without a session, the account page sends to sign-in and back', async ({ page, api }) => {
    api.on('GET /api/account', 401, { code: 'UNAUTHORIZED' });
    api.on('GET /api/auth/list-sessions', 401, { code: 'UNAUTHORIZED' });
    await page.goto('/account');
    await expect(page).toHaveURL('/sign-in?next=%2Faccount');
  });

  test('edits the name and the phone', async ({ page, api }) => {
    signedIn(api);
    await page.goto('/account');
    await expect(page.getByText('+963 944 123 456')).toBeVisible();
    await page.getByRole('button', { name: ar.account.profile.edit }).click();
    await field(page, ar.fields.name).fill('سارة الحسن');
    await field(page, ar.fields.phone).fill('0933 000 111');
    api.on('PATCH /api/account', 200, {
      ...PROFILE,
      name: 'سارة الحسن',
      phone: '+963933000111',
    });
    await page.getByRole('button', { name: ar.account.profile.save }).click();
    await expect(page.getByText(ar.account.profile.saved)).toBeVisible();
    await expect(page.getByText('+963 933 000 111')).toBeVisible();
    expect(api.last('PATCH /api/account')?.body).toEqual({
      name: 'سارة الحسن',
      phone: '+963933000111',
    });
  });

  test('changes the password; a wrong current password is shown under its field', async ({
    page,
    api,
  }) => {
    signedIn(api);
    api.on('POST /api/auth/change-password', 400, { code: 'INVALID_PASSWORD' });
    await page.goto('/account');
    await field(page, ar.fields.currentPassword).fill('wrong-password');
    await field(page, ar.fields.newPassword).fill(PASSWORD);
    await page.getByRole('button', { name: ar.account.password.submit }).click();
    await expect(page.getByText(ar.errors.INVALID_PASSWORD)).toBeVisible();

    api.on('POST /api/auth/change-password', 200, { success: true });
    await field(page, ar.fields.currentPassword).fill('a-current-password');
    await page.getByRole('button', { name: ar.account.password.submit }).click();
    await expect(page.getByText(ar.account.password.changed)).toBeVisible();
    expect(api.last('POST /api/auth/change-password')?.body).toEqual({
      currentPassword: 'a-current-password',
      newPassword: PASSWORD,
    });
  });

  test('lists devices, signs another one out, then signs out everywhere', async ({ page, api }) => {
    signedIn(api);
    api.on('POST /api/auth/revoke-session', 200, { success: true });
    api.on('POST /api/auth/revoke-sessions', 200, { success: true });
    await page.goto('/account');
    await expect(page.getByText(ar.account.sessions.thisDevice)).toBeVisible();
    const other = ar.account.sessions.device
      .replace('{browser}', 'Chrome')
      .replace('{system}', 'Windows');
    await page
      .getByRole('button', { name: ar.account.sessions.signOutLabel.replace('{device}', other) })
      .click();
    await expect(page.getByText(other)).toHaveCount(0);
    expect(api.last('POST /api/auth/revoke-session')?.body).toEqual({ token: 'other-device' });

    await page.getByRole('button', { name: ar.account.sessions.signOutEverywhere }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    api.on('GET /api/auth/get-session', 200, null);
    await page.getByRole('button', { name: ar.account.sessions.confirm }).click();
    await expect(page).toHaveURL('/sign-in?notice=signed-out');
    await expect(page.getByText(ar.signIn.signedOut)).toBeVisible();
  });

  test('changes the email with a code sent to the new address', async ({ page, api }) => {
    signedIn(api);
    api.on('POST /api/auth/email-otp/request-email-change', 200, { success: true });
    api.on('POST /api/auth/email-otp/change-email', 200, { success: true });
    await page.goto('/account');
    await page.getByRole('link', { name: ar.account.profile.changeEmail }).click();
    await expect(page).toHaveURL('/account/email');
    await field(page, ar.fields.newEmail).fill('sara.new@example.com');
    await field(page, ar.fields.currentPassword).fill(PASSWORD);
    await page.getByRole('button', { name: ar.changeEmail.send }).click();
    await expect(page.getByText('sara.new@example.com')).toBeVisible();
    const request = api.last('POST /api/auth/email-otp/request-email-change');
    expect(request?.body).toEqual({ newEmail: 'sara.new@example.com', password: PASSWORD });
    expect(request?.headers['x-altcha']).toBeTruthy();

    await field(page, ar.fields.code).fill(CODE);
    await page.getByRole('button', { name: ar.changeEmail.submit }).click();
    await expect(page.getByText(ar.changeEmail.done)).toBeVisible();
    expect(api.last('POST /api/auth/email-otp/change-email')?.body).toEqual({
      newEmail: 'sara.new@example.com',
      otp: CODE,
    });
  });

  test('the header menu opens the account page and signs out', async ({ page, api }) => {
    signedIn(api);
    api.on('POST /api/auth/sign-out', 200, { success: true });
    await page.goto('/');
    await page.getByRole('button', { name: ar.header.menu }).click();
    await page.getByRole('menuitem', { name: ar.header.account }).click();
    await expect(page).toHaveURL('/account');
    await page.getByRole('button', { name: ar.header.menu }).click();
    api.on('GET /api/auth/get-session', 200, null);
    await page.getByRole('menuitem', { name: ar.header.signOut }).click();
    await expect(page.getByRole('link', { name: ar.header.signIn })).toBeVisible();
  });
});

// RTL screenshots of every account screen, dark and light, at phone width and desktop.
for (const theme of ['dark', 'light'] as const) {
  test(`account screenshots, ${theme} theme`, async ({ page, api }, testInfo) => {
    if (theme === 'light') {
      await page.addInitScript(() => localStorage.setItem('vertex-theme', 'light'));
    }
    api.on('POST /api/auth/sign-up/email', 200, { status: 'code_sent' });
    api.on('POST /api/auth/email-otp/request-password-reset', 200, { success: true });

    await page.goto('/sign-up');
    await expect(field(page, ar.fields.name)).toBeVisible();
    await screenshot(page, testInfo, `sign-up-${theme}`);

    await signUp(page);
    await expect(field(page, ar.fields.code)).toBeVisible();
    await screenshot(page, testInfo, `verify-email-${theme}`);

    await page.goto('/forgot-password');
    await field(page, ar.fields.email).fill(EMAIL);
    await page.getByRole('button', { name: ar.forgotPassword.send }).click();
    await expect(field(page, ar.fields.code)).toBeVisible();
    await screenshot(page, testInfo, `forgot-password-${theme}`);

    signedIn(api);
    await page.goto('/account');
    await expect(page.getByText(ar.account.sessions.thisDevice)).toBeVisible();
    await screenshot(page, testInfo, `account-${theme}`);

    await page.goto('/account/email');
    await expect(field(page, ar.fields.newEmail)).toBeVisible();
    await screenshot(page, testInfo, `account-email-${theme}`);
  });
}
