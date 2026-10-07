import { adminSessions, adminTwoFactors, adminUsers } from '@vertex-digital/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminAccountError, createAdmin, resetAdminTwoFactor } from '../src/modules/admin/index.js';
import { api, cookieHeader, removeAccounts, uniqueEmail } from './helpers.js';
import { ProbeController } from './probe.controller.js';
import { startApp, type TestApp } from './start-app.js';

/* The admin command-line tools (ADR 0016): creating the one admin account and its TOTP reset. */

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

describe('admin:create', () => {
  it('creates the admin once, who signs in with the printed password and must enrol TOTP', async () => {
    await test.db.delete(adminUsers);

    const email = uniqueEmail('admin');
    const { id, password } = await createAdmin(test.db, { email, name: 'المدير' });
    seeded.push(id);
    expect(password.length).toBeGreaterThanOrEqual(24);

    const signIn = await client.post('/api/admin/auth/sign-in/email', {
      body: { email, password },
    });
    expect(signIn.status).toBe(200);
    const cookie = cookieHeader(signIn);
    expect(await (await client.get('/api/admin/probe/admin', { cookie })).json()).toMatchObject({
      code: 'TWO_FACTOR_REQUIRED',
    });

    await expect(
      createAdmin(test.db, { email: uniqueEmail('second'), name: 'Second' }),
    ).rejects.toThrow(AdminAccountError);
  });
});

describe('admin:reset-two-factor', () => {
  it('removes the secret, signs the admin out everywhere and asks for enrolment again', async () => {
    const admin = await client.adminWithTotp(test.db);
    seeded.push(admin.id);

    await resetAdminTwoFactor(test.db, admin.email.toUpperCase());

    expect(
      await test.db.select().from(adminTwoFactors).where(eq(adminTwoFactors.userId, admin.id)),
    ).toEqual([]);
    expect(
      await test.db.select().from(adminSessions).where(eq(adminSessions.userId, admin.id)),
    ).toEqual([]);
    expect((await client.get('/api/admin/probe/admin', { cookie: admin.cookie })).status).toBe(401);
    const cookie = await client.signInAdmin(admin.email);
    expect(await (await client.get('/api/admin/probe/admin', { cookie })).json()).toMatchObject({
      code: 'TWO_FACTOR_REQUIRED',
    });
  });

  it('refuses an unknown email', async () => {
    await expect(resetAdminTwoFactor(test.db, uniqueEmail('nobody'))).rejects.toThrow(
      AdminAccountError,
    );
  });
});
