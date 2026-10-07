import { adminUsers, customers } from '@vertex-digital/db';
import type { Challenge } from 'altcha-lib';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  api,
  body,
  PASSWORD,
  removeAccounts,
  seedAdmin,
  seedCustomer,
  solveAltcha,
} from './helpers.js';
import { ProbeController } from './probe.controller.js';
import { startApp, type TestApp } from './start-app.js';

/*
 * Access (ADR 0007, 0011, 0016): customer and admin routes, each opened only by its own kind of
 * session; admin routes also need TOTP.
 */

let test: TestApp;
let client: ReturnType<typeof api>;
const seeded: string[] = [];

beforeAll(async () => {
  test = await startApp({ controllers: [ProbeController] });
  client = api(test.url);
});

afterAll(async () => {
  await removeAccounts(test.db, seeded);
  await test.app.close();
});

describe('customer routes', () => {
  it('answer 401 without a session', async () => {
    expect(await body(await client.get('/api/probe/customer'))).toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
    });
  });

  it('let a verified customer in', async () => {
    const customer = await seedCustomer(test.db);
    seeded.push(customer.id);
    const cookie = await client.signInCustomer(customer.email);
    expect(cookie).toMatch(/^vd\.session_token=/);
    expect(await body(await client.get('/api/probe/customer', { cookie }))).toEqual({
      status: 200,
      id: customer.id,
    });
  });

  it('give a customer whose email is not verified no session (S01 account states)', async () => {
    const customer = await seedCustomer(test.db, { emailVerified: false });
    seeded.push(customer.id);
    const response = await client.post('/api/auth/sign-in/email', {
      body: { email: customer.email, password: PASSWORD },
    });
    expect(await body(response)).toMatchObject({ status: 403, code: 'EMAIL_NOT_VERIFIED' });
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it('give an archived customer no session, and drop the session of one archived later', async () => {
    const archived = await seedCustomer(test.db, { archived: true });
    const later = await seedCustomer(test.db);
    seeded.push(archived.id, later.id);
    const refused = await client.post('/api/auth/sign-in/email', {
      body: { email: archived.email, password: PASSWORD },
    });
    expect(refused.status).toBe(401);

    const cookie = await client.signInCustomer(later.email);
    await test.db
      .update(customers)
      .set({ archivedAt: new Date() })
      .where(eq(customers.id, later.id));
    expect((await client.get('/api/probe/customer', { cookie })).status).toBe(401);
  });

  it('refuse an admin session', async () => {
    const admin = await client.adminWithTotp(test.db);
    seeded.push(admin.id);
    const response = await client.get('/api/probe/customer', { cookie: admin.cookie });
    expect(response.status).toBe(401);
  });
});

describe('admin routes', () => {
  it('answer 401 without a session', async () => {
    expect(await body(await client.get('/api/admin/probe/admin'))).toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
    });
  });

  it('refuse a customer session', async () => {
    const customer = await seedCustomer(test.db);
    seeded.push(customer.id);
    const cookie = await client.signInCustomer(customer.email);
    expect((await client.get('/api/admin/probe/admin', { cookie })).status).toBe(401);
  });

  it('ask for TOTP until the admin enrols, then let the admin in', async () => {
    const admin = await seedAdmin(test.db);
    seeded.push(admin.id);
    const cookie = await client.signInAdmin(admin.email);
    expect(cookie).toMatch(/^vd-admin.session_token=/);
    expect(await body(await client.get('/api/admin/probe/admin', { cookie }))).toMatchObject({
      status: 403,
      code: 'TWO_FACTOR_REQUIRED',
    });

    const { secret } = await client.enrolTotp(cookie);
    // Once enrolled, the password alone opens nothing: the sign-in asks for the code.
    const passwordOnly = await client.post('/api/admin/auth/sign-in/email', {
      body: { email: admin.email, password: PASSWORD },
    });
    expect(await passwordOnly.json()).toMatchObject({ twoFactorRedirect: true });

    const signedIn = await client.signInAdmin(admin.email, secret);
    expect(await body(await client.get('/api/admin/probe/admin', { cookie: signedIn }))).toEqual({
      status: 200,
      id: admin.id,
    });
  });

  it('refuse "trust this device"', async () => {
    const admin = await seedAdmin(test.db);
    seeded.push(admin.id);
    const response = await client.post('/api/admin/auth/sign-in/email', {
      body: { email: admin.email, password: PASSWORD, trustDevice: true },
    });
    expect(response.status).toBe(400);
  });

  it('drop the session of an admin archived later', async () => {
    const admin = await client.adminWithTotp(test.db);
    seeded.push(admin.id);
    await test.db
      .update(adminUsers)
      .set({ archivedAt: new Date() })
      .where(eq(adminUsers.id, admin.id));
    expect((await client.get('/api/admin/probe/admin', { cookie: admin.cookie })).status).toBe(401);
  });

  it('ask for ALTCHA after repeated wrong passwords from any address, without locking out', async () => {
    const admin = await seedAdmin(test.db);
    seeded.push(admin.id);
    const signIn = (password: string, headers?: Record<string, string>) =>
      client.post('/api/admin/auth/sign-in/email', {
        body: { email: admin.email, password },
        ...(headers && { headers }),
      });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await signIn('wrong-password-123')).status).toBe(401);
    }
    expect(await body(await signIn(PASSWORD))).toMatchObject({
      status: 400,
      code: 'ALTCHA_REQUIRED',
    });
    expect(await body(await signIn(PASSWORD, { 'x-altcha': 'garbage' }))).toMatchObject({
      status: 400,
      code: 'ALTCHA_INVALID',
    });

    const challenge = (await (await client.get('/api/altcha/challenge')).json()) as Challenge;
    const solved = await signIn(PASSWORD, { 'x-altcha': await solveAltcha(challenge) });
    expect(solved.status).toBe(200);
    // A successful sign-in clears the failures: the next one needs no challenge.
    expect((await signIn(PASSWORD)).status).toBe(200);
  });
});

describe('a route without an access declaration', () => {
  it('is refused', async () => {
    expect(await body(await client.get('/api/probe/undeclared'))).toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });
  });
});
