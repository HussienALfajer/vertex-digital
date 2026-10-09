import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { priceFromCost, QUEUES } from '@vertex-digital/contracts';
import {
  auditEntries,
  catalogCategories,
  ensureCustomerWallet,
  ensureSystemAccount,
  newId,
  orders,
  playerChecks,
  postJournal,
  supplierBalanceReads,
  supplierCalls,
  supplierOffers,
  supplierSyncRuns,
  suppliers,
  telegramMessages,
  validationsToday,
} from '@vertex-digital/db';
import { FakeSupplierAdapter } from '@vertex-digital/suppliers';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../src/core/config/env.js';
import {
  api,
  body,
  notificationsOf,
  openCustomerStream,
  PASSWORD,
  removeAccounts,
  seedCustomer,
  setSwitches,
  totp,
} from './helpers.js';
import { startApp, type TestApp } from './start-app.js';

/*
 * S09 over HTTP against the test database with the `fake` supplier: player checks (rules
 * PV1–PV8), reservations and their cancel (RS1, RS2, RS8), the order's new fields and timeline
 * (LT1) and the stream's `order` event (LT2). Paying reservations is the worker's (PR 2). The
 * fake's daily quota and state file are put back in `afterAll`; orders stay (never deleted).
 */

let test: TestApp;
let client: ReturnType<typeof api>;
let admin: Awaited<ReturnType<ReturnType<typeof api>['adminWithTotp']>>;
const seeded: string[] = [];
const categories: string[] = [];
const run = randomBytes(4).toString('hex');
const usd = (dollars: number) => Math.round(dollars * 1_000_000);
const RULE = { percentBp: 1000, fixedUsdUnits: 0, minMarginUsdUnits: usd(0.1) };
const STATE_FILE = parseEnv().FAKE_SUPPLIER_STATE_FILE;
const ids = { fake: '', gameId: '', codeGameId: '' };
let quotaBefore = 1_000;

interface Item {
  id: string;
  price: number;
}

async function json<T = Record<string, unknown>>(response: Response, status: number): Promise<T> {
  const payload = await response.json();
  expect(response.status, JSON.stringify(payload)).toBe(status);
  return payload as T;
}

const adminPost = (path: string, payload?: unknown) =>
  client.post(path, { cookie: admin.cookie, body: payload });

async function game(slug: string) {
  return (
    await json<{ id: string }>(
      await adminPost('/api/admin/catalog/games', {
        categoryId: categories[0],
        slug,
        nameAr: `لعبة ${slug}`,
        nameEn: 'Game',
      }),
      201,
    )
  ).id;
}

async function product(gameId: string, kind: 'direct' | 'code', cost: number): Promise<Item> {
  await test.db.execute(sql`update catalog_games set status = 'paused' where id = ${gameId}`);
  const created = await json<{ id: string }>(
    await adminPost(`/api/admin/catalog/games/${gameId}/products`, {
      kind,
      nameAr: `باقة ${randomBytes(3).toString('hex')}`,
    }),
    201,
  );
  const now = new Date();
  const [offer] = await test.db
    .insert(supplierOffers)
    .values({
      supplierId: ids.fake,
      offerId: `o-${randomBytes(4).toString('hex')}`,
      name: 'Fake offer',
      kind,
      requiredFields: kind === 'direct' ? ['playerId'] : [],
      costUsdUnits: usd(cost),
      inStock: true,
      costConfirmedAt: now,
      lastSeenAt: now,
    })
    .returning({ id: supplierOffers.id });
  await json(
    await adminPost(`/api/admin/catalog/products/${created.id}/routes`, {
      offerId: offer?.id,
      fieldMap: kind === 'direct' ? { playerId: 'player_id' } : {},
    }),
    201,
  );
  await test.db.execute(sql`update catalog_games set status = 'active' where id = ${gameId}`);
  return { id: created.id, price: priceFromCost(usd(cost), RULE) };
}

async function buyer(options: { funds?: number; isTest?: boolean } = {}) {
  const customer = await seedCustomer(test.db, { isTest: options.isTest });
  seeded.push(customer.id);
  if (options.funds) {
    await test.db.transaction(async (tx) => {
      await postJournal(tx, {
        idempotencyKey: `test:${newId()}`,
        kind: 'adjustment',
        postings: [
          {
            accountId: await ensureCustomerWallet(tx, customer.id),
            amountUnits: options.funds as number,
          },
          {
            accountId: await ensureSystemAccount(tx, {
              code: 'adjustments:test_funds',
              kind: 'adjustments',
              currency: 'USD',
            }),
            amountUnits: -(options.funds as number),
          },
        ],
      });
    });
  }
  return { ...customer, cookie: await client.signInCustomer(customer.email) };
}

type Buyer = Awaited<ReturnType<typeof buyer>>;

const check = (who: Buyer | null, item: Item, playerId: string, ip?: string) =>
  client.post('/api/player-checks', {
    ...(who && { cookie: who.cookie }),
    ...(ip && { ip }),
    body: { productId: item.id, fields: { player_id: playerId } },
  });

const purchase = (who: Buyer, item: Item, extra: Record<string, unknown> = {}) =>
  client.post('/api/orders', {
    cookie: who.cookie,
    headers: { 'idempotency-key': randomUUID() },
    body: {
      productId: item.id,
      quantity: 1,
      fields: { player_id: playerIdOf(extra) },
      expectedUnitPriceUsdUnits: item.price,
      ...extra,
    },
  });

function playerIdOf(extra: Record<string, unknown>) {
  return (extra.playerId as string | undefined) ?? '5123456789';
}

const fresh = () => String(1_000_000_000 + Math.floor(Math.random() * 8_000_000_000));

const callsOfFake = async () =>
  (await validationsToday(test.db, [ids.fake])).get(ids.fake) as number;

const writeState = async (state: object) => {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state));
};

const setQuota = (quota: number) =>
  test.db.update(suppliers).set({ validationDailyQuota: quota }).where(eq(suppliers.id, ids.fake));

beforeAll(async () => {
  await rm(STATE_FILE, { force: true });
  test = await startApp();
  client = api(test.url);
  admin = await client.adminWithTotp(test.db);
  seeded.push(admin.id);
  await json(
    await client.post('/api/admin/me/reauthenticate', {
      cookie: admin.cookie,
      body: { password: PASSWORD, totpCode: totp(admin.secret) },
    }),
    200,
  );
  await setSwitches(test.db);
  const [fake] = await test.db.select().from(suppliers).where(eq(suppliers.code, 'fake'));
  ids.fake = fake?.id as string;
  quotaBefore = fake?.validationDailyQuota ?? 1_000;
  await setQuota(1_000_000);
  await test.db
    .insert(supplierBalanceReads)
    .values({ supplierId: ids.fake, currency: 'USD', amountUnits: usd(1_000_000) });
  await json(
    await client.put('/api/admin/suppliers/fake/credentials', {
      cookie: admin.cookie,
      body: { values: { webhookSecret: `whsec-${run}-checks` } },
    }),
    200,
  );
  await test.db
    .update(supplierSyncRuns)
    .set({ status: 'failed', finishedAt: new Date(), errorCode: 'TEST' })
    .where(and(eq(supplierSyncRuns.supplierId, ids.fake), eq(supplierSyncRuns.status, 'running')));
  const category = await json<{ id: string }>(
    await adminPost('/api/admin/catalog/categories', {
      slug: `chk-${run}`,
      nameAr: `تحقق ${run}`,
    }),
    201,
  );
  categories.push(category.id);
  await json(
    await client.put('/api/admin/pricing/rules', {
      cookie: admin.cookie,
      body: { scope: 'category', targetId: category.id, ...RULE },
    }),
    200,
  );
  ids.gameId = await game(`chk-${run}`);
  ids.codeGameId = await game(`chk-code-${run}`);
  await test.db.execute(
    sql`insert into catalog_input_fields (id, game_id, key, label_ar, type, required, sort_order,
      min_length, max_length) values (${newId()}, ${ids.gameId}, 'player_id', 'المعرف', 'digits',
      true, 1, 5, 12)`,
  );
});

afterAll(async () => {
  vi.restoreAllMocks();
  await setQuota(quotaBefore);
  await rm(STATE_FILE, { force: true });
  await test.db
    .update(catalogCategories)
    .set({ archivedAt: new Date() })
    .where(inArray(catalogCategories.id, categories));
  await removeAccounts(test.db, seeded);
  await test.app.close();
});

describe('POST /api/player-checks (rules PV1–PV7)', () => {
  it('answers 401 signed out and to the admin, 403 before the email is verified', async () => {
    const item = await product(ids.gameId, 'direct', 0.88);
    expect((await check(null, item, fresh())).status).toBe(401);
    expect(
      (
        await client.post('/api/player-checks', {
          cookie: admin.cookie,
          body: { productId: item.id, fields: { player_id: fresh() } },
        })
      ).status,
    ).toBe(401);
    // An unverified customer gets no session; one whose email was unverified since keeps it.
    const unverified = await buyer();
    await test.db.execute(
      sql`update customers set email_verified = false where id = ${unverified.id}`,
    );
    expect(await body(await check(unverified, item, fresh()))).toMatchObject({
      status: 403,
      code: 'EMAIL_NOT_VERIFIED',
    });
  });

  it('asks the supplier once, then answers from the cache for anyone, never cached by HTTP', async () => {
    const item = await product(ids.gameId, 'direct', 0.88);
    const [first, second] = [await buyer(), await buyer()];
    const playerId = fresh();
    const calls = await callsOfFake();
    const response = await check(first, item, playerId);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await json(response, 200)).toEqual({
      result: 'valid',
      playerName: `Player ${playerId.slice(-4)}`,
    });
    expect(await callsOfFake()).toBe(calls + 1);
    expect(await json(await check(second, item, ` ${playerId} `), 200)).toMatchObject({
      result: 'valid',
    });
    expect(await callsOfFake()).toBe(calls + 1);
    // Only an HMAC of the fields is stored, never the player id; valid for 24 hours.
    const rows = await test.db
      .select()
      .from(playerChecks)
      .where(eq(playerChecks.customerId, first.id));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(playerId);
    const hours =
      ((rows[0]?.expiresAt.getTime() ?? 0) - (rows[0]?.createdAt.getTime() ?? 0)) / 36e5;
    expect(Math.round(hours)).toBe(24);
  });

  it('answers invalid for an unknown player, cached for an hour', async () => {
    const item = await product(ids.gameId, 'direct', 0.88);
    const customer = await buyer();
    // The fake's `invalid…` ids are not digits: the supplier's "not found" is scripted here.
    const spy = vi
      .spyOn(FakeSupplierAdapter.prototype, 'validatePlayer')
      .mockResolvedValueOnce({ valid: false });
    expect(await json(await check(customer, item, fresh()), 200)).toEqual({ result: 'invalid' });
    spy.mockRestore();
    const [row] = await test.db
      .select()
      .from(playerChecks)
      .where(eq(playerChecks.customerId, customer.id));
    expect(row?.result).toBe('invalid');
    expect(
      Math.round(((row?.expiresAt.getTime() ?? 0) - (row?.createdAt.getTime() ?? 0)) / 6e4),
    ).toBe(60);
  });

  it('answers unavailable when the supplier fails or is slow, without caching it', async () => {
    const item = await product(ids.gameId, 'direct', 0.88);
    const customer = await buyer();
    await writeState({ errors: true });
    const playerId = fresh();
    expect(await json(await check(customer, item, playerId), 200)).toEqual({
      result: 'unavailable',
      reason: 'supplier',
    });
    await writeState({});
    const [call] = await test.db
      .select()
      .from(supplierCalls)
      .where(
        and(eq(supplierCalls.supplierId, ids.fake), eq(supplierCalls.operation, 'validate_player')),
      )
      .orderBy(sql`${supplierCalls.createdAt} desc`)
      .limit(1);
    expect(call?.result).toBe('error');
    // Not cached: the next check asks again and finds the player.
    expect(await json(await check(customer, item, playerId), 200)).toMatchObject({
      result: 'valid',
    });
    const spy = vi
      .spyOn(FakeSupplierAdapter.prototype, 'validatePlayer')
      .mockImplementationOnce(() => new Promise(() => {}));
    const started = Date.now();
    expect(await json(await check(customer, item, fresh()), 200)).toEqual({
      result: 'unavailable',
      reason: 'supplier',
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_900);
    spy.mockRestore();
  });

  it('answers not_supported for a code product, and checks a test customer through fake', async () => {
    const code = await product(ids.codeGameId, 'code', 5);
    const customer = await buyer();
    expect(
      await json(
        await client.post('/api/player-checks', {
          cookie: customer.cookie,
          body: { productId: code.id, fields: {} },
        }),
        200,
      ),
    ).toEqual({ result: 'not_supported' });
    const item = await product(ids.gameId, 'direct', 0.88);
    const tester = await buyer({ isTest: true });
    expect(await json(await check(tester, item, fresh()), 200)).toMatchObject({ result: 'valid' });
    // Quota 0 turns the checks off for the supplier.
    await setQuota(0);
    try {
      expect(await json(await check(customer, item, fresh()), 200)).toEqual({
        result: 'not_supported',
      });
    } finally {
      await setQuota(1_000_000);
    }
  });

  it('refuses invalid fields, an unknown product and an unavailable one', async () => {
    const item = await product(ids.gameId, 'direct', 0.88);
    const customer = await buyer();
    expect(await json(await check(customer, item, '12'), 400)).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { fields: { player_id: expect.any(String) } },
    });
    expect(
      await json(await check(customer, { ...item, id: randomUUID() }, fresh()), 404),
    ).toMatchObject({ code: 'NOT_FOUND' });
    await test.db.execute(sql`update catalog_products set status = 'paused' where id = ${item.id}`);
    expect(await json(await check(customer, item, fresh()), 404)).toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('stops at the daily quota with one alert a day, and counts only supplier calls in the limits', async () => {
    const item = await product(ids.gameId, 'direct', 0.88);
    const customer = await buyer();
    const known = fresh();
    expect(await json(await check(customer, item, known), 200)).toMatchObject({ result: 'valid' });
    await setQuota(await callsOfFake());
    try {
      for (let i = 0; i < 2; i += 1) {
        expect(await json(await check(customer, item, fresh()), 200)).toEqual({
          result: 'unavailable',
          reason: 'quota',
        });
      }
      const alerts = await test.db
        .select()
        .from(telegramMessages)
        .where(like(telegramMessages.dedupeKey, 'validation-quota:fake:%'));
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.kind).toBe('validation_quota_reached');
      // A cache hit still answers.
      expect(await json(await check(customer, item, known), 200)).toMatchObject({
        result: 'valid',
      });
    } finally {
      await setQuota(1_000_000);
    }
    // 10 supplier calls an hour per customer (the two refused by the quota counted too).
    const limited = await buyer();
    for (let i = 0; i < 10; i += 1) {
      expect((await check(limited, item, fresh())).status).toBe(200);
    }
    expect(await json(await check(limited, item, fresh()), 429)).toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(await json(await check(limited, item, known), 200)).toMatchObject({ result: 'valid' });
    // 30 an hour per address, whoever asks.
    const ip = `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    for (const someone of [await buyer(), await buyer(), await buyer()]) {
      for (let i = 0; i < 10; i += 1) {
        expect((await check(someone, item, fresh(), ip)).status).toBe(200);
      }
    }
    expect((await check(await buyer(), item, fresh(), ip)).status).toBe(429);
  });
});

describe('the game page with priced packs (rules SF2, SS1, SS3, PV1)', () => {
  it('shows the price, SYP, savings and the check flag, never a supplier', async () => {
    const item = await product(ids.gameId, 'direct', 0.88);
    await json(
      await client.patch(`/api/admin/catalog/products/${item.id}`, {
        cookie: admin.cookie,
        body: { officialPriceUsdUnits: usd(2) },
      }),
      200,
    );
    const page = await json<{
      game: { status: string };
      products: Record<string, unknown>[];
    }>(await client.get(`/api/catalog/games/chk-${run}`), 200);
    expect(page.game.status).toBe('normal');
    expect(page.products.find((entry) => entry.id === item.id)).toMatchObject({
      available: true,
      priceUsdUnits: item.price,
      savings: { amountUsdUnits: usd(2) - item.price, percent: expect.any(Number) },
      playerCheck: true,
      deliveryStats: null,
    });
    const text = JSON.stringify(page);
    for (const secret of ['fake', 'supplier', 'cost', 'health']) expect(text).not.toContain(secret);
  });
});

describe('the purchase with checks and reservations (rules PV8, RS1, RS2, RS8)', () => {
  it('records a valid check, and asks for a confirmation otherwise', async () => {
    const item = await product(ids.gameId, 'direct', 0.88);
    const customer = await buyer({ funds: usd(20) });
    const valid = fresh();
    await json(await check(customer, item, valid), 200);
    const order = await json<Record<string, unknown>>(
      await purchase(customer, item, { playerId: valid }),
      201,
    );
    expect(order).toMatchObject({ playerName: `Player ${valid.slice(-4)}`, expiresAt: null });
    const [row] = await test.db
      .select({ playerCheck: orders.playerCheck })
      .from(orders)
      .where(eq(orders.id, order.id as string));
    expect(row?.playerCheck).toBe('valid');

    const unchecked = fresh();
    expect(await json(await purchase(customer, item, { playerId: unchecked }), 409)).toMatchObject({
      code: 'PLAYER_NOT_CONFIRMED',
    });
    const confirmed = await json<{ id: string }>(
      await purchase(customer, item, { playerId: unchecked, confirmPlayer: true }),
      201,
    );
    const [confirmedRow] = await test.db
      .select({ playerCheck: orders.playerCheck })
      .from(orders)
      .where(eq(orders.id, confirmed.id));
    expect(confirmedRow?.playerCheck).toBe('unchecked_confirmed');

    const spy = vi
      .spyOn(FakeSupplierAdapter.prototype, 'validatePlayer')
      .mockResolvedValueOnce({ valid: false });
    const wrong = fresh();
    await json(await check(customer, item, wrong), 200);
    spy.mockRestore();
    expect(await json(await purchase(customer, item, { playerId: wrong }), 409)).toMatchObject({
      code: 'PLAYER_NOT_CONFIRMED',
    });
    const invalid = await json<{ id: string }>(
      await purchase(customer, item, { playerId: wrong, confirmPlayer: true }),
      201,
    );
    const [invalidRow] = await test.db
      .select({ playerCheck: orders.playerCheck })
      .from(orders)
      .where(eq(orders.id, invalid.id));
    expect(invalidRow?.playerCheck).toBe('invalid_confirmed');

    // A code product: no check, the confirmation ignored.
    const code = await product(ids.codeGameId, 'code', 5);
    const codeOrder = await json<{ id: string; playerName: null }>(
      await client.post('/api/orders', {
        cookie: customer.cookie,
        headers: { 'idempotency-key': randomUUID() },
        body: { productId: code.id, quantity: 1, expectedUnitPriceUsdUnits: code.price },
      }),
      201,
    );
    expect(codeOrder.playerName).toBeNull();
  });

  it('reserves a short order with its deadline, at most 3, and queues the payment run', async () => {
    const item = await product(ids.gameId, 'direct', 4.5);
    const customer = await buyer({ funds: usd(1) });
    const reserve = () =>
      purchase(customer, item, { confirmPlayer: true, whenBalanceShort: 'reserve' });
    expect(await json(await purchase(customer, item, { confirmPlayer: true }), 409)).toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
    });
    const reserved = await json<{
      id: string;
      stage: string;
      expiresAt: string;
      timeline: unknown;
    }>(await reserve(), 201);
    expect(reserved.stage).toBe('awaiting_balance');
    expect(reserved.timeline).toEqual([{ step: 'reserved', at: expect.any(String) }]);
    expect(new Date(reserved.expiresAt).getTime() - Date.now()).toBeGreaterThan(23.9 * 36e5);
    const [jobs] = (
      await test.db.execute<{ n: number }>(
        sql`select count(*)::int as n from pgboss.job where name = ${QUEUES.ordersPayWaiting} and data->>'customerId' = ${customer.id}`,
      )
    ).rows;
    expect(jobs?.n).toBeGreaterThanOrEqual(1);
    expect(await auditOfAction(reserved.id, 'order.reserved')).toBe(1);
    // Rule AD3: the admin sees the reservation and the player check, and filters by status.
    const adminView = await json<Record<string, unknown>>(
      await client.get(`/api/admin/orders/${reserved.id}`, { cookie: admin.cookie }),
      200,
    );
    expect(adminView).toMatchObject({
      status: 'awaiting_balance',
      reservedAt: expect.any(String),
      expiresAt: reserved.expiresAt,
      cancelReason: null,
      playerCheck: 'unchecked_confirmed',
      paidAt: null,
    });
    const waiting = await json<{ items: { id: string }[] }>(
      await client.get('/api/admin/orders?status=awaiting_balance&pageSize=100', {
        cookie: admin.cookie,
      }),
      200,
    );
    expect(waiting.items.map((entry) => entry.id)).toContain(reserved.id);
    await json(await reserve(), 201);
    await json(await reserve(), 201);
    expect(await json(await reserve(), 409)).toMatchObject({
      code: 'RESERVATIONS_LIMIT_REACHED',
      details: { limit: 3 },
    });
    const list = await json<{ items: { id: string; stage: string; expiresAt: string | null }[] }>(
      await client.get('/api/orders', { cookie: customer.cookie }),
      200,
    );
    expect(list.items.filter((entry) => entry.stage === 'awaiting_balance')).toHaveLength(3);
    expect(list.items.every((entry) => entry.expiresAt !== null)).toBe(true);
    // The balance never moved.
    const wallet = await json<{ balanceUnits: number }>(
      await client.get('/api/wallet', { cookie: customer.cookie }),
      200,
    );
    expect(wallet.balanceUnits).toBe(usd(1));
  });

  it('cancels an own reservation only, and never a paid order', async () => {
    const item = await product(ids.gameId, 'direct', 4.5);
    const customer = await buyer({ funds: usd(10) });
    const stranger = await buyer();
    const reserved = await json<{ id: string }>(
      await purchase(customer, await product(ids.gameId, 'direct', 20), {
        confirmPlayer: true,
        whenBalanceShort: 'reserve',
      }),
      201,
    );
    const cancel = (who: Buyer, id: string) =>
      client.post(`/api/orders/${id}/cancel`, { cookie: who.cookie });
    expect((await client.post(`/api/orders/${reserved.id}/cancel`, {})).status).toBe(401);
    expect(await json(await cancel(stranger, reserved.id), 404)).toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await json(await cancel(customer, 'not-a-uuid'), 404)).toMatchObject({
      code: 'NOT_FOUND',
    });
    const cancelled = await json<Record<string, unknown>>(await cancel(customer, reserved.id), 200);
    expect(cancelled).toMatchObject({ stage: 'cancelled', cancelReason: 'customer' });
    expect((cancelled.timeline as { step: string }[]).map((step) => step.step)).toEqual([
      'reserved',
      'cancelled',
    ]);
    expect(await auditOfAction(reserved.id, 'order.cancelled')).toBe(1);
    // No notification for the customer's own cancel (RS8).
    expect(
      (await notificationsOf(test.db, customer.id)).filter((n) => n.event === 'order_cancelled'),
    ).toEqual([]);
    expect(await json(await cancel(customer, reserved.id), 409)).toMatchObject({
      code: 'ORDER_NOT_CANCELLABLE',
      details: { status: 'cancelled' },
    });
    const paid = await json<{ id: string }>(
      await purchase(customer, item, { confirmPlayer: true }),
      201,
    );
    expect(await json(await cancel(customer, paid.id), 409)).toMatchObject({
      code: 'ORDER_NOT_CANCELLABLE',
      details: { status: 'paid' },
    });
  });

  it('streams the customer their own order changes only (rule LT2)', async () => {
    const item = await product(ids.gameId, 'direct', 0.88);
    const customer = await buyer({ funds: usd(10) });
    const other = await buyer({ funds: usd(10) });
    const stream = await openCustomerStream(client, customer.cookie);
    expect((await stream.event(1)).event).toBe('unread');
    await json(await purchase(other, item, { confirmPlayer: true }), 201);
    const order = await json<{ id: string }>(
      await purchase(customer, item, { confirmPlayer: true }),
      201,
    );
    expect(await stream.event(2)).toEqual({
      event: 'order',
      data: { orderId: order.id, status: 'paid', stage: 'processing' },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(stream.events.filter((event) => event.event === 'order')).toHaveLength(1);
    await stream.close();
  });
});

async function auditOfAction(entityId: string, action: string) {
  const rows = await test.db
    .select({ id: auditEntries.id })
    .from(auditEntries)
    .where(and(eq(auditEntries.entityId, entityId), sql`${auditEntries.action} = ${action}`));
  return rows.length;
}
