import type { Page } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import { ALL_ON, expect, type MockApi, screenshot, test } from './test';

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

/** The email code's first slot (F2-4): a code typed or pasted there fills all six. */
const codeField = (page: Page) =>
  page.getByRole('textbox', { name: ar.fields.code, exact: true }).filter({ visible: true });

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
    await codeField(page).fill('111111');
    await page.getByRole('button', { name: ar.verifyEmail.submit }).click();
    await expect(page.getByText(ar.errors.INVALID_OTP)).toBeVisible();

    api.on('POST /api/auth/email-otp/verify-email', 200, { status: true });
    signedIn(api);
    // The code pasted into the first slot with a space, as some mail apps copy it: every slot fills.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(() => navigator.clipboard.writeText('123 456'));
    await codeField(page).focus();
    await page.keyboard.press('ControlOrMeta+V');
    await page.getByRole('button', { name: ar.verifyEmail.submit }).click();
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('button', { name: ar.header.menu })).toBeVisible();
    // The password typed at sign-up goes with the code, without being asked again (F2-7).
    expect(api.last('POST /api/auth/email-otp/verify-email')?.body).toEqual({
      email: EMAIL,
      otp: CODE,
      password: PASSWORD,
    });
  });

  test('after a reload the code page asks for the password; another password sends to forgot password', async ({
    page,
    api,
  }) => {
    api.on('POST /api/auth/sign-up/email', 200, { status: 'code_sent' });
    await page.goto('/sign-up');
    await signUp(page);
    await expect(page).toHaveURL('/verify-email');
    await expect(field(page, ar.fields.password)).toHaveCount(0);
    // The password was held in the page's memory only: a reload forgets it.
    await page.reload();
    await expect(field(page, ar.fields.password)).toBeVisible();
    await codeField(page).pressSequentially(CODE);
    await page.getByRole('button', { name: ar.verifyEmail.submit }).click();
    await expect(page.getByText(ar.validation.passwordRequired)).toBeVisible();
    api.on('POST /api/auth/email-otp/verify-email', 400, { code: 'PASSWORD_MISMATCH' });
    await field(page, ar.fields.password).fill('another-passphrase');
    await page.getByRole('button', { name: ar.verifyEmail.submit }).click();
    await expect(page.getByText(ar.errors.PASSWORD_MISMATCH)).toBeVisible();
    expect(api.last('POST /api/auth/email-otp/verify-email')?.body).toEqual({
      email: EMAIL,
      otp: CODE,
      password: 'another-passphrase',
    });
    await page.getByRole('link', { name: ar.signIn.forgotPassword }).click();
    await expect(page).toHaveURL('/forgot-password');
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

  // Launch hardening (2026-10-14): a refused submit focuses the first refused field.
  test('a refused sign-up focuses the first refused field, with the alert by the button', async ({
    page,
    api,
  }) => {
    await page.goto('/sign-up');
    await field(page, ar.fields.name).fill(PROFILE.name);
    await field(page, ar.fields.email).fill('sara@');
    await page.getByRole('button', { name: ar.signUp.submit }).click();
    const email = field(page, ar.fields.email);
    await expect(email).toBeFocused();
    await expect(email).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByRole('alert').filter({ hasText: ar.forms.invalid })).toBeVisible();
    expect(api.last('POST /api/auth/sign-up/email')).toBeUndefined();

    // The focus moves on a press only: typing in another field keeps it there.
    const password = field(page, ar.fields.password);
    await password.click();
    await page.keyboard.type('x');
    await expect(password).toBeFocused();

    // Correcting a field takes its error away at once, before any new submit (F2-12).
    await expect(page.getByText(ar.validation.emailInvalid)).toBeVisible();
    await email.fill('sara@example.com');
    await expect(page.getByText(ar.validation.emailInvalid)).toHaveCount(0);
    await expect(email).toHaveAttribute('aria-invalid', 'false');
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
    // The sign-in's password goes with the code: not asked again.
    await expect(field(page, ar.fields.password)).toHaveCount(0);
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

test('forgot password: the code and a new password, then sign in and on to the page asked for', async ({
  page,
  api,
}) => {
  await page.clock.install();
  api.on('POST /api/auth/email-otp/request-password-reset', 200, { success: true });
  // Every failed check answers INVALID_OTP (rule C4, F2-18), shown under the code (A01-12).
  api.on('POST /api/auth/email-otp/reset-password', 400, { code: 'INVALID_OTP' });
  await page.goto('/sign-in?next=%2Faccount');
  // Where the customer was heading stays through the reset (A01-19), once the page has read it.
  const forgot = page.getByRole('link', { name: ar.signIn.forgotPassword });
  await expect(forgot).toHaveAttribute('href', '/forgot-password?next=%2Faccount');
  await forgot.click();
  await expect(page).toHaveURL('/forgot-password?next=%2Faccount');
  await expect(page.getByRole('heading', { name: ar.forgotPassword.title })).toBeVisible();
  await field(page, ar.fields.email).fill(EMAIL);
  await page.getByRole('button', { name: ar.forgotPassword.send }).click();
  await expect(page.getByText(EMAIL)).toBeVisible();
  expect(
    api.last('POST /api/auth/email-otp/request-password-reset')?.headers['x-altcha'],
  ).toBeTruthy();

  // A new code after a minute, with a new challenge (A01-10).
  const waiting = page.getByRole('button', {
    name: ar.verifyEmail.resendIn.replace('{seconds}', '60'),
  });
  await expect(waiting).toBeDisabled();
  await page.clock.runFor(61_000);
  const before = api.requests.length;
  await page.getByRole('button', { name: ar.verifyEmail.resend }).click();
  await expect(page.getByText(ar.verifyEmail.resent)).toBeVisible();
  const resent = api.requests
    .slice(before)
    .filter((request) => request.key === 'POST /api/auth/email-otp/request-password-reset');
  expect(resent).toHaveLength(1);
  expect(resent[0]?.body).toEqual({ email: EMAIL });
  expect(resent[0]?.headers['x-altcha']).toBeTruthy();

  await codeField(page).fill(CODE);
  await field(page, ar.fields.newPassword).fill(PASSWORD);
  await page.getByRole('button', { name: ar.forgotPassword.submit }).click();
  await expect(page.getByText(ar.errors.INVALID_OTP)).toBeVisible();

  // A merchant's hint from before the reset goes with the session (A01-13).
  await page.evaluate(() => {
    localStorage.setItem('vd-signed-in', '1');
    localStorage.setItem('vd-private-prices', '1');
  });
  api.on('POST /api/auth/email-otp/reset-password', 200, { success: true });
  await page.getByRole('button', { name: ar.forgotPassword.submit }).click();
  await expect(page).toHaveURL('/sign-in?notice=password-reset&next=%2Faccount');
  await expect(page.getByText(ar.signIn.passwordReset)).toBeVisible();
  expect(
    await page.evaluate(() => [
      localStorage.getItem('vd-signed-in'),
      localStorage.getItem('vd-private-prices'),
    ]),
  ).toEqual([null, null]);
  expect(api.last('POST /api/auth/email-otp/reset-password')?.body).toEqual({
    email: EMAIL,
    otp: CODE,
    password: PASSWORD,
  });
});

test('the entry pages send a signed-in customer on, never to a second sign-in (A01-13)', async ({
  page,
  api,
}) => {
  signedIn(api);
  await page.goto('/sign-in?next=%2Faccount');
  await expect(page).toHaveURL('/account');
  await expect(page.getByText(ar.account.sessions.thisDevice)).toBeVisible();
  for (const path of ['/sign-up', '/forgot-password', '/verify-email']) {
    await page.goto(path);
    await expect(page).toHaveURL('/');
  }
  expect(api.last('POST /api/auth/sign-in/email')).toBeUndefined();
});

test('the code page without a waiting address links back to sign-in', async ({ page }) => {
  await page.goto('/verify-email');
  await expect(page.getByText(ar.verifyEmail.missingTitle)).toBeVisible();
  await expect(page.getByRole('main').getByRole('link', { name: ar.signIn.title })).toHaveAttribute(
    'href',
    '/sign-in',
  );
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
    // S10 rule CT1: a cart on the device goes with the sign-out.
    await page.addInitScript(() => {
      if (sessionStorage.getItem('vd:e2e-seeded')) return;
      sessionStorage.setItem('vd:e2e-seeded', '1');
      localStorage.setItem('vd-cart', JSON.stringify({ v: 1, lines: [{ id: 'l1' }] }));
    });
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
    expect(await page.evaluate(() => localStorage.getItem('vd-cart'))).toBeNull();
  });

  test('signing this device out from the list forgets what the header sign-out forgets (A01-6)', async ({
    page,
    api,
  }) => {
    signedIn(api);
    api.on('POST /api/auth/revoke-session', 200, { success: true });
    await page.addInitScript(() => {
      if (sessionStorage.getItem('vd:e2e-seeded')) return;
      sessionStorage.setItem('vd:e2e-seeded', '1');
      localStorage.setItem('vd-cart', JSON.stringify({ v: 1, lines: [{ id: 'l1' }] }));
      localStorage.setItem('vd-private-prices', '1');
    });
    await page.goto('/account');
    await expect(page.getByText(ar.account.sessions.thisDevice)).toBeVisible();
    const thisDevice = ar.account.sessions.device
      .replace('{browser}', 'Chrome')
      .replace('{system}', 'Android');
    api.on('GET /api/auth/get-session', 200, null);
    await page
      .getByRole('button', {
        name: ar.account.sessions.signOutLabel.replace('{device}', thisDevice),
      })
      .click();
    await expect(page).toHaveURL('/sign-in');
    expect(api.last('POST /api/auth/revoke-session')?.body).toEqual({ token: 'this-device' });
    expect(
      await page.evaluate(() => [
        localStorage.getItem('vd-cart'),
        localStorage.getItem('vd-private-prices'),
      ]),
    ).toEqual([null, null]);
  });

  test('refuses a new password equal to the email, before sending and from the server (A01-8)', async ({
    page,
    api,
  }) => {
    signedIn(api);
    await page.goto('/account');
    await field(page, ar.fields.currentPassword).fill(PASSWORD);
    await field(page, ar.fields.newPassword).fill(EMAIL.toUpperCase());
    await page.getByRole('button', { name: ar.account.password.submit }).click();
    await expect(page.getByText(ar.validation.passwordEqualsEmail)).toBeVisible();
    await expect(field(page, ar.fields.newPassword)).toBeFocused();
    expect(api.last('POST /api/auth/change-password')).toBeUndefined();

    // The email changed in another tab: the server's refusal lands on the same field.
    api.on('POST /api/auth/change-password', 400, {
      code: 'VALIDATION_FAILED',
      details: [{ path: ['newPassword'], message: 'PASSWORD_EQUALS_EMAIL' }],
    });
    await field(page, ar.fields.newPassword).fill('sara.new@example.com');
    await page.getByRole('button', { name: ar.account.password.submit }).click();
    await expect(page.getByText(ar.validation.passwordEqualsEmail)).toBeVisible();
    await expect(field(page, ar.fields.newPassword)).toBeFocused();
  });

  test('a failed read of the account, or of its email choices, offers a retry (A01-9, A01-12)', async ({
    page,
    api,
  }) => {
    signedIn(api);
    api.on('GET /api/account', 500, { code: 'INTERNAL_ERROR' });
    await page.goto('/account');
    await expect(page.getByText(ar.account.loadFailed)).toBeVisible();
    signedIn(api);
    api.on('GET /api/account/notification-preferences', 500, { code: 'INTERNAL_ERROR' });
    await page.getByRole('button', { name: ar.account.retry }).click();
    await expect(page.getByText(ar.account.sessions.thisDevice)).toBeVisible();
    await expect(page.getByText(ar.account.notifications.loadFailed)).toBeVisible();
    api.on('GET /api/account/notification-preferences', 200, { email: ALL_ON, push: ALL_ON });
    // The account loaded: the only retry left is the email choices' own.
    await page.getByRole('button', { name: ar.account.retry }).click();
    const credited = page.getByRole('switch', {
      name: ar.account.notifications.emailLabel.replace(
        '{event}',
        ar.account.notifications.events.deposit_credited,
      ),
    });
    await expect(credited).toBeChecked();

    // A01-11: the switch answers a tap up to 10 px above it, a 44 px target.
    api.on('PUT /api/account/notification-preferences', 500, { code: 'INTERNAL_ERROR' });
    const box = await credited.boundingBox();
    if (!box) throw new Error('No switch box');
    expect(box.height).toBeLessThan(44);
    await page.mouse.click(box.x + box.width / 2, box.y - 8);
    await expect
      .poll(() => api.last('PUT /api/account/notification-preferences')?.body)
      .toEqual({
        event: 'deposit_credited',
        email: false,
      });
  });

  test('the email change: signed out goes to sign-in first, then each refusal where it belongs (A01-7, A01-12)', async ({
    page,
    api,
  }) => {
    api.on('GET /api/account', 401, { code: 'UNAUTHORIZED' });
    await page.goto('/account/email');
    await expect(page).toHaveURL('/sign-in?next=%2Faccount%2Femail');
    expect(api.last('POST /api/auth/email-otp/request-email-change')).toBeUndefined();

    signedIn(api);
    api.on('POST /api/auth/email-otp/request-email-change', 400, { code: 'INVALID_PASSWORD' });
    await page.goto('/account/email');
    await field(page, ar.fields.newEmail).fill('sara.new@example.com');
    await field(page, ar.fields.currentPassword).fill('wrong-password');
    await page.getByRole('button', { name: ar.changeEmail.send }).click();
    await expect(page.getByText(ar.errors.INVALID_PASSWORD)).toBeVisible();
    await expect(field(page, ar.fields.currentPassword)).toBeFocused();

    api.on('POST /api/auth/email-otp/request-email-change', 200, { success: true });
    api.on('POST /api/auth/email-otp/change-email', 400, { code: 'INVALID_OTP' });
    await field(page, ar.fields.currentPassword).fill(PASSWORD);
    await page.getByRole('button', { name: ar.changeEmail.send }).click();
    await codeField(page).fill(CODE);
    await page.getByRole('button', { name: ar.changeEmail.submit }).click();
    await expect(page.getByText(ar.errors.INVALID_OTP)).toBeVisible();

    // Edge case 8: the address was taken meanwhile.
    api.on('POST /api/auth/email-otp/change-email', 409, { code: 'EMAIL_TAKEN' });
    await page.getByRole('button', { name: ar.changeEmail.submit }).click();
    await expect(page.getByText(ar.errors.EMAIL_TAKEN)).toBeVisible();
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

    await codeField(page).fill(CODE);
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

  test('a failed sign-out stays on the page and says so, with a retry (2026-10-15 audit)', async ({
    page,
    api,
  }) => {
    signedIn(api);
    api.on('POST /api/auth/sign-out', 500, { code: 'INTERNAL_ERROR' });
    await page.goto('/account');
    await page.getByRole('button', { name: ar.header.menu }).click();
    await page.getByRole('menuitem', { name: ar.header.signOut }).click();
    await expect(page.getByText(ar.header.signOutFailed)).toBeVisible();
    await expect(page).toHaveURL('/account');
    // The retry works once the server answers.
    api.on('POST /api/auth/sign-out', 200, { success: true });
    api.on('GET /api/auth/get-session', 200, null);
    await page.getByRole('button', { name: ar.header.signOutRetry }).click();
    await expect(page).toHaveURL('/');
    await expect(page.getByRole('link', { name: ar.header.signIn })).toBeVisible();
  });
});

test('the way to the cart is kept from sign-in to sign-up and to the code page (2026-10-15 audit)', async ({
  page,
  api,
}) => {
  api.on('POST /api/auth/sign-up/email', 200, { status: 'code_sent' });
  await page.goto('/sign-in?next=%2Fcart');
  await page.getByRole('link', { name: ar.signIn.signUpLink }).click();
  await expect(page).toHaveURL('/sign-up?next=%2Fcart');
  await expect(page.getByRole('link', { name: ar.signUp.signInLink })).toHaveAttribute(
    'href',
    '/sign-in?next=%2Fcart',
  );
  await signUp(page);
  await expect(page).toHaveURL('/verify-email');
  await expect(page.getByRole('link', { name: ar.verifyEmail.changeEmail })).toHaveAttribute(
    'href',
    '/sign-up?next=%2Fcart',
  );
});

test('a malformed destination signs in all the same and goes home (2026-10-15 audit)', async ({
  page,
  api,
}) => {
  api.on('POST /api/auth/sign-in/email', 200, { redirect: false });
  await page.goto('/sign-in?next=%2F%2F%5B');
  await field(page, ar.fields.email).fill(EMAIL);
  await field(page, ar.fields.password).fill(PASSWORD);
  signedIn(api);
  await page.getByRole('button', { name: ar.signIn.submit }).click();
  await expect(page).toHaveURL('/');
});

// RTL screenshots of a refused sign-up (launch hardening, 2026-10-14), dark and light.
for (const theme of ['dark', 'light'] as const) {
  test(`refused sign-up screenshot, ${theme} theme`, async ({ page, api: _api }, testInfo) => {
    if (theme === 'light') {
      await page.addInitScript(() => localStorage.setItem('vertex-theme', 'light'));
    }
    await page.goto('/sign-up');
    await page.getByRole('button', { name: ar.signUp.submit }).click();
    await expect(field(page, ar.fields.name)).toBeFocused();
    await expect(page.getByRole('alert').filter({ hasText: ar.forms.invalid })).toBeVisible();
    await screenshot(page, testInfo, `sign-up-refused-${theme}`);
  });
}

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
    await expect(codeField(page)).toBeVisible();
    await screenshot(page, testInfo, `verify-email-${theme}`);

    await page.goto('/forgot-password');
    await field(page, ar.fields.email).fill(EMAIL);
    await page.getByRole('button', { name: ar.forgotPassword.send }).click();
    await expect(codeField(page)).toBeVisible();
    await screenshot(page, testInfo, `forgot-password-${theme}`);

    signedIn(api);
    await page.goto('/account');
    await expect(page.getByText(ar.account.sessions.thisDevice)).toBeVisible();
    // The email choices of S05 (rule NT8) under the devices.
    await expect(
      page.getByRole('switch', { name: ar.account.notifications.events.deposit_credited }),
    ).toBeChecked();
    await screenshot(page, testInfo, `account-${theme}`);

    await page.goto('/account/email');
    await expect(field(page, ar.fields.newEmail)).toBeVisible();
    await screenshot(page, testInfo, `account-email-${theme}`);
  });
}
