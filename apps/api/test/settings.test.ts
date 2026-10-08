import { auditEntries, storeSwitchChanges } from '@vertex-digital/db';
import { and, desc, eq, gt } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  api,
  auditOf,
  body,
  PASSWORD,
  removeAccounts,
  seedCustomer,
  setSwitches,
  totp,
} from './helpers.js';
import { startApp, type TestApp } from './start-app.js';

/*
 * Store switches (S05 F26, rules SW1–SW3, SW8, SW9) over HTTP against the test database. Switch
 * rows are append-only and stay: each test sets the switches it reads, and the file leaves them at
 * their defaults.
 */

let test: TestApp;
let client: ReturnType<typeof api>;
let admin: Awaited<ReturnType<ReturnType<typeof api>['adminWithTotp']>>;
const seeded: string[] = [];

async function reauthenticatedAdmin() {
  admin = await client.adminWithTotp(test.db);
  seeded.push(admin.id);
  const reauthenticated = await client.post('/api/admin/me/reauthenticate', {
    cookie: admin.cookie,
    body: { password: PASSWORD, totpCode: totp(admin.secret) },
  });
  expect(reauthenticated.status).toBe(200);
}

const change = (input: Record<string, unknown>, cookie = admin.cookie) =>
  client.post('/api/admin/switches', { cookie, body: input });

interface SwitchView {
  switch: string;
  value: boolean;
  default: boolean;
  since: string | null;
  channel: string | null;
}

const switchOf = (payload: Record<string, unknown>, name: string) =>
  (payload.switches as SwitchView[]).find((item) => item.switch === name);

beforeAll(async () => {
  test = await startApp();
  client = api(test.url);
  await setSwitches(test.db);
  await reauthenticatedAdmin();
});

afterAll(async () => {
  await setSwitches(test.db);
  await removeAccounts(test.db, seeded);
  await test.app.close();
});

describe('access', () => {
  it('answers 401 without a session and to a customer session', async () => {
    const customer = await seedCustomer(test.db);
    seeded.push(customer.id);
    const cookie = await client.signInCustomer(customer.email);
    for (const options of [{}, { cookie }]) {
      expect((await client.get('/api/admin/switches', options)).status).toBe(401);
      expect((await client.get('/api/admin/switches/history', options)).status).toBe(401);
      expect(
        (
          await client.post('/api/admin/switches', {
            ...options,
            body: { switch: 'deposits_stopped', value: true },
          })
        ).status,
      ).toBe(401);
    }
  });

  it('needs a re-authentication to change a switch, in both directions (rule SW3)', async () => {
    const fresh = await client.adminWithTotp(test.db);
    seeded.push(fresh.id);
    for (const value of [true, false]) {
      expect(
        await body(await change({ switch: 'deposits_stopped', value }, fresh.cookie)),
      ).toMatchObject({ status: 403, code: 'REAUTHENTICATION_REQUIRED' });
    }
    // The fresh admin replaced the one of this file (there is only one): restore it.
    await reauthenticatedAdmin();
  });

  it('refuses an unknown switch or a value that is not a boolean', async () => {
    for (const input of [
      { switch: 'supplier_paused', value: true },
      { switch: 'deposits_stopped', value: 'yes' },
      { switch: 'deposits_stopped' },
    ]) {
      expect(await body(await change(input))).toMatchObject({
        status: 400,
        code: 'VALIDATION_FAILED',
      });
    }
  });
});

describe('the public store status (rules SW8, SW9)', () => {
  it('answers without a session, cached for 10 seconds', async () => {
    await setSwitches(test.db, { registration_open: true, deposits_stopped: true });
    const response = await client.get('/api/store/status');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=10');
    expect(await response.json()).toEqual({
      registrationOpen: true,
      purchasesStopped: false,
      depositsStopped: true,
    });
    await setSwitches(test.db);
    expect(await (await client.get('/api/store/status')).json()).toEqual({
      registrationOpen: false,
      purchasesStopped: false,
      depositsStopped: false,
    });
  });

  it('reads the registration switch for sign-up (rule SW8)', async () => {
    await setSwitches(test.db, { registration_open: true });
    expect(await (await client.get('/api/auth/registration')).json()).toEqual({ open: true });
    await setSwitches(test.db);
    expect(await (await client.get('/api/auth/registration')).json()).toEqual({ open: false });
  });
});

describe('changing a switch (rules SW1, SW2)', () => {
  it('lists every switch with its default, no-store', async () => {
    const response = await client.get('/api/admin/switches', { cookie: admin.cookie });
    expect(response.headers.get('cache-control')).toBe('no-store');
    const payload = (await response.json()) as { switches: SwitchView[] };
    expect(payload.switches.map((item) => item.switch)).toEqual([
      'registration_open',
      'purchases_stopped',
      'deposits_stopped',
      'sham_cash_paused',
      'usdt_trc20_paused',
      'usdt_bep20_paused',
    ]);
    expect(payload.switches.every((item) => item.value === false && item.default === false)).toBe(
      true,
    );
  });

  it('writes a row and its audit entry, and answers the new state', async () => {
    const response = await change({ switch: 'purchases_stopped', value: true });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const payload = (await response.json()) as Record<string, unknown>;
    expect(switchOf(payload, 'purchases_stopped')).toEqual({
      switch: 'purchases_stopped',
      value: true,
      default: false,
      since: expect.any(String),
      channel: 'admin',
    });
    const [row] = await test.db
      .select()
      .from(storeSwitchChanges)
      .orderBy(desc(storeSwitchChanges.createdAt))
      .limit(1);
    expect(row).toMatchObject({
      switch: 'purchases_stopped',
      value: true,
      adminId: admin.id,
      channel: 'admin',
    });
    expect(await auditOf(test.db, row?.id as string)).toEqual([
      expect.objectContaining({
        action: 'store_switch.changed',
        actorKind: 'admin',
        actorId: admin.id,
        channel: 'admin',
        entityType: 'store_switch',
        details: { switch: 'purchases_stopped', before: false, after: true },
      }),
    ]);
    expect(await (await client.get('/api/store/status')).json()).toMatchObject({
      purchasesStopped: true,
    });
    await change({ switch: 'purchases_stopped', value: false });
  });

  it('writes nothing when the value is already the current one', async () => {
    const since = new Date();
    const response = await change({ switch: 'sham_cash_paused', value: false });
    expect(response.status).toBe(200);
    expect(
      switchOf((await response.json()) as Record<string, unknown>, 'sham_cash_paused'),
    ).toEqual(expect.objectContaining({ value: false }));
    const rows = await test.db
      .select()
      .from(storeSwitchChanges)
      .where(
        and(
          eq(storeSwitchChanges.switch, 'sham_cash_paused'),
          gt(storeSwitchChanges.createdAt, since),
        ),
      );
    expect(rows).toEqual([]);
    const audits = await test.db
      .select()
      .from(auditEntries)
      .where(
        and(eq(auditEntries.action, 'store_switch.changed'), gt(auditEntries.occurredAt, since)),
      );
    expect(audits).toEqual([]);
  });

  it('serializes parallel changes: the history alternates and ends at the last value', async () => {
    const since = new Date();
    const values = [true, false, true, false, true, false, true, false];
    const responses = await Promise.all(
      values.map((value) => change({ switch: 'usdt_bep20_paused', value })),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    const rows = await test.db
      .select()
      .from(storeSwitchChanges)
      .where(
        and(
          eq(storeSwitchChanges.switch, 'usdt_bep20_paused'),
          gt(storeSwitchChanges.createdAt, since),
        ),
      )
      .orderBy(storeSwitchChanges.createdAt);
    // Each row differs from the one before it: no change was decided on a stale value.
    rows.forEach((row, index) => {
      expect(row.value).toBe(index % 2 === 0);
    });
    const current = switchOf(
      (await (await client.get('/api/admin/switches', { cookie: admin.cookie })).json()) as Record<
        string,
        unknown
      >,
      'usdt_bep20_paused',
    );
    expect(current?.value).toBe(rows.at(-1)?.value ?? false);
    const audits = await test.db
      .select()
      .from(auditEntries)
      .where(
        and(eq(auditEntries.action, 'store_switch.changed'), gt(auditEntries.occurredAt, since)),
      );
    expect(audits).toHaveLength(rows.length);
    await setSwitches(test.db);
  });
});

describe('the history', () => {
  it('lists changes newest first, filtered by switch and paged by cursor', async () => {
    await change({ switch: 'usdt_trc20_paused', value: true });
    await change({ switch: 'usdt_trc20_paused', value: false });
    await change({ switch: 'registration_open', value: true });
    await change({ switch: 'registration_open', value: false });

    const response = await client.get(
      '/api/admin/switches/history?switch=usdt_trc20_paused&limit=1',
      {
        cookie: admin.cookie,
      },
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    const first = (await response.json()) as {
      items: Record<string, unknown>[];
      nextCursor: string | null;
    };
    expect(first.items).toEqual([
      {
        id: expect.any(String),
        switch: 'usdt_trc20_paused',
        value: false,
        channel: 'admin',
        createdAt: expect.any(String),
      },
    ]);
    expect(first.nextCursor).not.toBeNull();
    const second = (await (
      await client.get(
        `/api/admin/switches/history?switch=usdt_trc20_paused&limit=1&cursor=${first.nextCursor}`,
        { cookie: admin.cookie },
      )
    ).json()) as { items: Record<string, unknown>[] };
    expect(second.items).toEqual([expect.objectContaining({ value: true })]);

    const all = (await (
      await client.get('/api/admin/switches/history?limit=2', { cookie: admin.cookie })
    ).json()) as { items: Record<string, unknown>[] };
    expect(all.items.map((item) => [item.switch, item.value])).toEqual([
      ['registration_open', false],
      ['registration_open', true],
    ]);
  });

  it('refuses an unknown switch filter or a bad cursor', async () => {
    for (const query of ['switch=other', 'cursor=bad']) {
      expect(
        await body(
          await client.get(`/api/admin/switches/history?${query}`, { cookie: admin.cookie }),
        ),
      ).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    }
  });
});
