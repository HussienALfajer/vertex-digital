import { randomBytes, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { ORDER_POLICY_DEFAULTS, priceFromCost, QUEUES } from '@vertex-digital/contracts';
import {
  catalogCategories,
  ensureCustomerWallet,
  ensureSystemAccount,
  newId,
  playerChecks,
  postJournal,
  supplierBalanceReads,
  supplierOffers,
  supplierSyncRuns,
  suppliers,
  telegramMessages,
} from '@vertex-digital/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../src/core/config/env.js';
import { SupplierAdaptersService } from '../src/modules/suppliers/supplier-adapters.service.js';
import {
  api,
  auditOf,
  body,
  notificationsOf,
  openEventStream,
  PASSWORD,
  removeAccounts,
  seedCustomer,
  setSwitches,
  totp,
} from './helpers.js';
import { startApp, type TestApp } from './start-app.js';

/*
 * S16 admin purchases over HTTP (rules AP1–AP14) against the test database with the `fake`
 * supplier: the order in each mode, its replay, re-authentication and access, the purchase
 * context, the admin's player check, the list filters and the customer's view. The money rules
 * and their races are proven in `packages/db` (`orders.test.ts`). The owner cap is set high in
 * `beforeAll` and put back to the defaults in `afterAll`; orders stay (never deleted).
 */

let test: TestApp;
let client: ReturnType<typeof api>;
let admin: Awaited<ReturnType<ReturnType<typeof api>['adminWithTotp']>>;
const seeded: string[] = [];
const categories: string[] = [];
const run = randomBytes(4).toString('hex');
const usd = (dollars: number) => Math.round(dollars * 1_000_000);
const RULE = { percentBp: 1000, fixedUsdUnits: 0, minMarginUsdUnits: usd(0.1) };
const ids = { fake: '', gameId: '', codeGameId: '' };
const recorded: { supplierId: string; operation: string; result: string }[] = [];

interface Item {
  id: string;
  price: number;
}

async function json<T = Record<string, unknown>>(response: Response, status: number): Promise<T> {
  const payload = await response.json();
  expect(response.status, JSON.stringify(payload)).toBe(status);
  return payload as T;
}

async function reauthenticate() {
  await json(
    await client.post('/api/admin/me/reauthenticate', {
      cookie: admin.cookie,
      body: { password: PASSWORD, totpCode: totp(admin.secret) },
    }),
    200,
  );
}

const adminGet = (path: string) => client.get(path, { cookie: admin.cookie });
const adminPost = (path: string, payload?: unknown, headers?: Record<string, string>) =>
  client.post(path, { cookie: admin.cookie, body: payload, ...(headers && { headers }) });

const setCap = (units: number) =>
  client.put('/api/admin/orders/policy', {
    cookie: admin.cookie,
    body: { ...ORDER_POLICY_DEFAULTS, ownerDailyCapUsdUnits: units },
  });

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
      ...(kind === 'code' && { maxQuantity: 5 }),
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

async function customer(funds = 0) {
  const seededCustomer = await seedCustomer(test.db);
  seeded.push(seededCustomer.id);
  if (funds > 0) {
    await test.db.transaction(async (tx) => {
      await postJournal(tx, {
        idempotencyKey: `test:${newId()}`,
        kind: 'adjustment',
        postings: [
          { accountId: await ensureCustomerWallet(tx, seededCustomer.id), amountUnits: funds },
          {
            accountId: await ensureSystemAccount(tx, {
              code: 'adjustments:test_funds',
              kind: 'adjustments',
              currency: 'USD',
            }),
            amountUnits: -funds,
          },
        ],
      });
    });
  }
  return { ...seededCustomer, cookie: await client.signInCustomer(seededCustomer.email) };
}

const order = (
  item: Item,
  overrides: Record<string, unknown> = {},
  key: string = randomUUID(),
  cookie: string = admin.cookie,
) =>
  client.post('/api/admin/orders', {
    cookie,
    headers: { 'idempotency-key': key },
    body: {
      purpose: 'walk_in',
      productId: item.id,
      quantity: 1,
      fields: {},
      expectedUnitPriceUsdUnits: item.price,
      reason: 'Bought at the counter',
      ...overrides,
    },
  });

beforeAll(async () => {
  await rm(parseEnv().FAKE_SUPPLIER_STATE_FILE, { force: true });
  test = await startApp();
  client = api(test.url);
  admin = await client.adminWithTotp(test.db);
  seeded.push(admin.id);
  await reauthenticate();
  await setSwitches(test.db);
  vi.spyOn(SupplierAdaptersService.prototype, 'recordCall').mockImplementation(
    async (_tx, call) => {
      recorded.push(call);
    },
  );
  const [fake] = await test.db.select().from(suppliers).where(eq(suppliers.code, 'fake'));
  ids.fake = fake?.id as string;
  await test.db
    .insert(supplierBalanceReads)
    .values({ supplierId: ids.fake, currency: 'USD', amountUnits: usd(1_000_000) });
  await json(
    await client.put('/api/admin/suppliers/fake/credentials', {
      cookie: admin.cookie,
      body: { values: { webhookSecret: `whsec-${run}-admin-orders` } },
    }),
    200,
  );
  await test.db
    .update(supplierSyncRuns)
    .set({ status: 'failed', finishedAt: new Date(), errorCode: 'TEST' })
    .where(and(eq(supplierSyncRuns.supplierId, ids.fake), eq(supplierSyncRuns.status, 'running')));
  const category = await json<{ id: string }>(
    await adminPost('/api/admin/catalog/categories', {
      slug: `adm-${run}`,
      nameAr: `مشتريات ${run}`,
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
  ids.gameId = await game(`adm-pubg-${run}`);
  ids.codeGameId = await game(`adm-gift-${run}`);
  await json(
    await adminPost(`/api/admin/catalog/games/${ids.gameId}/fields`, {
      key: 'player_id',
      labelAr: 'المعرف',
      type: 'digits',
      required: true,
      minLength: 5,
    }),
    201,
  );
  await test.db.execute(
    sql`update catalog_games set status = 'active' where id in (${ids.gameId}, ${ids.codeGameId})`,
  );
  await json(await setCap(usd(10_000)), 200);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await test.db
    .update(catalogCategories)
    .set({ archivedAt: new Date() })
    .where(inArray(catalogCategories.id, categories));
  await setSwitches(test.db);
  await reauthenticate();
  await setCap(ORDER_POLICY_DEFAULTS.ownerDailyCapUsdUnits);
  await removeAccounts(test.db, seeded);
  await test.app.close();
});

describe('POST /api/admin/orders (rules AP1–AP13)', () => {
  it('places a walk-in order from owner funds; a replay answers 200, another body 409', async () => {
    const item = await product(ids.codeGameId, 'code', 1.8);
    const key = randomUUID();
    const response = await order(item, {}, key);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const created = await json<{ id: string; number: string }>(response, 201);
    expect(created).toMatchObject({
      status: 'paid',
      customer: null,
      placedBy: 'admin',
      payer: 'owner',
      purpose: 'walk_in',
      adminReason: 'Bought at the counter',
      totalUsdUnits: item.price,
    });
    const replay = await json<{ id: string }>(await order(item, {}, key), 200);
    expect(replay.id).toBe(created.id);
    expect(await body(await order(item, { quantity: 2 }, key))).toMatchObject({
      status: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    const [audit] = await auditOf(test.db, created.id);
    expect(audit).toMatchObject({ action: 'order.paid', actorKind: 'admin', actorId: admin.id });
    const jobs = await test.db.execute<{ name: string }>(
      sql`select name from pgboss.job where data->>'orderId' = ${created.id}`,
    );
    expect(jobs.rows.map((row) => row.name)).toContain(QUEUES.ordersFulfil);
    const [notice] = await test.db
      .select()
      .from(telegramMessages)
      .where(eq(telegramMessages.dedupeKey, `admin-order:${created.id}`));
    expect(notice).toMatchObject({ kind: 'admin_order_placed' });
  });

  it('places one order for one key sent twice at once (audit A04-15)', async () => {
    const item = await product(ids.codeGameId, 'code', 1.8);
    const key = randomUUID();
    const answers = await Promise.all([order(item, {}, key), order(item, {}, key)]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 201]);
    const [first, second] = await Promise.all(answers.map((answer) => answer.json()));
    expect((first as { id: string }).id).toBe((second as { id: string }).id);
    const placed = await test.db.execute<{ count: number }>(
      sql`select count(*)::int as count from orders where idempotency_key = ${key}`,
    );
    expect(placed.rows[0]?.count).toBe(1);
  });

  it('asks for a recent re-authentication, a key and the admin (AP2, ADR 0007)', async () => {
    const item = await product(ids.codeGameId, 'code', 1.8);
    const buyer = await customer();
    expect((await client.post('/api/admin/orders', { body: {} })).status).toBe(401);
    expect(await body(await order(item, {}, randomUUID(), buyer.cookie))).toMatchObject({
      status: 401,
    });
    expect(
      await body(
        await client.post('/api/admin/orders', {
          cookie: admin.cookie,
          body: {
            purpose: 'walk_in',
            productId: item.id,
            quantity: 1,
            fields: {},
            expectedUnitPriceUsdUnits: item.price,
            reason: 'No key sent here',
          },
        }),
      ),
    ).toMatchObject({ status: 400 });
    await test.db.execute(
      sql`update admin_sessions set reauthenticated_at = now() - interval '6 minutes' where user_id = ${admin.id}`,
    );
    expect(await body(await order(item))).toMatchObject({
      status: 403,
      code: 'REAUTHENTICATION_REQUIRED',
    });
    expect(await body(await setCap(usd(50)))).toMatchObject({
      code: 'REAUTHENTICATION_REQUIRED',
    });
    await reauthenticate();
  });

  it("streams a walk-in order's status to the admin, with no customer (S11 LR4)", async () => {
    const stream = await openEventStream(client, admin.cookie, '/api/admin/stream');
    expect(stream.response.status).toBe(200);
    const item = await product(ids.codeGameId, 'code', 1.8);
    const created = await json<{ id: string }>(await order(item), 201);
    await expect
      .poll(() => stream.events.find((event) => event.data.orderId === created.id))
      .toEqual({ event: 'order', data: { orderId: created.id, status: 'paid' } });
    await stream.close();
  });

  it('pays on behalf of a customer, who sees it with its chip and price (AP4, AP11)', async () => {
    const item = await product(ids.codeGameId, 'code', 1.8);
    const buyer = await customer(usd(10));
    const created = await json<{ id: string }>(
      await order(item, { purpose: 'on_behalf', customerId: buyer.id }),
      201,
    );
    const wallet = await json<{ balanceUnits: number }>(
      await client.get('/api/wallet', { cookie: buyer.cookie }),
      200,
    );
    expect(wallet.balanceUnits).toBe(usd(10) - item.price);
    const view = await json(
      await client.get(`/api/orders/${created.id}`, { cookie: buyer.cookie }),
      200,
    );
    expect(view).toMatchObject({
      placedByStore: 'on_behalf',
      totalUsdUnits: item.price,
      customerNote: null,
    });
    expect(JSON.stringify(view)).not.toContain('Bought at the counter');
    const events = await notificationsOf(test.db, buyer.id);
    expect(events.map((event) => event.event)).toContain('order_placed_for_you');
    // Another customer never reads it.
    const other = await customer();
    expect((await client.get(`/api/orders/${created.id}`, { cookie: other.cookie })).status).toBe(
      404,
    );
  });

  it('gives a gift without a price and keeps walk-in orders out of the store (AP11, AP12)', async () => {
    const item = await product(ids.codeGameId, 'code', 1.8);
    const buyer = await customer();
    const gift = await json<{ id: string }>(
      await order(item, {
        purpose: 'gift',
        customerId: buyer.id,
        reason: 'Loyal customer gift',
        customerNote: 'عيد سعيد',
      }),
      201,
    );
    const view = await json(
      await client.get(`/api/orders/${gift.id}`, { cookie: buyer.cookie }),
      200,
    );
    expect(view).toMatchObject({
      placedByStore: 'gift',
      customerNote: 'عيد سعيد',
      unitPriceUsdUnits: null,
      totalUsdUnits: null,
      totalSypUnits: null,
    });
    const page = await json<{ items: { id: string; totalUsdUnits: number | null }[] }>(
      await client.get('/api/orders', { cookie: buyer.cookie }),
      200,
    );
    expect(page.items.find((row) => row.id === gift.id)?.totalUsdUnits).toBeNull();
    const walkIn = await json<{ id: string }>(await order(item), 201);
    expect((await client.get(`/api/orders/${walkIn.id}`, { cookie: buyer.cookie })).status).toBe(
      404,
    );
    // A note only on a gift or a compensation; a customer on every mode but walk-in.
    expect(
      await body(
        await order(item, { purpose: 'on_behalf', customerId: buyer.id, customerNote: 'x' }),
      ),
    ).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    expect(await body(await order(item, { purpose: 'gift' }))).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
  });

  it('refuses beyond the owner cap with what is left (AP7)', async () => {
    const item = await product(ids.codeGameId, 'code', 1.8);
    const context = await json<{ owner: { usedTodayUsdUnits: number } }>(
      await adminGet('/api/admin/orders/purchase-context'),
      200,
    );
    const cap = Math.ceil((context.owner.usedTodayUsdUnits + item.price / 2) / 10_000) * 10_000;
    await json(await setCap(cap), 200);
    try {
      const refused = await body(await order(item));
      expect(refused).toMatchObject({ status: 409, code: 'OWNER_DAILY_CAP_EXCEEDED' });
      expect((refused.details as { remainingUsdUnits: number }).remainingUsdUnits).toBeLessThan(
        item.price,
      );
    } finally {
      await json(await setCap(usd(10_000)), 200);
    }
  });

  it('lists orders by placer, payer and mode (AP14)', async () => {
    const item = await product(ids.codeGameId, 'code', 1.8);
    const buyer = await customer();
    const created = await json<{ id: string }>(
      await order(item, { purpose: 'compensation', customerId: buyer.id }),
      201,
    );
    const page = await json<{ items: { id: string; purpose: string; payer: string }[] }>(
      await adminGet('/api/admin/orders?placedBy=admin&payer=owner&purpose=compensation'),
      200,
    );
    expect(page.items.map((row) => row.id)).toContain(created.id);
    expect(page.items.every((row) => row.purpose === 'compensation' && row.payer === 'owner')).toBe(
      true,
    );
  });
});

describe('GET /api/admin/orders/purchase-context (AP4, AP7, AP8)', () => {
  it("answers the owner cap, and a customer's wallet and state", async () => {
    const buyer = await customer(usd(3));
    const context = await json<{
      customer: Record<string, unknown>;
      owner: { capUsdUnits: number; remainingUsdUnits: number };
    }>(await adminGet(`/api/admin/orders/purchase-context?customerId=${buyer.id}`), 200);
    expect(context.owner.capUsdUnits).toBe(usd(10_000));
    expect(context.customer).toMatchObject({
      id: buyer.id,
      balanceUsdUnits: usd(3),
      frozen: false,
      emailVerified: true,
      purchaseCapLeftUsdUnits: null,
      savedPlayers: [],
    });
    expect(
      (await adminGet(`/api/admin/orders/purchase-context?customerId=${randomUUID()}`)).status,
    ).toBe(404);
    expect((await client.get('/api/admin/orders/purchase-context')).status).toBe(401);
    expect(
      (await client.get('/api/admin/orders/purchase-context', { cookie: buyer.cookie })).status,
    ).toBe(401);
  });
});

describe('GET /api/admin/orders/purchase-games (the sale picker)', () => {
  it('answers the games with their 30-day sales and the last game an admin sold', async () => {
    const item = await product(ids.codeGameId, 'code', 1.8);
    await json(await order(item), 201);
    const answer = await json<{
      categories: { id: string }[];
      games: { id: string; categoryId: string; soldLast30Days: number; searchTerms: string[] }[];
      lastGameId: string | null;
    }>(await adminGet('/api/admin/orders/purchase-games'), 200);
    expect(answer.lastGameId).toBe(ids.codeGameId);
    const sold = answer.games.find((row) => row.id === ids.codeGameId);
    expect(sold?.soldLast30Days).toBeGreaterThan(0);
    expect(answer.categories.map((row) => row.id)).toContain(sold?.categoryId);
    expect((await client.get('/api/admin/orders/purchase-games')).status).toBe(401);
    const buyer = await customer();
    expect(
      (await client.get('/api/admin/orders/purchase-games', { cookie: buyer.cookie })).status,
    ).toBe(401);
  });
});

describe('POST /api/admin/player-checks (AP8)', () => {
  it('checks with the admin as requester, a paused pack too, and caches the answer', async () => {
    const item = await product(ids.gameId, 'direct', 0.88);
    await test.db.execute(sql`update catalog_products set status = 'paused' where id = ${item.id}`);
    const fields = { player_id: `5${randomBytes(4).readUInt32BE(0) % 100_000_000}` };
    const answer = await json<{ result: string }>(
      await adminPost('/api/admin/player-checks', { productId: item.id, fields }),
      200,
    );
    expect(answer.result).toBe('valid');
    expect(recorded.at(-1)).toMatchObject({ operation: 'validate_player' });
    const rows = await test.db
      .select({ adminId: playerChecks.adminId, customerId: playerChecks.customerId })
      .from(playerChecks)
      .where(eq(playerChecks.adminId, admin.id));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.customerId === null)).toBe(true);
    // A customer never reaches it.
    const buyer = await customer();
    expect(
      (
        await client.post('/api/admin/player-checks', {
          cookie: buyer.cookie,
          body: { productId: item.id, fields },
        })
      ).status,
    ).toBe(401);
  });
});
