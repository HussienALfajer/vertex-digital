import { PASSKEYS_MAX, passkeyGrantIdentifier } from '@vertex-digital/contracts';
import {
  auditEntries,
  customerPasskeys,
  customerSessions,
  customerSignIns,
  customers,
  customerVerifications,
} from '@vertex-digital/db';
import { and, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthPasskeysService } from '../src/modules/auth/auth-passkeys.service.js';
import {
  api,
  auditOf,
  body,
  clientIp,
  cookieHeader,
  emailsTo,
  lastCode,
  PASSWORD,
  removeAccounts,
  STORE_ORIGIN,
  seedCustomer,
} from './helpers.js';
import { strangerKey, TestAuthenticator } from './passkey-authenticator.js';
import { startApp, type TestApp } from './start-app.js';

/*
 * Customer passkeys (S22 PK1–PK6, ADR 0037) over HTTP against the test database, with a software
 * authenticator: the password grant, the registration with its audit entry and email, the limit,
 * sign-in through the session hooks, the counter rule, management, the reset rule and the
 * admin's read.
 */

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const RP_ID = new URL(STORE_ORIGIN).hostname;
const NEW_PASSWORD = 'another-horse-battery-staple';

let test: TestApp;
let client: ReturnType<typeof api>;
const seeded: string[] = [];

beforeAll(async () => {
  test = await startApp();
  client = api(test.url);
});

afterAll(async () => {
  await removeAccounts(test.db, seeded);
  await test.app.close();
});

async function signedIn() {
  const customer = await seedCustomer(test.db);
  seeded.push(customer.id);
  return { ...customer, cookie: await client.signInCustomer(customer.email) };
}

const authenticator = () => new TestAuthenticator(RP_ID, STORE_ORIGIN);

const authorize = (cookie: string, password = PASSWORD) =>
  client.post('/api/account/passkeys/authorize', { cookie, body: { password } });

/** The registration options and the challenge cookie they set. */
async function registerOptions(cookie: string) {
  const response = await client.post('/api/auth/passkey/register-options', { cookie, body: {} });
  return { response, challenge: cookieHeader(response) };
}

async function addPasskey(
  cookie: string,
  device: TestAuthenticator,
  options: { origin?: string } = {},
) {
  expect((await authorize(cookie)).status).toBe(204);
  const { response, challenge } = await registerOptions(cookie);
  expect(response.status).toBe(200);
  const json = (await response.json()) as { challenge: string };
  return client.post('/api/auth/passkey/register', {
    cookie: `${cookie}; ${challenge}`,
    body: { response: device.register(json, options.origin) },
    headers: { 'user-agent': IPHONE },
  });
}

async function signInWith(device: TestAuthenticator, ip = clientIp()) {
  const options = await client.post('/api/auth/passkey/sign-in-options', { body: {}, ip });
  expect(options.status).toBe(200);
  const json = (await options.json()) as { challenge: string };
  return client.post('/api/auth/sign-in/passkey', {
    cookie: cookieHeader(options),
    body: { response: device.assert(json) },
    ip,
  });
}

const listOf = async (cookie: string) =>
  (await (await client.get('/api/account/passkeys', { cookie })).json()) as {
    id: string;
    name: string;
    lastUsedAt: string | null;
  }[];

const sessionsOf = async (customerId: string) =>
  (
    await test.db
      .select({ id: customerSessions.id })
      .from(customerSessions)
      .where(eq(customerSessions.userId, customerId))
  )
    .map((row) => row.id)
    .sort();

const passkeyRows = (customerId: string) =>
  test.db.select().from(customerPasskeys).where(eq(customerPasskeys.customerId, customerId));

describe('access', () => {
  it('needs a customer session', async () => {
    expect((await client.get('/api/account/passkeys')).status).toBe(401);
    expect(
      (await client.post('/api/account/passkeys/authorize', { body: { password: 'x' } })).status,
    ).toBe(401);
    expect((await registerOptions('')).response.status).toBe(401);
  });

  it('gives the admin instance no passkey route (PK1)', async () => {
    const response = await client.post('/api/admin/auth/passkey/sign-in-options', { body: {} });
    expect(response.status).toBe(404);
  });
});

describe('adding a passkey (PK2)', () => {
  it('needs the password, then writes the row, the audit entry and the email', async () => {
    const customer = await signedIn();
    expect(await body(await authorize(customer.cookie, 'wrong-password'))).toMatchObject({
      status: 400,
      code: 'INVALID_PASSWORD',
    });
    expect(await body((await registerOptions(customer.cookie)).response)).toMatchObject({
      status: 403,
      code: 'REAUTHENTICATION_REQUIRED',
    });

    const device = authenticator();
    expect((await addPasskey(customer.cookie, device)).status).toBe(200);
    const [row] = await passkeyRows(customer.id);
    expect(row).toMatchObject({
      name: 'iOS · Safari',
      credentialId: device.credentialId,
      counter: 0,
      deviceType: 'singleDevice',
      backedUp: false,
      transports: 'internal',
    });
    expect(await listOf(customer.cookie)).toEqual([
      expect.objectContaining({ id: row?.id, name: 'iOS · Safari', lastUsedAt: null }),
    ]);
    const audit = await auditOf(test.db, customer.id);
    expect(audit.find((entry) => entry.action === 'customer.passkey_added')?.details).toEqual({
      id: row?.id,
      name: 'iOS · Safari',
    });
    const email = (await emailsTo(test.db, customer.email)).find(
      (item) => item.template === 'customer_passkey_added',
    );
    expect(email?.params).toMatchObject({ name: 'iOS · Safari', browser: 'Safari', system: 'iOS' });

    // The grant is used once.
    expect(await body((await registerOptions(customer.cookie)).response)).toMatchObject({
      status: 403,
      code: 'REAUTHENTICATION_REQUIRED',
    });
  });

  it('refuses an expired grant', async () => {
    const customer = await signedIn();
    expect((await authorize(customer.cookie)).status).toBe(204);
    await test.db
      .update(customerVerifications)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(
        and(
          like(customerVerifications.identifier, `${passkeyGrantIdentifier('')}%`),
          eq(customerVerifications.value, customer.id),
        ),
      );
    expect(await body((await registerOptions(customer.cookie)).response)).toMatchObject({
      status: 403,
      code: 'REAUTHENTICATION_REQUIRED',
    });
  });

  it('refuses a grant that expired between the options and the registration', async () => {
    const customer = await signedIn();
    expect((await authorize(customer.cookie)).status).toBe(204);
    const { response, challenge } = await registerOptions(customer.cookie);
    const json = (await response.json()) as { challenge: string };
    const [session] = await test.db
      .select({ id: customerVerifications.id })
      .from(customerVerifications)
      .where(eq(customerVerifications.value, customer.id));
    await test.db
      .update(customerVerifications)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(customerVerifications.id, session?.id ?? ''));
    const registered = await client.post('/api/auth/passkey/register', {
      cookie: `${customer.cookie}; ${challenge}`,
      body: { response: authenticator().register(json) },
    });
    expect(await body(registered)).toMatchObject({
      status: 403,
      code: 'REAUTHENTICATION_REQUIRED',
    });
    expect(await passkeyRows(customer.id)).toEqual([]);
  });

  it('refuses without user verification, from another origin, and a replayed challenge', async () => {
    const customer = await signedIn();
    const unverified = authenticator();
    unverified.userVerified = false;
    expect(await body(await addPasskey(customer.cookie, unverified))).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
    expect(
      (await addPasskey(customer.cookie, authenticator(), { origin: 'https://evil.example' }))
        .status,
    ).toBe(400);

    const { response, challenge } = await registerOptions(customer.cookie);
    const json = (await response.json()) as { challenge: string };
    const device = authenticator();
    const send = () =>
      client.post('/api/auth/passkey/register', {
        cookie: `${customer.cookie}; ${challenge}`,
        body: { response: device.register(json) },
      });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(400);
    expect(await passkeyRows(customer.id)).toHaveLength(1);
  });

  it(`stops at ${PASSKEYS_MAX} passkeys`, async () => {
    const customer = await signedIn();
    await test.db.insert(customerPasskeys).values(
      Array.from({ length: PASSKEYS_MAX }, (_, index) => ({
        customerId: customer.id,
        name: `Device ${index}`,
        publicKey: 'AA==',
        credentialId: `seeded-${customer.id}-${index}`,
        counter: 0,
        deviceType: 'multiDevice' as const,
        backedUp: true,
      })),
    );
    expect((await authorize(customer.cookie)).status).toBe(204);
    expect(await body((await registerOptions(customer.cookie)).response)).toMatchObject({
      status: 409,
      code: 'PASSKEYS_LIMIT_REACHED',
    });
  });
});

describe('signing in with a passkey (PK3)', () => {
  it('creates a session through the sign-in hooks and records the use', async () => {
    const customer = await signedIn();
    const device = authenticator();
    expect((await addPasskey(customer.cookie, device)).status).toBe(200);
    device.counter = 1;
    const ip = clientIp();
    const signedInWith = await signInWith(device, ip);
    expect(signedInWith.status).toBe(200);
    // The body's own `status: true`, as the password sign-in answers.
    expect(await signedInWith.clone().json()).toMatchObject({
      status: true,
      user: { id: customer.id, email: customer.email },
    });
    const session = cookieHeader(signedInWith);
    expect((await client.get('/api/account', { cookie: session })).status).toBe(200);
    const signIns = await test.db
      .select()
      .from(customerSignIns)
      .where(eq(customerSignIns.customerId, customer.id));
    expect(signIns).toHaveLength(2);
    expect(signIns.map((row) => row.ipAddress)).toContain(ip);
    const notices = (await emailsTo(test.db, customer.email)).filter(
      (email) => email.template === 'customer_new_sign_in',
    );
    expect(notices).toHaveLength(2);
    const [row] = await passkeyRows(customer.id);
    expect(row?.counter).toBe(1);
    expect(row?.lastUsedAt).not.toBeNull();
  });

  it('refuses a counter that did not go up, a wrong signature and an unknown credential', async () => {
    const customer = await signedIn();
    const device = authenticator();
    expect((await addPasskey(customer.cookie, device)).status).toBe(200);
    device.counter = 5;
    expect((await signInWith(device)).status).toBe(200);
    expect(await body(await signInWith(device))).toMatchObject({
      status: 401,
      code: 'INVALID_EMAIL_OR_PASSWORD',
    });
    device.counter = 3;
    expect((await signInWith(device)).status).toBe(401);
    expect((await passkeyRows(customer.id))[0]?.counter).toBe(5);

    device.counter = 6;
    const options = await client.post('/api/auth/passkey/sign-in-options', { body: {} });
    const json = (await options.json()) as { challenge: string };
    const forged = await client.post('/api/auth/sign-in/passkey', {
      cookie: cookieHeader(options),
      body: { response: device.assert(json, strangerKey()) },
    });
    expect(forged.status).toBe(401);
    expect((await passkeyRows(customer.id))[0]?.counter).toBe(5);

    expect((await signInWith(authenticator())).status).toBe(401);
  });

  it('gives no session when a reset takes the passkey during the sign-in (PK5, review)', async () => {
    const customer = await signedIn();
    const device = authenticator();
    expect((await addPasskey(customer.cookie, device)).status).toBe(200);
    const service = test.app.get(AuthPasskeysService);
    const original = service.recordUse.bind(service);
    // The reset commits between the counter's update and the session.
    const spy = vi.spyOn(service, 'recordUse').mockImplementationOnce(async (passkey, counter) => {
      const use = await original(passkey, counter);
      await test.db.delete(customerPasskeys).where(eq(customerPasskeys.id, passkey.id));
      return use;
    });
    const sessionsBefore = await sessionsOf(customer.id);
    try {
      device.counter = 1;
      const refused = await signInWith(device);
      expect(refused.status).toBe(401);
      expect(cookieHeader(refused)).not.toMatch(/session_token=[^;]/);
    } finally {
      spy.mockRestore();
    }
    expect(await sessionsOf(customer.id)).toEqual(sessionsBefore);
  });

  it('reports a removed passkey as gone, never as a cloned one', async () => {
    const service = test.app.get(AuthPasskeysService);
    const missing = {
      id: '0199e000-0000-7000-8000-00000000dead',
      customerId: '0199e000-0000-7000-8000-00000000beef',
      publicKey: 'AA==',
      counter: 3,
      transports: null,
    };
    expect(await service.recordUse(missing, 4)).toBe('gone');
  });

  it('keeps synced passkeys at counter zero signing in', async () => {
    const customer = await signedIn();
    const device = authenticator();
    expect((await addPasskey(customer.cookie, device)).status).toBe(200);
    expect((await signInWith(device)).status).toBe(200);
    expect((await signInWith(device)).status).toBe(200);
  });

  it('refuses a registration challenge and a missing challenge', async () => {
    const customer = await signedIn();
    const device = authenticator();
    expect((await addPasskey(customer.cookie, device)).status).toBe(200);
    expect((await authorize(customer.cookie)).status).toBe(204);
    const { response, challenge } = await registerOptions(customer.cookie);
    const json = (await response.json()) as { challenge: string };
    const crossed = await client.post('/api/auth/sign-in/passkey', {
      cookie: challenge,
      body: { response: device.assert(json) },
    });
    expect(crossed.status).toBe(401);
    const bare = await client.post('/api/auth/sign-in/passkey', {
      body: { response: device.assert(json) },
    });
    expect(bare.status).toBe(401);
  });

  it('gives an archived customer no session (C15, edge case 20)', async () => {
    const customer = await signedIn();
    const device = authenticator();
    expect((await addPasskey(customer.cookie, device)).status).toBe(200);
    await test.db
      .update(customers)
      .set({ archivedAt: new Date() })
      .where(eq(customers.id, customer.id));
    const refused = await signInWith(device);
    expect(await body(refused.clone())).toMatchObject({
      status: 401,
      code: 'INVALID_EMAIL_OR_PASSWORD',
    });
    expect(cookieHeader(refused)).not.toMatch(/session_token=/);
  });

  it('limits sign-ins per address (C8)', async () => {
    const ip = clientIp();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await client.post('/api/auth/sign-in/passkey', {
        body: { response: {} },
        ip,
      });
      statuses.push(response.status);
    }
    expect(statuses.at(-1)).toBe(429);
  });
});

describe('managing passkeys (PK4)', () => {
  it('renames and removes own passkeys only', async () => {
    const owner = await signedIn();
    const other = await signedIn();
    const device = authenticator();
    expect((await addPasskey(owner.cookie, device)).status).toBe(200);
    const [row] = await passkeyRows(owner.id);
    const id = row?.id as string;

    expect(
      await body(
        await client.patch(`/api/account/passkeys/${id}`, {
          cookie: owner.cookie,
          body: { name: ' هاتفي ' },
        }),
      ),
    ).toMatchObject({ status: 200, id, name: 'هاتفي' });
    expect(
      (
        await client.patch(`/api/account/passkeys/${id}`, {
          cookie: owner.cookie,
          body: { name: 'a‮b' },
        })
      ).status,
    ).toBe(400);
    expect(
      await body(
        await client.patch(`/api/account/passkeys/${id}`, {
          cookie: other.cookie,
          body: { name: 'x' },
        }),
      ),
    ).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(
      (await client.delete(`/api/account/passkeys/${id}`, { cookie: other.cookie })).status,
    ).toBe(404);

    expect(
      (await client.delete(`/api/account/passkeys/${id}`, { cookie: owner.cookie })).status,
    ).toBe(204);
    expect(await passkeyRows(owner.id)).toEqual([]);
    const audit = await auditOf(test.db, owner.id);
    expect(audit.find((entry) => entry.action === 'customer.passkey_removed')?.details).toEqual({
      id,
      name: 'هاتفي',
    });
    device.counter = 1;
    expect((await signInWith(device)).status).toBe(401);
  });
});

describe('the password reset (PK5)', () => {
  it('deletes every passkey with one audit entry; a password change keeps them', async () => {
    const customer = await signedIn();
    expect((await addPasskey(customer.cookie, authenticator())).status).toBe(200);
    const changed = await client.post('/api/auth/change-password', {
      cookie: customer.cookie,
      body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(changed.status).toBe(200);
    expect(await passkeyRows(customer.id)).toHaveLength(1);

    await client.post('/api/auth/email-otp/request-password-reset', {
      body: { email: customer.email },
      headers: await client.altcha(),
    });
    const reset = await client.post('/api/auth/email-otp/reset-password', {
      body: {
        email: customer.email,
        otp: await lastCode(test.db, customer.email),
        password: PASSWORD,
      },
    });
    expect(reset.status).toBe(200);
    expect(await passkeyRows(customer.id)).toEqual([]);
    const cleared = await test.db
      .select()
      .from(auditEntries)
      .where(
        and(
          eq(auditEntries.entityId, customer.id),
          eq(auditEntries.action, 'customer.passkeys_cleared'),
        ),
      );
    expect(cleared).toEqual([
      expect.objectContaining({ actorKind: 'system', details: { count: 1 } }),
    ]);
  });
});

describe('the admin profile (PK6)', () => {
  it('lists a customer passkeys read only', async () => {
    const customer = await signedIn();
    expect((await addPasskey(customer.cookie, authenticator())).status).toBe(200);
    const admin = await client.adminWithTotp(test.db);
    seeded.push(admin.id);
    const response = await client.get(`/api/admin/customers/${customer.id}/passkeys`, {
      cookie: admin.cookie,
    });
    expect(response.status).toBe(200);
    const items = (await response.json()) as Record<string, unknown>[];
    expect(items).toEqual([expect.objectContaining({ name: 'iOS · Safari', lastUsedAt: null })]);
    expect(Object.keys(items[0] ?? {})).not.toContain('publicKey');
    expect(
      (
        await client.get(`/api/admin/customers/${customer.id}/passkeys`, {
          cookie: customer.cookie,
        })
      ).status,
    ).toBe(401);
  });
});
