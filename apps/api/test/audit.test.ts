import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, removeAccounts, seedCustomer } from './helpers.js';
import { startApp, type TestApp } from './start-app.js';

/* The audit log screen's API (S01 rule A4): newest first, filters, a cursor, the actors' names. */

let test: TestApp;
let client: ReturnType<typeof api>;
let admin: Awaited<ReturnType<ReturnType<typeof api>['adminWithTotp']>>;
const seeded: string[] = [];

interface Page {
  items: {
    action: string;
    actorKind: string;
    actorName: string | null;
    entityId: string;
    details: Record<string, unknown>;
  }[];
  nextCursor: string | null;
}

const list = async (query: string, cookie = admin.cookie) =>
  (await (await client.get(`/api/admin/audit?${query}`, { cookie })).json()) as Page;

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

describe('the audit log', () => {
  it('filters by customer, action and entity, newest first, with names and a cursor', async () => {
    const customer = await seedCustomer(test.db);
    seeded.push(customer.id);
    const cookie = await client.signInCustomer(customer.email);
    for (const name of ['الأول', 'الثاني', 'الثالث']) {
      await client.patch('/api/account', { cookie, body: { name } });
    }

    const byCustomer = await list(`actorKind=customer&actorId=${customer.id}&limit=2`);
    expect(byCustomer.items.map((entry) => entry.details.after)).toEqual([
      { name: 'الثالث' },
      { name: 'الثاني' },
    ]);
    expect(byCustomer.items[0]).toMatchObject({ actorKind: 'customer', actorName: 'الثالث' });
    const rest = await list(
      `actorKind=customer&actorId=${customer.id}&limit=2&cursor=${byCustomer.nextCursor}`,
    );
    expect(rest.items.map((entry) => entry.details.after)).toEqual([{ name: 'الأول' }]);
    expect(rest.nextCursor).toBeNull();

    const byEntity = await list(
      `entityType=customer&entityId=${customer.id}&action=customer.profile_updated`,
    );
    expect(byEntity.items).toHaveLength(3);
    expect(await list(`entityId=${customer.id}&action=customer.signed_up`)).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(await list(`entityId=${customer.id}&from=2999-01-01T00:00:00Z`)).toMatchObject({
      items: [],
    });
  });

  it('names the admin on the admin’s own entries', async () => {
    const page = await list(`actorKind=admin&actorId=${admin.id}`);
    expect(page.items[0]).toMatchObject({ actorKind: 'admin', actorName: 'مدير اختبار' });
  });

  it('refuses bad filters, a bad cursor, no session and a customer session', async () => {
    expect(
      (await client.get('/api/admin/audit?action=nope', { cookie: admin.cookie })).status,
    ).toBe(400);
    expect((await client.get('/api/admin/audit?cursor=xyz', { cookie: admin.cookie })).status).toBe(
      400,
    );
    const customer = await seedCustomer(test.db);
    seeded.push(customer.id);
    const customerCookie = await client.signInCustomer(customer.email);
    for (const cookie of [undefined, customerCookie]) {
      expect((await client.get('/api/admin/audit', { cookie })).status).toBe(401);
    }
  });
});
