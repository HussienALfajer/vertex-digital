import { adminSessions, adminUsers } from '@vertex-digital/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAdmin, resetAdminPassword } from '../src/modules/admin/index.js';
import {
  api,
  auditOf,
  body,
  cookieHeader,
  PASSWORD,
  removeAccounts,
  seedAdmin,
  seedCustomer,
  totp,
  uniqueEmail,
} from './helpers.js';
import { ProbeController } from './probe.controller.js';
import { startApp, type TestApp } from './start-app.js';

/*
 * The admin account (S01 rules D1–D8, ADR 0016): the forced password change, TOTP enrolment, the
 * idle timeout, re-authentication and own sessions.
 */

let test: TestApp;
let client: ReturnType<typeof api>;
const seeded: string[] = [];

const NEW_PASSWORD = 'a7Kq-blue-moon-river';
const MINUTE = 60 * 1000;

beforeAll(async () => {
  test = await startApp({ controllers: [ProbeController] });
  client = api(test.url);
});

afterAll(async () => {
  await removeAccounts(test.db, seeded);
  await test.app.close();
});

/** The session of a cookie: its token is the part before the signature. */
const sessionOf = async (cookie: string) => {
  const value = /vd-admin\.session_token=([^;]+)/.exec(cookie)?.[1] ?? '';
  const token = decodeURIComponent(value).split('.')[0] ?? '';
  const [session] = await test.db
    .select()
    .from(adminSessions)
    .where(eq(adminSessions.token, token));
  if (!session) throw new Error('No admin session');
  return session;
};

describe('the first sign-in (rule D1)', () => {
  it('changes the CLI-issued password, then enrols TOTP, then opens the panel', async () => {
    await test.db.delete(adminUsers);
    const email = uniqueEmail('admin');
    const { id, password } = await createAdmin(test.db, { email, name: 'المدير' });
    seeded.push(id);
    const signIn = await client.post('/api/admin/auth/sign-in/email', {
      body: { email, password },
    });
    let cookie = cookieHeader(signIn);

    expect(await body(await client.get('/api/admin/probe/admin', { cookie }))).toMatchObject({
      status: 403,
      code: 'PASSWORD_CHANGE_REQUIRED',
    });
    expect(
      await body(
        await client.post('/api/admin/auth/two-factor/enable', { cookie, body: { password } }),
      ),
    ).toMatchObject({ status: 403, code: 'PASSWORD_CHANGE_REQUIRED' });
    expect((await client.get('/api/admin/probe/setup', { cookie })).status).toBe(200);

    const change = (currentPassword: string, newPassword: string) =>
      client.post('/api/admin/auth/change-password', {
        cookie,
        body: { currentPassword, newPassword },
      });
    expect(await body(await change('wrong-password', NEW_PASSWORD))).toMatchObject({
      status: 400,
      code: 'INVALID_PASSWORD',
    });
    expect(await body(await change(password, 'too-short-1'))).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(await body(await change(password, 'businessbabe'))).toMatchObject({
      code: 'PASSWORD_TOO_COMMON',
    });
    expect(await body(await change(password, NEW_PASSWORD))).toEqual({
      status: 200,
      success: true,
    });

    expect(await body(await client.get('/api/admin/probe/admin', { cookie }))).toMatchObject({
      status: 403,
      code: 'TWO_FACTOR_REQUIRED',
    });
    const enabled = await client.post('/api/admin/auth/two-factor/enable', {
      cookie,
      body: { password: NEW_PASSWORD },
    });
    const { totpURI } = (await enabled.json()) as { totpURI: string };
    const secret = new URL(totpURI).searchParams.get('secret') ?? '';
    const verified = await client.post('/api/admin/auth/two-factor/verify-totp', {
      cookie,
      body: { code: totp(secret) },
    });
    cookie = cookieHeader(verified) || cookie;
    expect((await client.get('/api/admin/probe/admin', { cookie })).status).toBe(200);

    const actions = (await auditOf(test.db, id)).map((entry) => [
      entry.action,
      entry.actorKind,
      entry.channel,
    ]);
    expect(actions).toEqual([
      ['admin.created', 'cli', 'cli'],
      ['admin.password_changed', 'admin', 'admin'],
      ['admin.two_factor_enabled', 'admin', 'admin'],
      ['admin.signed_in', 'admin', 'admin'],
    ]);
  });

  it('refuses the change without a session and with a customer session', async () => {
    const customer = await seedCustomer(test.db);
    seeded.push(customer.id);
    const customerCookie = await client.signInCustomer(customer.email);
    for (const cookie of [undefined, customerCookie]) {
      const response = await client.post('/api/admin/auth/change-password', {
        cookie,
        body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      });
      expect(response.status).toBe(401);
    }
  });
});

describe('sessions (rule D4)', () => {
  it('end after 30 minutes without activity', async () => {
    const admin = await client.adminWithTotp(test.db);
    seeded.push(admin.id);
    const session = await sessionOf(admin.cookie);
    await test.db
      .update(adminSessions)
      .set({ lastActiveAt: new Date(Date.now() - 31 * MINUTE) })
      .where(eq(adminSessions.id, session.id));
    expect(
      await body(await client.get('/api/admin/probe/admin', { cookie: admin.cookie })),
    ).toMatchObject({ status: 401, code: 'SESSION_IDLE_EXPIRED' });
    expect(
      await test.db.select().from(adminSessions).where(eq(adminSessions.id, session.id)),
    ).toEqual([]);
    expect(
      await body(await client.get('/api/admin/probe/admin', { cookie: admin.cookie })),
    ).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
  });

  it('end on the Better Auth routes too: an idle session reads as signed out', async () => {
    const admin = await client.adminWithTotp(test.db);
    seeded.push(admin.id);
    const session = await sessionOf(admin.cookie);
    await test.db
      .update(adminSessions)
      .set({ lastActiveAt: new Date(Date.now() - 31 * MINUTE) })
      .where(eq(adminSessions.id, session.id));
    const read = await client.get('/api/admin/auth/get-session', { cookie: admin.cookie });
    expect(await read.json()).toBeNull();
  });

  it('count the admin’s requests as activity, not the panel’s own polling', async () => {
    const admin = await client.adminWithTotp(test.db);
    seeded.push(admin.id);
    const session = await sessionOf(admin.cookie);
    const tenMinutesAgo = new Date(Date.now() - 10 * MINUTE);
    await test.db
      .update(adminSessions)
      .set({ lastActiveAt: tenMinutesAgo })
      .where(eq(adminSessions.id, session.id));
    await client.get('/api/admin/probe/admin', {
      cookie: admin.cookie,
      headers: { 'x-background-request': '1' },
    });
    expect((await sessionOf(admin.cookie)).lastActiveAt).toEqual(tenMinutesAgo);
    await client.get('/api/admin/probe/admin', { cookie: admin.cookie });
    expect((await sessionOf(admin.cookie)).lastActiveAt.getTime()).toBeGreaterThan(
      Date.now() - MINUTE,
    );
  });

  it('end 12 hours after sign-in, whatever the activity', async () => {
    const admin = await client.adminWithTotp(test.db);
    seeded.push(admin.id);
    const session = await sessionOf(admin.cookie);
    const lifetime = session.expiresAt.getTime() - session.createdAt.getTime();
    expect(Math.round(lifetime / MINUTE)).toBe(12 * 60);
  });
});

describe('re-authentication (rule D5)', () => {
  it('opens sensitive routes for 5 minutes with the password and an app code', async () => {
    const admin = await client.adminWithTotp(test.db);
    seeded.push(admin.id);
    const sensitive = () => client.get('/api/admin/probe/sensitive', { cookie: admin.cookie });
    const reauthenticate = (password: string, totpCode: string) =>
      client.post('/api/admin/me/reauthenticate', {
        cookie: admin.cookie,
        body: { password, totpCode },
      });
    expect(await body(await sensitive())).toMatchObject({
      status: 403,
      code: 'REAUTHENTICATION_REQUIRED',
    });
    expect(await body(await reauthenticate('wrong-password', totp(admin.secret)))).toMatchObject({
      status: 400,
      code: 'INVALID_PASSWORD',
    });
    const wrongCode = totp(admin.secret) === '000000' ? '111111' : '000000';
    expect(await body(await reauthenticate(PASSWORD, wrongCode))).toMatchObject({
      status: 400,
      code: 'INVALID_CODE',
    });
    const answer = await body(await reauthenticate(PASSWORD, totp(admin.secret)));
    expect(answer.status).toBe(200);
    const until = new Date(
      String((answer as { reauthenticatedUntil?: string }).reauthenticatedUntil),
    ).getTime();
    expect(until).toBeGreaterThan(Date.now() + 4 * MINUTE);
    expect(await body(await sensitive())).toEqual({ status: 200, id: admin.id });

    const session = await sessionOf(admin.cookie);
    await test.db
      .update(adminSessions)
      .set({ reauthenticatedAt: new Date(Date.now() - 6 * MINUTE) })
      .where(eq(adminSessions.id, session.id));
    expect((await sensitive()).status).toBe(403);
  });

  it('refuses a backup code', async () => {
    const admin = await client.adminWithTotp(test.db);
    seeded.push(admin.id);
    const response = await client.post('/api/admin/me/reauthenticate', {
      cookie: admin.cookie,
      body: { password: PASSWORD, totpCode: 'abcde-fghjk' },
    });
    expect(await body(response)).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
  });
});

describe('own sessions and backup codes (rule D7)', () => {
  it('lists the admin’s sessions and signs one out', async () => {
    const admin = await client.adminWithTotp(test.db);
    seeded.push(admin.id);
    const other = await client.signInAdmin(admin.email, admin.secret);
    const listed = (await (
      await client.get('/api/admin/me/sessions', { cookie: admin.cookie })
    ).json()) as { id: string; current: boolean }[];
    expect(listed.filter((session) => session.current)).toHaveLength(1);
    const target = listed.find((session) => !session.current && listed.length > 1);
    expect(target).toBeDefined();
    expect(
      (await client.delete(`/api/admin/me/sessions/${target?.id}`, { cookie: admin.cookie }))
        .status,
    ).toBe(204);
    expect(
      (await client.delete(`/api/admin/me/sessions/${target?.id}`, { cookie: admin.cookie }))
        .status,
    ).toBe(404);
    const stillIn = await Promise.all(
      [admin.cookie, other].map(
        async (cookie) => (await client.get('/api/admin/probe/admin', { cookie })).status,
      ),
    );
    expect(stillIn.sort()).toEqual([200, 401]);
    expect((await auditOf(test.db, admin.id)).at(-1)).toMatchObject({
      action: 'admin.sessions_revoked',
      details: { count: 1 },
    });
  });

  it('lists only the sessions that still sign in, never cached', async () => {
    const admin = await client.adminWithTotp(test.db);
    seeded.push(admin.id);
    const expired = await sessionOf(await client.signInAdmin(admin.email, admin.secret));
    const idle = await sessionOf(await client.signInAdmin(admin.email, admin.secret));
    const live = await sessionOf(await client.signInAdmin(admin.email, admin.secret));
    await test.db
      .update(adminSessions)
      .set({ expiresAt: new Date(Date.now() - MINUTE) })
      .where(eq(adminSessions.id, expired.id));
    await test.db
      .update(adminSessions)
      .set({ lastActiveAt: new Date(Date.now() - 31 * MINUTE) })
      .where(eq(adminSessions.id, idle.id));
    const response = await client.get('/api/admin/me/sessions', { cookie: admin.cookie });
    expect(response.headers.get('cache-control')).toBe('no-store');
    const ids = ((await response.json()) as { id: string }[]).map((session) => session.id);
    expect(ids).toContain(live.id);
    expect(ids).not.toContain(expired.id);
    expect(ids).not.toContain(idle.id);
  });

  it('regenerates the backup codes with the password, audited', async () => {
    const admin = await client.adminWithTotp(test.db);
    seeded.push(admin.id);
    const response = await client.post('/api/admin/auth/two-factor/generate-backup-codes', {
      cookie: admin.cookie,
      body: { password: PASSWORD },
    });
    const { backupCodes } = (await response.json()) as { backupCodes: string[] };
    expect(backupCodes).toHaveLength(10);
    expect((await auditOf(test.db, admin.id)).at(-1)).toMatchObject({
      action: 'admin.backup_codes_regenerated',
    });
    expect(
      (
        await client.post('/api/admin/auth/two-factor/disable', {
          cookie: admin.cookie,
          body: { password: PASSWORD },
        })
      ).status,
    ).toBe(404);
  });

  it('refuses every own-account route without a session', async () => {
    expect((await client.get('/api/admin/me/sessions')).status).toBe(401);
    expect(
      (
        await client.post('/api/admin/me/reauthenticate', {
          body: { password: PASSWORD, totpCode: '123456' },
        })
      ).status,
    ).toBe(401);
  });
});

describe('hardening (review of S01)', () => {
  it('refuses keeping the CLI-issued password as the new one (rule D1)', async () => {
    await test.db.delete(adminUsers);
    const email = uniqueEmail('admin');
    const { id, password } = await createAdmin(test.db, { email, name: 'المدير' });
    seeded.push(id);
    const cookie = cookieHeader(
      await client.post('/api/admin/auth/sign-in/email', { body: { email, password } }),
    );
    const response = await client.post('/api/admin/auth/change-password', {
      cookie,
      body: { currentPassword: password, newPassword: password },
    });
    expect(await body(response)).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      details: [{ path: ['newPassword'], message: 'PASSWORD_UNCHANGED' }],
    });
  });

  it('keeps an enrolled authenticator: enrolling again needs a reset on the server', async () => {
    const admin = await client.adminWithTotp(test.db);
    seeded.push(admin.id);
    const response = await client.post('/api/admin/auth/two-factor/enable', {
      cookie: admin.cookie,
      body: { password: PASSWORD },
    });
    expect(response.status).toBe(403);
  });

  it('answers the backup codes with no-store, and no URL spelling reaches a disabled route', async () => {
    const admin = await client.adminWithTotp(test.db);
    seeded.push(admin.id);
    const codes = await client.post('/api/admin/auth/two-factor/generate-backup-codes', {
      cookie: admin.cookie,
      body: { password: PASSWORD },
    });
    expect(codes.headers.get('cache-control')).toBe('no-store');
    for (const path of [
      '/api/admin/auth//two-factor/disable',
      '/api/admin/auth/Two-Factor/disable',
    ]) {
      const response = await client.post(path, {
        cookie: admin.cookie,
        body: { password: PASSWORD },
      });
      expect(response.status, path).toBe(404);
    }
    expect((await client.get('/api/admin/probe/admin', { cookie: admin.cookie })).status).toBe(200);
  });
});

describe('second review (findings R1–R6)', () => {
  /** The password step only: the pending TOTP challenge's cookie. */
  const passwordStep = async (email: string, password = PASSWORD, extra = {}) => {
    const response = await client.post('/api/admin/auth/sign-in/email', {
      body: { email, password, ...extra },
    });
    expect(response.status).toBe(200);
    return cookieHeader(response);
  };
  const totpStep = (cookie: string, secret: string) =>
    client.post('/api/admin/auth/two-factor/verify-totp', {
      cookie,
      body: { code: totp(secret) },
    });

  it('R1: enrolling TOTP signs out every session that never passed it', async () => {
    const admin = await seedAdmin(test.db);
    seeded.push(admin.id);
    const before = await client.signInAdmin(admin.email);
    const { cookie } = await client.enrolTotp(await client.signInAdmin(admin.email));
    expect((await client.get('/api/admin/probe/admin', { cookie: before })).status).toBe(401);
    expect((await client.get('/api/admin/probe/admin', { cookie })).status).toBe(200);
  });

  it('R2: a session never outlives 12 hours, even when asked not to be remembered', async () => {
    const admin = await client.adminWithTotp(test.db);
    seeded.push(admin.id);
    const pending = await passwordStep(admin.email, PASSWORD, { rememberMe: false });
    const verified = await totpStep(pending, admin.secret);
    expect(verified.status).toBe(200);
    const session = await sessionOf(cookieHeader(verified));
    const lifetime = session.expiresAt.getTime() - session.createdAt.getTime();
    expect(lifetime).toBeLessThanOrEqual(12 * 60 * MINUTE);
  });

  it('R3: a password change or reset voids a pending TOTP step', async () => {
    const admin = await client.adminWithTotp(test.db);
    seeded.push(admin.id);
    const pending = await passwordStep(admin.email);
    const changed = await client.post('/api/admin/auth/change-password', {
      cookie: admin.cookie,
      body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(changed.status).toBe(200);
    expect((await totpStep(pending, admin.secret)).status).toBe(401);

    const again = await passwordStep(admin.email, NEW_PASSWORD);
    await resetAdminPassword(test.db, admin.email);
    expect((await totpStep(again, admin.secret)).status).toBe(401);
  });

  it('R4: of two password changes at once, the one whose session ended is refused', async () => {
    const admin = await client.adminWithTotp(test.db);
    seeded.push(admin.id);
    const other = await client.signInAdmin(admin.email, admin.secret);
    const passwords = [NEW_PASSWORD, 'b8Lr-green-sea-lake'];
    const answers = await Promise.all(
      [admin.cookie, other].map((cookie, index) =>
        client.post('/api/admin/auth/change-password', {
          cookie,
          body: { currentPassword: PASSWORD, newPassword: passwords[index] },
        }),
      ),
    );
    const statuses = answers.map((answer) => answer.status);
    expect([...statuses].sort()).toEqual([200, 401]);
    const kept = passwords[statuses.indexOf(200)];
    const lost = passwords[statuses.indexOf(401)];
    expect(
      (
        await client.post('/api/admin/auth/sign-in/email', {
          body: { email: admin.email, password: lost },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await client.post('/api/admin/auth/sign-in/email', {
          body: { email: admin.email, password: kept },
        })
      ).status,
    ).toBe(200);
  });

  it('R5: backup codes wait for the CLI-issued password to be changed', async () => {
    const admin = await client.adminWithTotp(test.db);
    seeded.push(admin.id);
    const { password } = await resetAdminPassword(test.db, admin.email);
    const verified = await totpStep(await passwordStep(admin.email, password), admin.secret);
    expect(verified.status).toBe(200);
    const codes = await client.post('/api/admin/auth/two-factor/generate-backup-codes', {
      cookie: cookieHeader(verified),
      body: { password },
    });
    expect(await body(codes)).toMatchObject({ status: 403, code: 'PASSWORD_CHANGE_REQUIRED' });
  });

  it('R6: the admin’s actions on Better Auth routes count as activity', async () => {
    const admin = await client.adminWithTotp(test.db);
    seeded.push(admin.id);
    const session = await sessionOf(admin.cookie);
    await test.db
      .update(adminSessions)
      .set({ lastActiveAt: new Date(Date.now() - 20 * MINUTE) })
      .where(eq(adminSessions.id, session.id));
    const codes = await client.post('/api/admin/auth/two-factor/generate-backup-codes', {
      cookie: admin.cookie,
      body: { password: PASSWORD },
    });
    expect(codes.status).toBe(200);
    expect((await sessionOf(admin.cookie)).lastActiveAt.getTime()).toBeGreaterThan(
      Date.now() - MINUTE,
    );
  });
});
