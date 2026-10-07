import { customerRateLimits, customerSessions, customers } from '@vertex-digital/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  seedCustomer,
  uniqueEmail,
} from './helpers.js';
import { ProbeController } from './probe.controller.js';
import { startApp, type TestApp } from './start-app.js';

/*
 * Customer accounts (S01 rules C1–C17) over HTTP: sign-up, email codes, sign-in, recovery,
 * password and email changes, sessions and the profile. Emails are read from the outbox, where the
 * worker would pick them up.
 */

let test: TestApp;
let client: ReturnType<typeof api>;
const seeded: string[] = [];

const NEW_PASSWORD = 'a7Kq-blue-moon-river';

beforeAll(async () => {
  test = await startApp({ controllers: [ProbeController] });
  client = api(test.url);
});

afterAll(async () => {
  await removeAccounts(test.db, seeded);
  await test.app.close();
});

async function idOf(email: string): Promise<string> {
  const [row] = await test.db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.email, email));
  if (!row) throw new Error(`No customer ${email}`);
  seeded.push(row.id);
  return row.id;
}

const signUpBody = (email: string) => ({
  name: 'سارة الأحمد',
  email,
  password: PASSWORD,
  phone: '0944 123 456',
});

async function signUp(email: string) {
  return client.post('/api/auth/sign-up/email', {
    body: signUpBody(email),
    headers: await client.altcha(),
  });
}

async function verify(email: string, otp: string) {
  return client.post('/api/auth/email-otp/verify-email', { body: { email, otp } });
}

/** Signs up over HTTP and verifies with the emailed code; returns the id and the session. */
async function signedUp(label: string) {
  const email = uniqueEmail(label);
  expect((await signUp(email)).status).toBe(200);
  const id = await idOf(email);
  const verified = await verify(email, await lastCode(test.db, email));
  expect(verified.status).toBe(200);
  return { id, email, cookie: cookieHeader(verified) };
}

describe('sign-up (rules C1, C2, C16)', () => {
  it('creates an unverified customer, audits it and emails a code; no session yet', async () => {
    const email = uniqueEmail('sign-up');
    const response = await signUp(email);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'code_sent' });
    expect(response.headers.getSetCookie()).toEqual([]);
    const id = await idOf(email);
    const [customer] = await test.db.select().from(customers).where(eq(customers.id, id));
    expect(customer).toMatchObject({
      name: 'سارة الأحمد',
      phone: '+963944123456',
      emailVerified: false,
      isTest: false,
    });
    expect((await auditOf(test.db, id)).map((entry) => entry.action)).toEqual([
      'customer.signed_up',
    ]);
    const emails = await emailsTo(test.db, email);
    expect(emails).toMatchObject([
      { template: 'customer_verify_email', priority: 'high', status: 'pending', customerId: id },
    ]);
    expect(emails[0]?.params).toEqual({ code: expect.stringMatching(/^\d{6}$/) });
  });

  it('answers an existing email exactly as a new one and sends the attempt notice once an hour', async () => {
    const existing = await seedCustomer(test.db);
    seeded.push(existing.id);
    const fresh = uniqueEmail('fresh');
    const known = await signUp(existing.email);
    const unknown = await signUp(fresh);
    await idOf(fresh);
    expect(known.status).toBe(unknown.status);
    expect(await known.json()).toEqual(await unknown.json());
    expect((await emailsTo(test.db, existing.email)).map((email) => email.template)).toEqual([
      'customer_sign_up_attempt',
    ]);
    // The per-email code limit answers both the same way too: 1 a minute (rule C5).
    expect((await signUp(existing.email)).status).toBe(429);
    expect((await emailsTo(test.db, existing.email)).length).toBe(1);
  });

  it('needs a solved ALTCHA, a valid form and an uncommon password', async () => {
    const email = uniqueEmail('form');
    expect(
      await body(await client.post('/api/auth/sign-up/email', { body: signUpBody(email) })),
    ).toMatchObject({ status: 400, code: 'ALTCHA_REQUIRED' });
    const post = async (overrides: object) =>
      body(
        await client.post('/api/auth/sign-up/email', {
          body: { ...signUpBody(email), ...overrides },
          headers: await client.altcha(),
        }),
      );
    expect(await post({ phone: '123' })).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    expect(await post({ password: 'Password1' })).toMatchObject({
      status: 400,
      code: 'PASSWORD_TOO_COMMON',
    });
    expect(await post({ password: email })).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
    expect(await emailsTo(test.db, email)).toEqual([]);
  });

  it('answers REGISTRATION_CLOSED while registration is closed, and says so to the store', async () => {
    expect(await (await client.get('/api/auth/registration')).json()).toEqual({ open: true });
    process.env.REGISTRATION_OPEN = 'false';
    const closed = await startApp();
    process.env.REGISTRATION_OPEN = 'true';
    try {
      const closedClient = api(closed.url);
      expect(await (await closedClient.get('/api/auth/registration')).json()).toEqual({
        open: false,
      });
      const email = uniqueEmail('closed');
      const response = await closedClient.post('/api/auth/sign-up/email', {
        body: signUpBody(email),
        headers: await closedClient.altcha(),
      });
      expect(await body(response)).toMatchObject({ status: 403, code: 'REGISTRATION_CLOSED' });
      expect(await emailsTo(test.db, email)).toEqual([]);
    } finally {
      await closed.app.close();
    }
  });
});

describe('email verification (rules C4, C7, C10)', () => {
  it('refuses a wrong code, then signs in with the right one, without a sign-in email', async () => {
    const email = uniqueEmail('verify');
    await signUp(email);
    const id = await idOf(email);
    const code = await lastCode(test.db, email);
    const wrong = code === '000000' ? '111111' : '000000';
    expect(await body(await verify(email, wrong))).toMatchObject({
      status: 400,
      code: 'INVALID_OTP',
    });
    const verified = await verify(email, code);
    expect(verified.status).toBe(200);
    const cookie = cookieHeader(verified);
    expect(cookie).toMatch(/vd\.session_token=/);
    expect(await body(await client.get('/api/account', { cookie }))).toMatchObject({
      status: 200,
      id,
      email,
      phone: '+963944123456',
    });
    expect((await auditOf(test.db, id)).map((entry) => entry.action)).toEqual([
      'customer.signed_up',
      'customer.email_verified',
    ]);
    // One session, and the only email is the code: no "new sign-in" for this one (rule C10).
    expect(
      await test.db.select().from(customerSessions).where(eq(customerSessions.userId, id)),
    ).toHaveLength(1);
    expect((await emailsTo(test.db, email)).map((row) => row.template)).toEqual([
      'customer_verify_email',
    ]);
    // A used code is gone.
    expect((await verify(email, code)).status).toBe(400);
  });

  it('voids a code after five wrong tries, even when the sixth is right', async () => {
    const email = uniqueEmail('attempts');
    await signUp(email);
    await idOf(email);
    const code = await lastCode(test.db, email);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await body(await verify(email, wrong))).toMatchObject({ code: 'INVALID_OTP' });
    }
    expect(await body(await verify(email, code))).toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });
    expect(await body(await verify(email, code))).toMatchObject({ code: 'INVALID_OTP' });
  });

  it('replaces the previous code when a new one is sent', async () => {
    const customer = await seedCustomer(test.db, { emailVerified: false });
    seeded.push(customer.id);
    const send = async () =>
      client.post('/api/auth/email-otp/send-verification-otp', {
        body: { email: customer.email },
        headers: await client.altcha(),
      });
    expect(await body(await send())).toEqual({ status: 200, success: true });
    const first = await lastCode(test.db, customer.email);
    // The next send is over the per-email limit of one a minute (rule C5).
    expect(await body(await send())).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    // Moves the minute window back, as if a minute passed.
    await test.db.execute(
      sql.raw(
        `update customer_rate_limits set last_request = last_request - 61000 where key like 'code-email-minute:${customer.email}'`,
      ),
    );
    expect((await send()).status).toBe(200);
    const second = await lastCode(test.db, customer.email);
    if (first !== second) {
      expect(await body(await verify(customer.email, first))).toMatchObject({
        code: 'INVALID_OTP',
      });
    }
    expect((await verify(customer.email, second)).status).toBe(200);
  });

  it('answers a code request the same for unknown, verified and unverified emails', async () => {
    const verified = await seedCustomer(test.db);
    seeded.push(verified.id);
    const answers = await Promise.all(
      [uniqueEmail('nobody'), verified.email].map(async (email) =>
        body(
          await client.post('/api/auth/email-otp/send-verification-otp', {
            body: { email },
            headers: await client.altcha(),
          }),
        ),
      ),
    );
    expect(answers).toEqual([
      { status: 200, success: true },
      { status: 200, success: true },
    ]);
    expect(await emailsTo(test.db, verified.email)).toEqual([]);
  });

  it('counts code sends in PostgreSQL, so the limits survive a restart', async () => {
    const customer = await seedCustomer(test.db, { emailVerified: false });
    seeded.push(customer.id);
    const send = async (target: ReturnType<typeof api>) =>
      target.post('/api/auth/email-otp/send-verification-otp', {
        body: { email: customer.email },
        headers: await target.altcha(),
      });
    expect((await send(client)).status).toBe(200);
    const restarted = await startApp();
    try {
      expect((await send(api(restarted.url))).status).toBe(429);
    } finally {
      await restarted.app.close();
    }
  });

  it('limits code sends per address: 20 an hour', async () => {
    const ip = clientIp();
    // 19 sends from this address earlier in the hour (the route also allows 10 a minute).
    await test.db
      .insert(customerRateLimits)
      .values({ key: `code-ip-hour:${ip}`, count: 19, lastRequest: Date.now() });
    const send = async () =>
      client.post('/api/auth/email-otp/request-password-reset', {
        body: { email: uniqueEmail('per-ip') },
        headers: await client.altcha(),
        ip,
      });
    expect((await send()).status).toBe(200);
    expect(await body(await send())).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
  });
});

describe('sign-in (rules C8, C10, C15)', () => {
  it('sends the new sign-in email with the device and address', async () => {
    const customer = await seedCustomer(test.db);
    seeded.push(customer.id);
    await client.post('/api/auth/sign-in/email', {
      body: { email: customer.email, password: PASSWORD },
      ip: '10.9.8.7',
      headers: {
        'user-agent':
          'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36',
      },
    });
    expect(await emailsTo(test.db, customer.email)).toMatchObject([
      {
        template: 'customer_new_sign_in',
        priority: 'normal',
        params: { browser: 'Chrome', system: 'Android', ipAddress: '10.9.8.7' },
      },
    ]);
  });

  it('asks for ALTCHA after three failures for one email, from any address', async () => {
    const customer = await seedCustomer(test.db);
    seeded.push(customer.id);
    const signIn = (password: string, headers?: Record<string, string>) =>
      client.post('/api/auth/sign-in/email', {
        body: { email: customer.email, password },
        ...(headers && { headers }),
      });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await body(await signIn('wrong-password-123'))).toMatchObject({
        status: 401,
        code: 'INVALID_EMAIL_OR_PASSWORD',
      });
    }
    expect(await body(await signIn(PASSWORD))).toMatchObject({
      status: 400,
      code: 'ALTCHA_REQUIRED',
    });
    expect((await signIn(PASSWORD, await client.altcha())).status).toBe(200);
  });

  it('sends a new code to an unverified customer who signs in', async () => {
    const customer = await seedCustomer(test.db, { emailVerified: false });
    seeded.push(customer.id);
    const response = await client.post('/api/auth/sign-in/email', {
      body: { email: customer.email, password: PASSWORD },
    });
    expect(await body(response)).toMatchObject({ status: 403, code: 'EMAIL_NOT_VERIFIED' });
    expect((await emailsTo(test.db, customer.email)).map((row) => row.template)).toEqual([
      'customer_verify_email',
    ]);
  });
});

describe('forgot password (rule C7)', () => {
  it('answers the same for unknown emails, then resets, verifies and signs out everywhere', async () => {
    const customer = await seedCustomer(test.db, { emailVerified: false });
    seeded.push(customer.id);
    const request = async (email: string) =>
      body(
        await client.post('/api/auth/email-otp/request-password-reset', {
          body: { email },
          headers: await client.altcha(),
        }),
      );
    expect(await request(uniqueEmail('nobody'))).toEqual(await request(customer.email));
    const code = await lastCode(test.db, customer.email);
    const reset = (password: string, otp = code) =>
      client.post('/api/auth/email-otp/reset-password', {
        body: { email: customer.email, otp, password },
      });
    expect(await body(await reset('Password1'))).toMatchObject({
      status: 400,
      code: 'PASSWORD_TOO_COMMON',
    });
    expect(await body(await reset(NEW_PASSWORD))).toEqual({ status: 200, success: true });
    expect((await reset(NEW_PASSWORD)).status).toBe(400);

    const [after] = await test.db.select().from(customers).where(eq(customers.id, customer.id));
    expect(after?.emailVerified).toBe(true);
    expect((await auditOf(test.db, customer.id)).map((entry) => entry.action)).toEqual([
      'customer.email_verified',
      'customer.password_reset',
    ]);
    expect((await emailsTo(test.db, customer.email)).map((row) => row.template)).toEqual([
      'customer_reset_password',
      'customer_password_changed',
    ]);
    // No sign-in by the reset: the customer signs in with the new password.
    const signIn = await client.post('/api/auth/sign-in/email', {
      body: { email: customer.email, password: NEW_PASSWORD },
    });
    expect(signIn.status).toBe(200);
  });
});

describe('the account (rules C11–C14)', () => {
  it('changes the password with the current one and signs out the other sessions', async () => {
    const customer = await seedCustomer(test.db);
    seeded.push(customer.id);
    const here = await client.signInCustomer(customer.email);
    const elsewhere = await client.signInCustomer(customer.email);
    const change = (currentPassword: string, newPassword: string) =>
      client.post('/api/auth/change-password', {
        cookie: here,
        body: { currentPassword, newPassword },
      });
    expect(await body(await change('wrong-password', NEW_PASSWORD))).toMatchObject({
      status: 400,
      code: 'INVALID_PASSWORD',
    });
    expect(await body(await change(PASSWORD, NEW_PASSWORD))).toEqual({
      status: 200,
      success: true,
    });
    expect((await client.get('/api/account', { cookie: here })).status).toBe(200);
    expect((await client.get('/api/account', { cookie: elsewhere })).status).toBe(401);
    const audit = await auditOf(test.db, customer.id);
    expect(audit.at(-1)).toMatchObject({
      action: 'customer.password_changed',
      details: { count: 1 },
    });
    expect((await emailsTo(test.db, customer.email)).map((row) => row.template)).toContain(
      'customer_password_changed',
    );
  });

  it('edits name and phone, audited with before and after', async () => {
    const customer = await seedCustomer(test.db);
    seeded.push(customer.id);
    const cookie = await client.signInCustomer(customer.email);
    const updated = await client.patch('/api/account', {
      cookie,
      body: { name: 'سارة', phone: '+963 933 222 111' },
    });
    expect(await body(updated)).toMatchObject({
      status: 200,
      name: 'سارة',
      phone: '+963933222111',
    });
    expect(
      await body(await client.patch('/api/account', { cookie, body: { phone: 'x' } })),
    ).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    expect((await auditOf(test.db, customer.id)).at(-1)).toMatchObject({
      action: 'customer.profile_updated',
      actorKind: 'customer',
      channel: 'store',
      details: {
        before: { name: 'عميل اختبار', phone: '+963944123456' },
        after: { name: 'سارة', phone: '+963933222111' },
      },
    });
  });

  it('changes the email with a code to the new address and tells the old one', async () => {
    const { id, email, cookie } = await signedUp('change');
    const other = await client.signInCustomer(email).catch(() => null);
    const newEmail = uniqueEmail('changed');
    const request = async (password: string) =>
      client.post('/api/auth/email-otp/request-email-change', {
        cookie,
        body: { newEmail, password },
        headers: await client.altcha(),
      });
    expect(await body(await request('wrong-password'))).toMatchObject({
      code: 'INVALID_PASSWORD',
    });
    expect(await body(await request(PASSWORD))).toEqual({ status: 200, success: true });
    const code = await lastCode(test.db, newEmail);
    const confirmed = await client.post('/api/auth/email-otp/change-email', {
      cookie,
      body: { newEmail, otp: code },
    });
    expect(await body(confirmed)).toEqual({ status: 200, success: true });
    expect(await body(await client.get('/api/account', { cookie }))).toMatchObject({
      email: newEmail,
    });
    if (other) expect((await client.get('/api/account', { cookie: other })).status).toBe(401);
    expect((await auditOf(test.db, id)).at(-1)).toMatchObject({
      action: 'customer.email_changed',
      details: { before: { email }, after: { email: newEmail } },
    });
    expect((await emailsTo(test.db, email)).map((row) => row.template)).toContain(
      'customer_email_changed',
    );
  });

  it('answers an email change to a taken address the same, with a notice instead of a code', async () => {
    const { cookie } = await signedUp('taker');
    const owner = await seedCustomer(test.db);
    seeded.push(owner.id);
    const response = await client.post('/api/auth/email-otp/request-email-change', {
      cookie,
      body: { newEmail: owner.email, password: PASSWORD },
      headers: await client.altcha(),
    });
    expect(await body(response)).toEqual({ status: 200, success: true });
    expect((await emailsTo(test.db, owner.email)).map((row) => row.template)).toEqual([
      'customer_sign_up_attempt',
    ]);
  });

  it('lets one of two concurrent confirmations to the same address win', async () => {
    const [first, second] = await Promise.all([signedUp('race-a'), signedUp('race-b')]);
    const target = uniqueEmail('contested');
    for (const holder of [first, second]) {
      // A minute between the two code sends to the target address (rule C5).
      await test.db.execute(
        sql.raw(`delete from customer_rate_limits where key like '%${target}'`),
      );
      await client.post('/api/auth/email-otp/request-email-change', {
        cookie: holder.cookie,
        body: { newEmail: target, password: PASSWORD },
        headers: await client.altcha(),
      });
    }
    const emails = await emailsTo(test.db, target);
    const codeOf = (customerId: string) =>
      (emails.find((row) => row.customerId === customerId)?.params as { code: string } | undefined)
        ?.code ?? '';
    const results = await Promise.all(
      [first, second].map((holder) =>
        client.post('/api/auth/email-otp/change-email', {
          cookie: holder.cookie,
          body: { newEmail: target, otp: codeOf(holder.id) },
        }),
      ),
    );
    const statuses = results.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 409]);
    const loser = results.find((response) => response.status === 409) as Response;
    expect(await loser.json()).toMatchObject({ code: 'EMAIL_TAKEN' });
    const owners = await test.db.select().from(customers).where(eq(customers.email, target));
    expect(owners).toHaveLength(1);
  });

  it('signs out one own session by token; another customer’s token answers 404', async () => {
    const customer = await seedCustomer(test.db);
    const stranger = await seedCustomer(test.db);
    seeded.push(customer.id, stranger.id);
    const here = await client.signInCustomer(customer.email);
    const elsewhere = await client.signInCustomer(customer.email);
    await client.signInCustomer(stranger.email);
    const sessions = (await (
      await client.get('/api/auth/list-sessions', { cookie: here })
    ).json()) as { token: string; id: string }[];
    expect(sessions).toHaveLength(2);
    const [strangerSession] = await test.db
      .select()
      .from(customerSessions)
      .where(eq(customerSessions.userId, stranger.id));
    expect(
      await body(
        await client.post('/api/auth/revoke-session', {
          cookie: here,
          body: { token: strangerSession?.token },
        }),
      ),
    ).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    const elsewhereToken = sessions.find((session) => elsewhere.includes(session.token));
    expect(elsewhereToken).toBeDefined();
    expect(
      (
        await client.post('/api/auth/revoke-session', {
          cookie: here,
          body: { token: elsewhereToken?.token },
        })
      ).status,
    ).toBe(200);
    expect((await client.get('/api/account', { cookie: elsewhere })).status).toBe(401);
    expect((await client.get('/api/account', { cookie: here })).status).toBe(200);
  });

  it('signs out everywhere, this session included', async () => {
    const customer = await seedCustomer(test.db);
    seeded.push(customer.id);
    const here = await client.signInCustomer(customer.email);
    const elsewhere = await client.signInCustomer(customer.email);
    expect((await client.post('/api/auth/revoke-sessions', { cookie: here })).status).toBe(200);
    for (const cookie of [here, elsewhere]) {
      expect((await client.get('/api/account', { cookie })).status).toBe(401);
    }
    expect((await auditOf(test.db, customer.id)).at(-1)).toMatchObject({
      action: 'customer.sessions_revoked',
      details: { count: 2 },
    });
  });

  it('refuses every account route without a customer session, and with an admin one', async () => {
    const admin = await client.adminWithTotp(test.db);
    seeded.push(admin.id);
    for (const cookie of [undefined, admin.cookie]) {
      expect((await client.get('/api/account', { cookie })).status).toBe(401);
      expect((await client.post('/api/auth/revoke-sessions', { cookie })).status).toBe(401);
      expect(
        (
          await client.post('/api/auth/change-password', {
            cookie,
            body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
          })
        ).status,
      ).toBe(401);
    }
  });
});

describe('code checks tell nothing about accounts (rules C2, C12)', () => {
  const wrongTries = async (send: () => Promise<Response>) => {
    const codes: unknown[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) codes.push((await body(await send())).code);
    return codes;
  };
  const expected = [...Array(5).fill('INVALID_OTP'), 'TOO_MANY_ATTEMPTS'];

  it('answers wrong reset codes the same for known and unknown emails', async () => {
    const known = await seedCustomer(test.db);
    seeded.push(known.id);
    const unknown = uniqueEmail('ghost');
    for (const email of [known.email, unknown]) {
      await client.post('/api/auth/email-otp/request-password-reset', {
        body: { email },
        headers: await client.altcha(),
      });
      const tries = await wrongTries(() =>
        client.post('/api/auth/email-otp/reset-password', {
          body: { email, otp: '999999', password: NEW_PASSWORD },
        }),
      );
      expect(tries, email).toEqual(expected);
    }
  });

  it('answers wrong verification codes the same after a sign-up with a taken or a new email', async () => {
    const taken = await seedCustomer(test.db);
    seeded.push(taken.id);
    const fresh = uniqueEmail('fresh-verify');
    for (const email of [taken.email, fresh]) {
      await signUp(email);
      const tries = await wrongTries(() => verify(email, '999999'));
      // A real code of 999999 is possible: one in a million, and the test would show it.
      expect(tries, email).toEqual(expected);
    }
    await idOf(fresh);
  });

  it('answers wrong email-change codes the same for a taken and a free address', async () => {
    const { cookie } = await signedUp('mover');
    const owner = await seedCustomer(test.db);
    seeded.push(owner.id);
    for (const newEmail of [owner.email, uniqueEmail('free')]) {
      await client.post('/api/auth/email-otp/request-email-change', {
        cookie,
        body: { newEmail, password: PASSWORD },
        headers: await client.altcha(),
      });
      const tries = await wrongTries(() =>
        client.post('/api/auth/email-otp/change-email', {
          cookie,
          body: { newEmail, otp: '999999' },
        }),
      );
      expect(tries, newEmail).toEqual(expected);
    }
  });

  it('voids the code for an earlier address when a change to another one is asked', async () => {
    const { cookie } = await signedUp('second-thoughts');
    const first = uniqueEmail('first-choice');
    const second = uniqueEmail('second-choice');
    for (const newEmail of [first, second]) {
      await client.post('/api/auth/email-otp/request-email-change', {
        cookie,
        body: { newEmail, password: PASSWORD },
        headers: await client.altcha(),
      });
    }
    const confirm = (newEmail: string, otp: string) =>
      client.post('/api/auth/email-otp/change-email', { cookie, body: { newEmail, otp } });
    expect(await body(await confirm(first, await lastCode(test.db, first)))).toMatchObject({
      code: 'INVALID_OTP',
    });
    expect((await confirm(second, await lastCode(test.db, second))).status).toBe(200);
  });
});
