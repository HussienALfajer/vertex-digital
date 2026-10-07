import { customers } from '@vertex-digital/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  api,
  auditOf,
  body,
  emailsTo,
  removeAccounts,
  seedCustomer,
  uniqueEmail,
} from './helpers.js';
import { startApp, type TestApp } from './start-app.js';

/* Test customers (S01 rules T1–T4): created and reset by the admin, passwords shown once. */

let test: TestApp;
let client: ReturnType<typeof api>;
let admin: Awaited<ReturnType<ReturnType<typeof api>['adminWithTotp']>>;
const seeded: string[] = [];

beforeAll(async () => {
  test = await startApp();
  client = api(test.url);
  admin = await client.adminWithTotp(test.db);
  seeded.push(admin.id);
});

afterAll(async () => {
  await removeAccounts(test.db, seeded);
  await test.app.close();
});

async function create(email: string) {
  return client.post('/api/admin/test-customers', {
    cookie: admin.cookie,
    body: { name: 'زبون تجريبي', email, phone: '0944 000 111' },
  });
}

describe('test customers', () => {
  it('are created verified and flagged, with a password shown once that signs in', async () => {
    const email = uniqueEmail('test-customer');
    const response = await create(email);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const created = (await response.json()) as { id: string; password: string };
    seeded.push(created.id);
    expect(created).toMatchObject({ email, phone: '+963944000111' });
    expect(created.password).toMatch(/^[\w-]{24}$/);
    const [row] = await test.db.select().from(customers).where(eq(customers.id, created.id));
    expect(row).toMatchObject({ emailVerified: true, isTest: true });
    const signIn = await client.post('/api/auth/sign-in/email', {
      body: { email, password: created.password },
    });
    expect(signIn.status).toBe(200);
    expect(await auditOf(test.db, created.id)).toMatchObject([
      {
        action: 'customer.test_created',
        actorKind: 'admin',
        actorId: admin.id,
        channel: 'admin',
      },
    ]);
    // No email for a test customer (rule T1); the sign-in above sends its own notice.
    expect((await emailsTo(test.db, email)).map((row) => row.template)).toEqual([
      'customer_new_sign_in',
    ]);
  });

  it('refuse an email any customer uses', async () => {
    const existing = await seedCustomer(test.db);
    seeded.push(existing.id);
    expect(await body(await create(existing.email))).toMatchObject({
      status: 409,
      code: 'EMAIL_TAKEN',
    });
  });

  it('are listed newest first, a page at a time', async () => {
    for (const label of ['page-a', 'page-b', 'page-c']) {
      const created = (await (await create(uniqueEmail(label))).json()) as { id: string };
      seeded.push(created.id);
    }
    const first = (await (
      await client.get('/api/admin/test-customers?limit=2', { cookie: admin.cookie })
    ).json()) as { items: { email: string }[]; nextCursor: string };
    expect(first.items).toHaveLength(2);
    expect(first.items[0]?.email).toMatch(/^page-c/);
    const second = (await (
      await client.get(`/api/admin/test-customers?limit=2&cursor=${first.nextCursor}`, {
        cookie: admin.cookie,
      })
    ).json()) as { items: { email: string }[] };
    expect(second.items[0]?.email).toMatch(/^page-a/);
  });

  it('get a new password from the admin, which signs them out; real customers answer 404', async () => {
    const email = uniqueEmail('reset');
    const created = (await (await create(email)).json()) as { id: string; password: string };
    seeded.push(created.id);
    const signIn = await client.post('/api/auth/sign-in/email', {
      body: { email, password: created.password },
    });
    const session = signIn.headers.getSetCookie()[0]?.split(';')[0] ?? '';
    const reset = await client.post(`/api/admin/test-customers/${created.id}/reset-password`, {
      cookie: admin.cookie,
    });
    expect(reset.headers.get('cache-control')).toBe('no-store');
    const { password } = (await reset.json()) as { password: string };
    expect(password).not.toBe(created.password);
    expect((await client.get('/api/account', { cookie: session })).status).toBe(401);
    expect(
      (await client.post('/api/auth/sign-in/email', { body: { email, password } })).status,
    ).toBe(200);
    expect((await auditOf(test.db, created.id)).at(-1)).toMatchObject({
      action: 'customer.test_password_reset',
      details: { count: 1 },
    });

    const real = await seedCustomer(test.db);
    seeded.push(real.id);
    expect(
      await body(
        await client.post(`/api/admin/test-customers/${real.id}/reset-password`, {
          cookie: admin.cookie,
        }),
      ),
    ).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('are refused without an admin session and with a customer session', async () => {
    const customer = await seedCustomer(test.db);
    seeded.push(customer.id);
    const customerCookie = await client.signInCustomer(customer.email);
    for (const cookie of [undefined, customerCookie]) {
      expect((await client.get('/api/admin/test-customers', { cookie })).status).toBe(401);
    }
  });
});
