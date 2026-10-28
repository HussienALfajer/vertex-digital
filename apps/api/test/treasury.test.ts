import { randomUUID } from 'node:crypto';
import { CURRENCY_SCALE, TREASURY_ACCOUNTS } from '@vertex-digital/contracts';
import { reverseMovement } from '@vertex-digital/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, auditOf, body, PASSWORD, removeAccounts, seedCustomer, totp } from './helpers.js';
import { startApp, type TestApp } from './start-app.js';

/*
 * Treasury movements (S13 rules T2–T9) over HTTP. Places are shared accounts: every movement a
 * test commits is reversed in `afterAll`, which leaves each place as if it never had one (rule T6,
 * edge case 12), so the next run can record openings again.
 */

const USD = CURRENCY_SCALE.USD;

let test: TestApp;
let client: ReturnType<typeof api>;
let admin: Awaited<ReturnType<ReturnType<typeof api>['adminWithTotp']>>;
const seeded: string[] = [];
const written: string[] = [];

const post = (path: string, payload: Record<string, unknown>, key: string = randomUUID()) =>
  client.post(path, { cookie: admin.cookie, body: payload, headers: { 'idempotency-key': key } });

const movement = (payload: Record<string, unknown>, key?: string) =>
  post('/api/admin/treasury/movements', { reason: 'Treasury test', ...payload }, key);

/** Records a movement, keeps its id for the clean-up, and answers its body. */
async function recorded(payload: Record<string, unknown>, key?: string) {
  const response = await movement(payload, key);
  const result = await body(response);
  if (typeof result.id === 'string' && result.reversesMovementId === null) written.push(result.id);
  return result;
}

/** Reverses what a crashed earlier run left standing on a place, as `afterAll` would have. */
async function clearPlace(code: string) {
  const { rows } = await test.db.execute<{ id: string }>(sql`
    select m.id from treasury_movements m
    join ledger_accounts a on a.id in (m.from_account_id, m.to_account_id)
    where a.code = ${code} and m.reverses_movement_id is null
      and not exists (select 1 from treasury_movements r where r.reverses_movement_id = m.id)`);
  written.push(...rows.map((row) => row.id));
}

beforeAll(async () => {
  test = await startApp();
  client = api(test.url);
  admin = await client.adminWithTotp(test.db);
  seeded.push(admin.id);
  const reauthenticated = await client.post('/api/admin/me/reauthenticate', {
    cookie: admin.cookie,
    body: { password: PASSWORD, totpCode: totp(admin.secret) },
  });
  expect(reauthenticated.status).toBe(200);
  await clearPlace(TREASURY_ACCOUNTS['supplier:manual'].code);
});

afterAll(async () => {
  const reversed = await test.db.execute<{ reverses: string }>(sql`
    select reverses_movement_id as reverses from treasury_movements
    where reverses_movement_id is not null`);
  const done = new Set(reversed.rows.map((row) => row.reverses));
  for (const id of written.filter((id) => !done.has(id))) {
    await test.db.transaction((tx) =>
      reverseMovement(
        tx,
        { movementId: id, idempotencyKey: randomUUID(), reason: 'Test clean-up' },
        { adminId: admin.id, ipAddress: null, userAgent: null },
      ),
    );
  }
  await removeAccounts(test.db, seeded);
  await test.app.close();
});

describe('access', () => {
  it('answers 401 without a session and refuses a customer session', async () => {
    const customer = await seedCustomer(test.db);
    seeded.push(customer.id);
    const cookie = await client.signInCustomer(customer.email);
    const id = randomUUID();
    for (const options of [{}, { cookie }]) {
      for (const response of await Promise.all([
        client.get('/api/admin/treasury/places', options),
        client.get('/api/admin/treasury/movements', options),
        client.post('/api/admin/treasury/movements', { ...options, body: {} }),
        client.post('/api/admin/treasury/supplier-corrections', { ...options, body: {} }),
        client.post(`/api/admin/treasury/movements/${id}/reverse`, { ...options, body: {} }),
      ])) {
        expect(response.status).toBe(401);
      }
    }
  });
});

describe('movements', () => {
  it('records a transfer with its fee, answers no-store, replays its key and refuses reuse', async () => {
    const key = randomUUID();
    const payload = {
      from: 'usdt_trc20',
      to: 'supplier:manual',
      sentUnits: 20 * USD,
      receivedUnits: 19 * USD,
      externalReference: `api-${randomUUID()}`,
    };
    const response = await movement(payload, key);
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const first = await body(response);
    written.push(first.id as string);
    expect(first).toMatchObject({
      kind: 'transfer',
      from: 'usdt_trc20',
      to: 'supplier:manual',
      feeUnits: USD,
      rate: null,
      reversedByMovementId: null,
      adminName: expect.any(String),
    });
    const replay = await movement(payload, key);
    expect(replay.status).toBe(200);
    expect((await body(replay)).id).toBe(first.id);
    expect(await body(await movement({ ...payload, sentUnits: 21 * USD }, key))).toMatchObject({
      status: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(
      await body(
        await movement({ ...payload, externalReference: payload.externalReference.toUpperCase() }),
      ),
    ).toMatchObject({
      status: 409,
      code: 'EXTERNAL_REFERENCE_TAKEN',
    });
    const [entry] = await auditOf(test.db, first.id as string);
    expect(entry).toMatchObject({ action: 'treasury_movement.created', reason: 'Treasury test' });
  });

  it('refuses the same place, outside to outside, more received and a missing category (T2–T4)', async () => {
    const base = { sentUnits: USD, receivedUnits: USD };
    expect(
      await body(await movement({ ...base, from: 'usdt_trc20', to: 'usdt_trc20' })),
    ).toMatchObject({
      status: 400,
      code: 'TREASURY_PLACES_INVALID',
    });
    expect(
      await body(
        await movement({
          ...base,
          from: 'outside_usd',
          to: 'outside_syp',
          receivedUnits: 100,
          outsideCategory: 'owner',
        }),
      ),
    ).toMatchObject({ status: 400, code: 'TREASURY_PLACES_INVALID' });
    expect(
      await body(
        await movement({
          ...base,
          from: 'usdt_trc20',
          to: 'supplier:fake',
          receivedUnits: 2 * USD,
        }),
      ),
    ).toMatchObject({ status: 400, code: 'MOVEMENT_RECEIVED_EXCEEDS_SENT' });
    expect(
      await body(await movement({ ...base, from: 'usdt_trc20', to: 'outside_usd' })),
    ).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
  });

  it('asks for the amount typed again above $100 (rule T7)', async () => {
    const payload = {
      from: 'outside_usd',
      to: 'supplier:manual',
      sentUnits: 150 * USD,
      receivedUnits: 150 * USD,
      outsideCategory: 'owner',
    };
    expect(await body(await movement(payload))).toMatchObject({
      status: 400,
      code: 'AMOUNT_CONFIRMATION_REQUIRED',
    });
    expect(
      await body(await movement({ ...payload, amountConfirmationUnits: 151 * USD })),
    ).toMatchObject({
      status: 400,
      code: 'AMOUNT_CONFIRMATION_MISMATCH',
    });
    expect((await recorded({ ...payload, amountConfirmationUnits: 150 * USD })).sentUnits).toBe(
      150 * USD,
    );
  });

  it('records an opening once while the place stands empty (rule T6)', async () => {
    const opening = {
      from: 'outside_usd',
      to: 'supplier:wdgzone',
      sentUnits: 5 * USD,
      receivedUnits: 5 * USD,
      outsideCategory: 'owner',
      openingBalance: true,
    };
    await clearPlace(TREASURY_ACCOUNTS['supplier:wdgzone'].code);
    // Reverse what a crashed run left, so the place is empty for this test.
    for (const id of written.splice(0)) {
      await test.db.transaction((tx) =>
        reverseMovement(
          tx,
          { movementId: id, idempotencyKey: randomUUID(), reason: 'Test clean-up' },
          { adminId: admin.id, ipAddress: null, userAgent: null },
        ).catch(() => null),
      );
    }
    const first = await recorded(opening);
    expect(first).toMatchObject({ openingBalance: true });
    expect(await body(await movement(opening))).toMatchObject({
      status: 409,
      code: 'OPENING_BALANCE_EXISTS',
    });
  });

  it('refuses a USDT return naming a TXID no unclaimed receipt booked (rule T8, Q30)', async () => {
    expect(
      await body(
        await movement({
          from: 'usdt_trc20',
          to: 'outside_usd',
          sentUnits: 5 * USD,
          receivedUnits: 5 * USD,
          outsideCategory: 'return_to_sender',
          externalReference: randomUUID().replaceAll('-', '').padEnd(64, 'a'),
          reason: 'Bounced transfer sent back',
        }),
      ),
    ).toMatchObject({ status: 409, code: 'RETURN_RECEIPT_MISSING' });
  });

  it('records a supplier correction about an order number it knows (rule T5)', async () => {
    const payload = {
      supplier: 'manual',
      direction: 'decrease',
      amountUnits: 1_250,
      reason: 'Charged twice',
    };
    expect(
      await body(
        await post('/api/admin/treasury/supplier-corrections', {
          ...payload,
          orderNumber: 'VO-222222',
        }),
      ),
    ).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    const response = await post('/api/admin/treasury/supplier-corrections', payload);
    expect(response.status).toBe(201);
    const correction = await body(response);
    written.push(correction.id as string);
    expect(correction).toMatchObject({
      kind: 'supplier_correction',
      from: 'supplier:manual',
      to: 'supplier_corrections',
      sentUnits: 1_250,
      feeUnits: 0,
    });
  });

  it('reverses once, in parallel too, and never a reversal (rule T9)', async () => {
    const original = await recorded({
      from: 'outside_usd',
      to: 'supplier:manual',
      sentUnits: 3 * USD,
      receivedUnits: 3 * USD,
      outsideCategory: 'owner',
    });
    const reverse = (id: string, key = randomUUID()) =>
      post(`/api/admin/treasury/movements/${id}/reverse`, { reason: 'Booked twice' }, key);
    const outcomes = await Promise.all([
      reverse(original.id as string),
      reverse(original.id as string),
    ]);
    const statuses = outcomes.map((response) => response.status).sort();
    expect(statuses).toEqual([201, 409]);
    const reversal = await body(outcomes.find((response) => response.status === 201) as Response);
    expect(reversal).toMatchObject({ reversesMovementId: original.id, sentUnits: 3 * USD });
    expect(await body(await reverse(reversal.id as string))).toMatchObject({
      status: 409,
      code: 'MOVEMENT_NOT_REVERSIBLE',
    });
    expect(await body(await reverse(randomUUID()))).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
    expect(await body(await reverse('not-an-id'))).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
    const list = await body(
      await client.get('/api/admin/treasury/movements?place=supplier:manual&limit=100', {
        cookie: admin.cookie,
      }),
    );
    const items = list.items as { id: string; reversedByMovementId: string | null }[];
    expect(items.find((item) => item.id === original.id)?.reversedByMovementId).toBe(reversal.id);
  });

  it('lists the places with their books', async () => {
    const response = await client.get('/api/admin/treasury/places', { cookie: admin.cookie });
    expect(response.status).toBe(200);
    const { places } = (await response.json()) as { places: { place: string }[] };
    expect(places.map((place) => place.place)).toContain('sham_cash_syp');
  });
});

describe('re-authentication', () => {
  it('refuses to record, correct or reverse without a recent re-authentication', async () => {
    const fresh = await client.adminWithTotp(test.db);
    seeded.push(fresh.id);
    for (const path of [
      '/api/admin/treasury/movements',
      '/api/admin/treasury/supplier-corrections',
      `/api/admin/treasury/movements/${randomUUID()}/reverse`,
    ]) {
      const response = await client.post(path, {
        cookie: fresh.cookie,
        body: {},
        headers: { 'idempotency-key': randomUUID() },
      });
      expect(await body(response)).toMatchObject({
        status: 403,
        code: 'REAUTHENTICATION_REQUIRED',
      });
    }
    // The clean-up reverses as the newest admin.
    admin = fresh;
  });
});
