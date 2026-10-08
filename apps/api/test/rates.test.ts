import { randomUUID } from 'node:crypto';
import { exchangeRates } from '@vertex-digital/db';
import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, auditOf, body, PASSWORD, removeAccounts, seedCustomer, totp } from './helpers.js';
import { startApp, type TestApp } from './start-app.js';

/*
 * Exchange rates (S03, F04) over HTTP against the test database. Rates are append-only, so they
 * stay; each test reads the rate in force before it changes it. The first rate ever (no
 * confirmation, rule FX2) is covered by the contracts unit test of `rateConfirmationError`.
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
  client.post('/api/admin/rates', { cookie, body: input });

/** Sets the rate whatever the one in force, typing it twice in case the change is above 5%. */
async function setRate(sypPerUsd: string, displayStepSypUnits = 500) {
  const response = await change({ sypPerUsd, displayStepSypUnits, rateConfirmation: sypPerUsd });
  expect(response.status).toBe(201);
  return (await response.json()) as Record<string, unknown>;
}

const overview = async (query = '') =>
  (await (await client.get(`/api/admin/rates${query}`, { cookie: admin.cookie })).json()) as {
    current: Record<string, unknown> | null;
    stale: boolean;
    history: { items: Record<string, unknown>[]; nextCursor: string | null };
  };

beforeAll(async () => {
  test = await startApp();
  client = api(test.url);
  await reauthenticatedAdmin();
});

afterAll(async () => {
  await removeAccounts(test.db, seeded);
  await test.app.close();
});

describe('access', () => {
  it('answers 401 without a session and to a customer session', async () => {
    const customer = await seedCustomer(test.db);
    seeded.push(customer.id);
    const cookie = await client.signInCustomer(customer.email);
    for (const options of [{}, { cookie }]) {
      expect((await client.get('/api/admin/rates', options)).status).toBe(401);
      expect(
        (
          await client.post('/api/admin/rates', {
            ...options,
            body: { sypPerUsd: '118', displayStepSypUnits: 500 },
          })
        ).status,
      ).toBe(401);
    }
  });

  it('needs a re-authentication to change the rate (rule FX1)', async () => {
    const fresh = await client.adminWithTotp(test.db);
    seeded.push(fresh.id);
    expect(
      await body(await change({ sypPerUsd: '118', displayStepSypUnits: 500 }, fresh.cookie)),
    ).toMatchObject({ status: 403, code: 'REAUTHENTICATION_REQUIRED' });
    // The fresh admin replaced the one of this file (there is only one): restore it.
    await reauthenticatedAdmin();
  });
});

describe('changing the rate (rules FX1–FX3)', () => {
  it('inserts a row with its audit entry, never editing the one before', async () => {
    const before = await setRate('118');
    const record = await setRate('118.5', 1000);
    expect(record).toEqual({
      id: expect.any(String),
      sypPerUsd: '118.5',
      displayStepSypUnits: 1000,
      changePercent: '0.43',
      adminName: expect.any(String),
      createdAt: expect.any(String),
    });
    const [kept] = await test.db
      .select({ sypPerUsd: exchangeRates.sypPerUsd })
      .from(exchangeRates)
      .where(eq(exchangeRates.id, before.id as string));
    expect(kept?.sypPerUsd).toBe('118.0000');
    expect(await auditOf(test.db, record.id as string)).toEqual([
      expect.objectContaining({
        action: 'exchange_rate.changed',
        actorKind: 'admin',
        actorId: admin.id,
        entityType: 'exchange_rate',
        reason: null,
        details: {
          rateId: record.id,
          before: { sypPerUsd: '118', displayStepSypUnits: 500 },
          after: { sypPerUsd: '118.5', displayStepSypUnits: 1000 },
          changePercent: '0.43',
        },
      }),
    ]);
  });

  it('asks for the rate typed twice above 5%, not at 5% (rule FX2)', async () => {
    await setRate('100');
    expect((await change({ sypPerUsd: '105', displayStepSypUnits: 500 })).status).toBe(201);
    expect(
      await body(await change({ sypPerUsd: '110.26', displayStepSypUnits: 500 })),
    ).toMatchObject({
      status: 400,
      code: 'RATE_CONFIRMATION_REQUIRED',
      details: { changePercent: '5.01' },
    });
    expect(
      await body(
        await change({ sypPerUsd: '1180', displayStepSypUnits: 500, rateConfirmation: '118' }),
      ),
    ).toMatchObject({ status: 400, code: 'RATE_CONFIRMATION_MISMATCH' });
    const accepted = await change({
      sypPerUsd: '1180',
      displayStepSypUnits: 500,
      rateConfirmation: '1180.00',
    });
    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toMatchObject({ sypPerUsd: '1180', changePercent: '1023.81' });
  });

  it('refuses an invalid rate or step', async () => {
    for (const input of [
      { sypPerUsd: '0', displayStepSypUnits: 500 },
      { sypPerUsd: '118.12345', displayStepSypUnits: 500 },
      { sypPerUsd: '118', displayStepSypUnits: 50 },
      { sypPerUsd: '118', displayStepSypUnits: 250 },
      { sypPerUsd: '118', displayStepSypUnits: 5100 },
    ]) {
      expect(await body(await change(input))).toMatchObject({
        status: 400,
        code: 'VALIDATION_FAILED',
      });
    }
  });

  it('serializes parallel changes, so each one compares with the rate it replaces', async () => {
    await setRate('200');
    // Each is within 5% of 200 but not of the other: the second to run must be refused.
    const results = await Promise.all([
      change({ sypPerUsd: '209', displayStepSypUnits: 500 }),
      change({ sypPerUsd: '191', displayStepSypUnits: 500 }),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([201, 400]);
  });

  it('keeps the last change in force when two parallel changes both pass', async () => {
    await setRate('300');
    const results = await Promise.all([
      change({ sypPerUsd: '301', displayStepSypUnits: 500 }),
      change({ sypPerUsd: '302', displayStepSypUnits: 500 }),
    ]);
    expect(results.map((response) => response.status)).toEqual([201, 201]);
    const records = (await Promise.all(results.map((response) => response.json()))) as {
      id: string;
      sypPerUsd: string;
    }[];
    // The change written second names the other as the rate it replaced: it is the one in force.
    const replaced = async (id: string) => {
      const [entry] = await auditOf(test.db, id);
      if (!entry) throw new Error(`No audit entry for rate ${id}`);
      return (entry.details as { before: { sypPerUsd: string } }).before.sypPerUsd;
    };
    const [first, other] = records as [(typeof records)[0], (typeof records)[0]];
    const second = (await replaced(first.id)) === other.sypPerUsd ? first : other;
    expect((await overview()).current).toMatchObject({ id: second?.id });
  });
});

// Staleness (rule FX7) needs the newest rate to be old, which a database of append-only rates
// cannot be made to show: `isRateStale` is unit-tested in the contracts.
describe('the rate overview', () => {
  it('shows the current rate, not stale, and pages the history newest first', async () => {
    await setRate('120');
    const latest = await setRate('121');
    const first = await overview('?limit=1');
    expect(first.current).toMatchObject({ id: latest.id, sypPerUsd: '121', changePercent: '0.84' });
    expect(first.stale).toBe(false);
    expect(first.history.items).toEqual([first.current]);
    const second = await overview(`?limit=1&cursor=${first.history.nextCursor}`);
    expect(second.current).toEqual(first.current);
    expect(second.history.items[0]).toMatchObject({ sypPerUsd: '120' });
    const [newest] = await test.db
      .select({ id: exchangeRates.id })
      .from(exchangeRates)
      .orderBy(desc(exchangeRates.createdAt))
      .limit(1);
    expect(newest?.id).toBe(latest.id);
  });

  it('answers no-store', async () => {
    const response = await client.get('/api/admin/rates', { cookie: admin.cookie });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('the wallet value in pounds (rule W9, FX8, FX9)', () => {
  it('follows the rate in force at once, rounded down to the step', async () => {
    const customer = await seedCustomer(test.db);
    seeded.push(customer.id);
    const cookie = await client.signInCustomer(customer.email);
    const credited = await client.post(`/api/admin/wallets/${customer.id}/adjustments`, {
      cookie: admin.cookie,
      body: {
        direction: 'credit',
        amountUnits: 10_300_000,
        category: 'compensation',
        reason: 'Test adjustment',
      },
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(credited.status).toBe(201);
    await setRate('118.5', 500);
    // $10.30 × 118.5 = 1,220.55 SYP, shown as 1,220 (a 5-pound step, rounded down).
    expect(await (await client.get('/api/wallet', { cookie })).json()).toEqual({
      balanceUnits: 10_300_000,
      syp: { valueUnits: 122_000, rate: '118.5' },
    });
    await setRate('130', 100);
    expect(
      await (
        await client.get(`/api/admin/wallets/${customer.id}`, { cookie: admin.cookie })
      ).json(),
    ).toMatchObject({ syp: { valueUnits: 133_900, rate: '130' } });
  });
});
