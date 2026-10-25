import type { Page } from '@playwright/test';
import messages from '../src/features/passkeys/messages.ar.json' with { type: 'json' };
import ar from '../src/messages/ar.json' with { type: 'json' };
import { expect, type MockApi, screenshot, test } from './test';

/*
 * Customer passkeys (S22 PK2–PK4) against the mocked API, with Chrome's virtual authenticator:
 * the browser makes and uses a real credential, the mock answers the API's side. WebAuthn refuses
 * an IP address as the store's host, so these pages open on `localhost`.
 */

const ORIGIN = 'http://localhost:4001';
const EMAIL = 'sara@example.com';
const PASSWORD = 'a7Kq-blue-moon-river';
const b64url = (text: string) => Buffer.from(text).toString('base64url');

const PASSKEY = {
  id: '0199e000-0000-7000-8000-0000000000p1',
  name: 'Android · Chrome',
  createdAt: '2026-10-20T09:00:00.000Z',
  lastUsedAt: '2026-10-24T18:30:00.000Z',
  deviceType: 'multiDevice',
  backedUp: true,
};

const REGISTER_OPTIONS = {
  challenge: b64url('e2e-registration-challenge'),
  rp: { name: 'Vertex Digital', id: 'localhost' },
  user: { id: b64url('customer-sara'), name: EMAIL, displayName: 'سارة الأحمد' },
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  timeout: 60000,
  attestation: 'none',
  excludeCredentials: [],
  authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
};

const SIGN_IN_OPTIONS = {
  challenge: b64url('e2e-authentication-challenge'),
  rpId: 'localhost',
  timeout: 60000,
  userVerification: 'required',
};

function signedIn(api: MockApi): MockApi {
  return api
    .on('GET /api/auth/get-session', 200, {
      user: { name: 'سارة الأحمد', email: EMAIL },
      session: { token: 'this-device' },
    })
    .on('GET /api/auth/list-sessions', 200, []);
}

/** A platform authenticator that verifies the user and answers at once. */
async function virtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

const card = (page: Page) =>
  page.locator('[data-slot="card"]').filter({ hasText: messages.card.title });

test('adds a passkey with the password, renames and removes it, then signs in with it', async ({
  page,
  api,
}) => {
  await virtualAuthenticator(page);
  signedIn(api)
    .on('POST /api/account/passkeys/authorize', 204)
    .on('POST /api/auth/passkey/register-options', 200, REGISTER_OPTIONS)
    .on('POST /api/auth/passkey/register', 200, { id: PASSKEY.id, name: PASSKEY.name });
  await page.goto(`${ORIGIN}/account`);
  await expect(card(page).getByText(messages.card.empty)).toBeVisible();

  // A wrong password is said under its field.
  api.on('POST /api/account/passkeys/authorize', 400, { code: 'INVALID_PASSWORD' });
  await page.getByRole('button', { name: messages.card.add }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(ar.fields.currentPassword, { exact: true }).fill('wrong-password');
  await dialog.getByRole('button', { name: messages.authorize.submit }).click();
  await expect(dialog.getByText(ar.errors.INVALID_PASSWORD)).toBeVisible();

  api.on('POST /api/account/passkeys/authorize', 204);
  api.on('GET /api/account/passkeys', 200, [PASSKEY]);
  await dialog.getByLabel(ar.fields.currentPassword, { exact: true }).fill(PASSWORD);
  await dialog.getByRole('button', { name: messages.authorize.submit }).click();
  await expect(page.getByText(messages.card.added.replace('{name}', PASSKEY.name))).toBeVisible();
  expect(api.last('POST /api/account/passkeys/authorize')?.body).toEqual({ password: PASSWORD });
  const registered = api.last('POST /api/auth/passkey/register')?.body as {
    response: { id: string; type: string; response: { attestationObject: string } };
  };
  expect(registered.response.type).toBe('public-key');
  expect(registered.response.response.attestationObject).toBeTruthy();
  await expect(card(page).getByText(PASSKEY.name, { exact: true })).toBeVisible();
  await expect(card(page).getByText(messages.card.synced)).toBeVisible();

  api.on('PATCH /api/account/passkeys/0199e000-0000-7000-8000-0000000000p1', 200, {
    ...PASSKEY,
    name: 'هاتفي',
  });
  await page
    .getByRole('button', { name: messages.card.renameLabel.replace('{name}', PASSKEY.name) })
    .click();
  await page.getByRole('dialog').getByLabel(messages.rename.label).fill('  هاتفي ');
  await page.getByRole('dialog').getByRole('button', { name: messages.rename.submit }).click();
  await expect(card(page).getByText('هاتفي', { exact: true })).toBeVisible();
  expect(
    api.last('PATCH /api/account/passkeys/0199e000-0000-7000-8000-0000000000p1')?.body,
  ).toEqual({ name: 'هاتفي' });

  api.on('DELETE /api/account/passkeys/0199e000-0000-7000-8000-0000000000p1', 204);
  await page
    .getByRole('button', { name: messages.card.removeLabel.replace('{name}', 'هاتفي') })
    .click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: messages.remove.confirm })
    .click();
  await expect(card(page).getByText(messages.card.empty)).toBeVisible();

  // The credential stays in the virtual authenticator: sign out, then in with it.
  api
    .on('GET /api/auth/get-session', 200, null)
    .on('POST /api/auth/passkey/sign-in-options', 200, SIGN_IN_OPTIONS)
    .on('POST /api/auth/sign-in/passkey', 200, { status: true, user: { email: EMAIL } });
  await page.goto(`${ORIGIN}/sign-in?next=%2Forders`);
  signedIn(api);
  api.on('GET /api/orders', 200, { items: [], nextCursor: null });
  await page.getByRole('button', { name: messages.signIn.button }).click();
  await expect(page).toHaveURL(/\/orders$/);
  const assertion = api.last('POST /api/auth/sign-in/passkey')?.body as {
    response: { type: string; response: { signature: string } };
  };
  expect(assertion.response.type).toBe('public-key');
  expect(assertion.response.response.signature).toBeTruthy();
});

test('a refused passkey sign-in says so and keeps the password form', async ({ page, api }) => {
  await virtualAuthenticator(page);
  signedIn(api)
    .on('POST /api/account/passkeys/authorize', 204)
    .on('POST /api/auth/passkey/register-options', 200, REGISTER_OPTIONS)
    .on('POST /api/auth/passkey/register', 200, { id: PASSKEY.id, name: PASSKEY.name });
  await page.goto(`${ORIGIN}/account`);
  await page.getByRole('button', { name: messages.card.add }).click();
  await page
    .getByRole('dialog')
    .getByLabel(ar.fields.currentPassword, { exact: true })
    .fill(PASSWORD);
  await page.getByRole('dialog').getByRole('button', { name: messages.authorize.submit }).click();
  await expect(page.getByText(messages.card.added.replace('{name}', PASSKEY.name))).toBeVisible();

  api
    .on('GET /api/auth/get-session', 200, null)
    .on('POST /api/auth/passkey/sign-in-options', 200, SIGN_IN_OPTIONS)
    .on('POST /api/auth/sign-in/passkey', 401, { code: 'INVALID_EMAIL_OR_PASSWORD' });
  await page.goto(`${ORIGIN}/sign-in`);
  await page.getByRole('button', { name: messages.signIn.button }).click();
  // Pressing the button ends the email field's pending suggestions; Chrome sometimes answers the
  // button's ceremony as cancelled then. Either way the customer is told and the form stays.
  await expect(
    page.getByText(messages.signIn.failed).or(page.getByText(messages.signIn.cancelled)),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: ar.signIn.submit })).toBeEnabled();
});

test('the limit hides "أضف بصمة" and a lapsed grant asks the password again', async ({
  page,
  api,
}) => {
  await virtualAuthenticator(page);
  signedIn(api).on(
    'GET /api/account/passkeys',
    200,
    Array.from({ length: 10 }, (_, index) => ({ ...PASSKEY, id: `${PASSKEY.id}${index}` })),
  );
  await page.goto(`${ORIGIN}/account`);
  await expect(card(page).getByText(messages.card.limit.replace('{max}', '10'))).toBeVisible();
  await expect(page.getByRole('button', { name: messages.card.add })).toHaveCount(0);

  api
    .on('GET /api/account/passkeys', 200, [])
    .on('POST /api/account/passkeys/authorize', 204)
    .on('POST /api/auth/passkey/register-options', 403, { code: 'REAUTHENTICATION_REQUIRED' });
  await page.reload();
  await page.getByRole('button', { name: messages.card.add }).click();
  await page
    .getByRole('dialog')
    .getByLabel(ar.fields.currentPassword, { exact: true })
    .fill(PASSWORD);
  await page.getByRole('dialog').getByRole('button', { name: messages.authorize.submit }).click();
  // The options were refused: the password dialog opens again.
  await expect.poll(() => api.last('POST /api/auth/passkey/register-options')).toBeTruthy();
  await expect(page.getByRole('dialog').getByText(messages.authorize.title)).toBeVisible();
});

test('without WebAuthn the passkey buttons stay hidden (edge case 21)', async ({ page, api }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'PublicKeyCredential', { value: undefined });
  });
  signedIn(api);
  await page.goto('/account');
  await expect(card(page).getByText(messages.card.unsupported)).toBeVisible();
  await expect(page.getByRole('button', { name: messages.card.add })).toHaveCount(0);
  api.on('GET /api/auth/get-session', 200, null);
  await page.goto('/sign-in');
  await expect(page.getByRole('button', { name: ar.signIn.submit })).toBeVisible();
  await expect(page.getByRole('button', { name: messages.signIn.button })).toHaveCount(0);
});

// RTL screenshots of the passkey section and the sign-in button, dark and light.
for (const theme of ['dark', 'light'] as const) {
  test(`passkey screenshots, ${theme} theme`, async ({ page, api }, testInfo) => {
    if (theme === 'light') {
      await page.addInitScript(() => localStorage.setItem('vertex-theme', 'light'));
    }
    signedIn(api).on('GET /api/account/passkeys', 200, [
      PASSKEY,
      {
        ...PASSKEY,
        id: '0199e000-0000-7000-8000-0000000000p2',
        name: 'حاسوب العمل',
        lastUsedAt: null,
        deviceType: 'singleDevice',
        backedUp: false,
      },
    ]);
    await page.goto('/account');
    const section = card(page);
    await expect(section.getByText('حاسوب العمل')).toBeVisible();
    await section.scrollIntoViewIfNeeded();
    await screenshot(page, testInfo, `account-passkeys-${theme}`);

    await page.getByRole('button', { name: messages.card.add }).click();
    await expect(page.getByRole('dialog').getByText(messages.authorize.title)).toBeVisible();
    await screenshot(page, testInfo, `account-passkey-password-${theme}`);

    api.on('GET /api/auth/get-session', 200, null);
    await page.goto('/sign-in');
    await expect(page.getByRole('button', { name: messages.signIn.button })).toBeVisible();
    await screenshot(page, testInfo, `sign-in-passkey-${theme}`);
  });
}
