import { staffSessions, staffTwoFactors, staffUsers } from '@vertex-digital/db';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFirstOwner,
  resetStaffTwoFactor,
  StaffAccountError,
} from '../src/modules/staff/index.js';
import { api, removeAccounts, uniqueEmail } from './helpers.js';
import { ProbeController } from './probe.controller.js';
import { startApp, type TestApp } from './start-app.js';

/* The staff command-line tools (ADR 0007): the first owner and the owner's TOTP reset. */

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

describe('the first owner', () => {
  it('is created once, signs in with the printed password and must enrol TOTP', async () => {
    const active = await test.db
      .select({ id: staffUsers.id })
      .from(staffUsers)
      .where(and(eq(staffUsers.role, 'owner'), isNull(staffUsers.archivedAt)));
    expect(active).toEqual([]);

    const email = uniqueEmail('owner');
    const { id, password } = await createFirstOwner(test.db, { email, name: 'المالك' });
    seeded.push(id);
    expect(password.length).toBeGreaterThanOrEqual(24);

    const signIn = await client.post('/api/admin/auth/sign-in/email', {
      body: { email, password },
    });
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    expect(await (await client.get('/api/admin/probe/manage', { cookie })).json()).toMatchObject({
      code: 'TWO_FACTOR_REQUIRED',
    });

    await expect(
      createFirstOwner(test.db, { email: uniqueEmail('second'), name: 'Second' }),
    ).rejects.toThrow(StaffAccountError);
  });
});

describe('the TOTP reset', () => {
  it('removes the secret, signs the member out everywhere and asks for enrolment again', async () => {
    const member = await client.staffWithTotp(test.db, 'manager');
    seeded.push(member.id);

    await resetStaffTwoFactor(test.db, member.email.toUpperCase());

    expect(
      await test.db.select().from(staffTwoFactors).where(eq(staffTwoFactors.userId, member.id)),
    ).toEqual([]);
    expect(
      await test.db.select().from(staffSessions).where(eq(staffSessions.userId, member.id)),
    ).toEqual([]);
    expect((await client.get('/api/admin/probe/staff', { cookie: member.cookie })).status).toBe(
      401,
    );
    const cookie = await client.signInStaff(member.email);
    expect(await (await client.get('/api/admin/probe/staff', { cookie })).json()).toMatchObject({
      code: 'TWO_FACTOR_REQUIRED',
    });
  });

  it('refuses an unknown email', async () => {
    await expect(resetStaffTwoFactor(test.db, uniqueEmail('nobody'))).rejects.toThrow(
      StaffAccountError,
    );
  });
});
