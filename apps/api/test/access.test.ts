import { customers, staffUsers } from '@vertex-digital/db';
import type { Challenge } from 'altcha-lib';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  api,
  body,
  PASSWORD,
  removeAccounts,
  seedCustomer,
  seedStaff,
  solveAltcha,
} from './helpers.js';
import { ProbeController } from './probe.controller.js';
import { startApp, type TestApp } from './start-app.js';

/*
 * Access (ADR 0007, 0011): customer and staff routes, each opened only by its own kind of session;
 * staff routes also need TOTP and the permission.
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

  it('refuse a customer whose email is not verified', async () => {
    const customer = await seedCustomer(test.db, { emailVerified: false });
    seeded.push(customer.id);
    const cookie = await client.signInCustomer(customer.email);
    expect(await body(await client.get('/api/probe/customer', { cookie }))).toMatchObject({
      status: 403,
      code: 'EMAIL_NOT_VERIFIED',
    });
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

  it('keep sign-up closed until F01', async () => {
    const response = await client.post('/api/auth/sign-up/email', {
      body: { email: 'new@test.vertex-digital.local', password: PASSWORD, name: 'New' },
    });
    expect(response.status).not.toBe(200);
  });

  it('refuse a staff session', async () => {
    const member = await client.staffWithTotp(test.db, 'owner');
    seeded.push(member.id);
    const response = await client.get('/api/probe/customer', { cookie: member.cookie });
    expect(response.status).toBe(401);
  });
});

describe('staff routes', () => {
  it('answer 401 without a session', async () => {
    expect(await body(await client.get('/api/admin/probe/staff'))).toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
    });
  });

  it('refuse a customer session', async () => {
    const customer = await seedCustomer(test.db);
    seeded.push(customer.id);
    const cookie = await client.signInCustomer(customer.email);
    expect((await client.get('/api/admin/probe/staff', { cookie })).status).toBe(401);
  });

  it('ask for TOTP until the staff member enrols, then let them in', async () => {
    const member = await seedStaff(test.db, { role: 'support' });
    seeded.push(member.id);
    const cookie = await client.signInStaff(member.email);
    expect(cookie).toMatch(/^vd-staff\.session_token=/);
    expect(await body(await client.get('/api/admin/probe/staff', { cookie }))).toMatchObject({
      status: 403,
      code: 'TWO_FACTOR_REQUIRED',
    });

    const { secret } = await client.enrolTotp(cookie);
    // Once enrolled, the password alone opens nothing: the sign-in asks for the code.
    const passwordOnly = await client.post('/api/admin/auth/sign-in/email', {
      body: { email: member.email, password: PASSWORD },
    });
    expect(await passwordOnly.json()).toMatchObject({ twoFactorRedirect: true });

    const signedIn = await client.signInStaff(member.email, secret);
    expect(await body(await client.get('/api/admin/probe/staff', { cookie: signedIn }))).toEqual({
      status: 200,
      id: member.id,
      role: 'support',
    });
  });

  it('refuse "trust this device"', async () => {
    const member = await seedStaff(test.db);
    seeded.push(member.id);
    const response = await client.post('/api/admin/auth/sign-in/email', {
      body: { email: member.email, password: PASSWORD, trustDevice: true },
    });
    expect(response.status).toBe(400);
  });

  it('check the permission map', async () => {
    const support = await client.staffWithTotp(test.db, 'support');
    const owner = await client.staffWithTotp(test.db, 'owner');
    seeded.push(support.id, owner.id);
    expect(
      await body(await client.get('/api/admin/probe/manage', { cookie: support.cookie })),
    ).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect((await client.get('/api/admin/probe/manage', { cookie: owner.cookie })).status).toBe(
      200,
    );
  });

  it('drop the session of a staff member archived later', async () => {
    const member = await client.staffWithTotp(test.db, 'manager');
    seeded.push(member.id);
    await test.db
      .update(staffUsers)
      .set({ archivedAt: new Date() })
      .where(eq(staffUsers.id, member.id));
    expect((await client.get('/api/admin/probe/staff', { cookie: member.cookie })).status).toBe(
      401,
    );
  });

  it('ask for ALTCHA after repeated wrong passwords from any address, without locking out', async () => {
    const member = await seedStaff(test.db);
    seeded.push(member.id);
    const signIn = (password: string, headers?: Record<string, string>) =>
      client.post('/api/admin/auth/sign-in/email', {
        body: { email: member.email, password },
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
