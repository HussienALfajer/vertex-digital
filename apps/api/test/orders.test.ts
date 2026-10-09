import { randomBytes, randomUUID } from 'node:crypto';
import { ORDER_POLICY_DEFAULTS, priceFromCost, QUEUES } from '@vertex-digital/contracts';
import {
  catalogCategories,
  ensureCustomerWallet,
  ensureSystemAccount,
  fulfilmentAttempts,
  lockOrder,
  newId,
  postJournal,
  supplierBalanceReads,
  supplierOffers,
  supplierSyncRuns,
  suppliers,
  supplierWebhookEvents,
  transitionOrder,
} from '@vertex-digital/db';
import {
  FAKE_SIGNATURE_HEADER,
  FAKE_TIMESTAMP_HEADER,
  hmacSha256,
} from '@vertex-digital/suppliers';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  api,
  auditOf,
  body,
  notificationsOf,
  PASSWORD,
  removeAccounts,
  seedCustomer,
  setSwitches,
  totp,
} from './helpers.js';
import { startApp, type TestApp } from './start-app.js';

/*
 * Orders (S08) over HTTP against the test database with the `fake` supplier: the purchase, the
 * customer's orders and code reveals, the admin's list, decisions and policy, and the supplier
 * webhook intake. The worker's routing (PR 2) is played by writing an attempt as `orders.fulfil`
 * will. Categories are archived and the switches and policy put back in `afterAll`; orders and
 * ledger rows stay (never deleted, by design).
 */

let test: TestApp;
let client: ReturnType<typeof api>;
let admin: Awaited<ReturnType<ReturnType<typeof api>['adminWithTotp']>>;
const seeded: string[] = [];
const categories: string[] = [];
const run = randomBytes(4).toString('hex');
const usd = (dollars: number) => Math.round(dollars * 1_000_000);
const RULE = { percentBp: 1000, fixedUsdUnits: 0, minMarginUsdUnits: usd(0.1) };
const SECRET = `whsec-${run}-orders`;
const ids = { fake: '', gameId: '', codeGameId: '' };

interface Item {
  id: string;
  price: number;
  routeId: string;
  offerId: string;
  cost: number;
}

async function reauthenticate() {
  const response = await client.post('/api/admin/me/reauthenticate', {
    cookie: admin.cookie,
    body: { password: PASSWORD, totpCode: totp(admin.secret) },
  });
  expect(response.status).toBe(200);
}

async function json<T = Record<string, unknown>>(response: Response, status: number): Promise<T> {
  const payload = await response.json();
  expect(response.status, JSON.stringify(payload)).toBe(status);
  return payload as T;
}

const adminGet = (path: string) => client.get(path, { cookie: admin.cookie });
const adminPost = (path: string, payload?: unknown, headers?: Record<string, string>) =>
  client.post(path, { cookie: admin.cookie, body: payload, ...(headers && { headers }) });

async function game(slug: string) {
  const created = await json<{ id: string }>(
    await adminPost('/api/admin/catalog/games', {
      categoryId: categories[0],
      slug,
      nameAr: `لعبة ${slug}`,
      nameEn: 'Game',
    }),
    201,
  );
  return created.id;
}

/** A product of `gameId` routed to a fake offer at `cost`, priced by the category's rule. */
async function product(gameId: string, kind: 'direct' | 'code', cost: number): Promise<Item> {
  // The panel adds products to a paused game here: an active one needs its cover (rule CT3).
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
  const route = await json<{ routes: { id: string }[] }>(
    await adminPost(`/api/admin/catalog/products/${created.id}/routes`, {
      offerId: offer?.id,
      fieldMap: kind === 'direct' ? { playerId: 'player_id' } : {},
    }),
    201,
  );
  await test.db.execute(sql`update catalog_games set status = 'active' where id = ${gameId}`);
  return {
    id: created.id,
    price: priceFromCost(usd(cost), RULE),
    routeId: route.routes[0]?.id as string,
    offerId: offer?.id as string,
    cost: usd(cost),
  };
}

async function buyer(funds = usd(100)) {
  const customer = await seedCustomer(test.db);
  seeded.push(customer.id);
  await test.db.transaction(async (tx) => {
    await postJournal(tx, {
      idempotencyKey: `test:${newId()}`,
      kind: 'adjustment',
      postings: [
        { accountId: await ensureCustomerWallet(tx, customer.id), amountUnits: funds },
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
  return { ...customer, cookie: await client.signInCustomer(customer.email) };
}

type Buyer = Awaited<ReturnType<typeof buyer>>;

const purchase = (
  who: Buyer,
  item: Item,
  overrides: Record<string, unknown> = {},
  key: string = randomUUID(),
) =>
  client.post('/api/orders', {
    cookie: who.cookie,
    headers: { 'idempotency-key': key },
    body: {
      productId: item.id,
      quantity: 1,
      fields: { player_id: '5123456789' },
      expectedUnitPriceUsdUnits: item.price,
      ...overrides,
    },
  });

const balance = async (who: Buyer) =>
  (
    await json<{ balanceUnits: number }>(
      await client.get('/api/wallet', { cookie: who.cookie }),
      200,
    )
  ).balanceUnits;

/** Sends the order to its route as `orders.fulfil` will (PR 2): an attempt `sending`. */
async function send(orderId: string, item: Item, supplier = ids.fake) {
  return test.db.transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (!order) throw new Error('No order');
    const id = newId();
    await tx.insert(fulfilmentAttempts).values({
      id,
      orderId,
      routeId: item.routeId,
      supplierId: supplier,
      offerId: item.offerId,
      supplierOfferId: 'o-test',
      quantity: order.quantity - order.deliveredQuantity,
      unitCostUsdUnits: item.cost,
      status: 'sending',
      candidates: [],
      sentAt: new Date(),
    });
    await transitionOrder(tx, order, 'sent_to_supplier', { actor: 'system', attemptId: id });
    return id;
  });
}

/** Holds the order for the admin, as the sweep will past the hard limit (rule F7). */
const hold = (orderId: string) =>
  test.db.transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (!order) throw new Error('No order');
    await transitionOrder(tx, order, 'needs_review', { actor: 'system', reason: 'hard_limit' });
  });

beforeAll(async () => {
  test = await startApp();
  client = api(test.url);
  admin = await client.adminWithTotp(test.db);
  seeded.push(admin.id);
  await reauthenticate();
  await setSwitches(test.db);
  const [fake] = await test.db.select().from(suppliers).where(eq(suppliers.code, 'fake'));
  ids.fake = fake?.id as string;
  await test.db
    .insert(supplierBalanceReads)
    .values({ supplierId: ids.fake, currency: 'USD', amountUnits: usd(1_000_000) });
  await json(
    await client.put('/api/admin/suppliers/fake/credentials', {
      cookie: admin.cookie,
      body: { values: { webhookSecret: SECRET } },
    }),
    200,
  );
  // New keys start a sync (S07 rule SP2) that no worker runs here: end it, so the suppliers
  // tests' one-a-minute check (rule SY1) never meets it.
  await test.db
    .update(supplierSyncRuns)
    .set({ status: 'failed', finishedAt: new Date(), errorCode: 'TEST' })
    .where(and(eq(supplierSyncRuns.supplierId, ids.fake), eq(supplierSyncRuns.status, 'running')));
  const category = await json<{ id: string }>(
    await adminPost('/api/admin/catalog/categories', {
      slug: `ord-${run}`,
      nameAr: `طلبات ${run}`,
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
  ids.gameId = await game(`ord-pubg-${run}`);
  ids.codeGameId = await game(`ord-gift-${run}`);
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
  // Games are active in tests through the database: the panel asks for a cover first (CT3).
  await test.db.execute(
    sql`update catalog_games set status = 'active' where id in (${ids.gameId}, ${ids.codeGameId})`,
  );
});

afterAll(async () => {
  await test.db
    .update(catalogCategories)
    .set({ archivedAt: new Date() })
    .where(inArray(catalogCategories.id, categories));
  await setSwitches(test.db);
  await reauthenticate();
  await client.put('/api/admin/orders/policy', {
    cookie: admin.cookie,
    body: ORDER_POLICY_DEFAULTS,
  });
  await removeAccounts(test.db, seeded);
  await test.app.close();
});

describe('POST /api/orders (rules O1–O6)', () => {
  it('pays from the wallet and answers the order, never cached; a replay answers 200', async () => {
    const item = await product(ids.gameId, 'direct', 0.88);
    const customer = await buyer(usd(10));
    const key = randomUUID();
    const response = await purchase(customer, item, {}, key);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const order = await json<{ id: string; number: string; stage: string; fields: unknown }>(
      response,
      201,
    );
    expect(order).toMatchObject({
      stage: 'processing',
      quantity: 1,
      totalUsdUnits: item.price,
      fields: [{ key: 'player_id', labelAr: 'المعرف', value: '5123456789' }],
      codes: [],
    });
    expect(await balance(customer)).toBe(usd(10) - item.price);
    const replay = await json<{ id: string }>(await purchase(customer, item, {}, key), 200);
    expect(replay.id).toBe(order.id);
    expect(await balance(customer)).toBe(usd(10) - item.price);
    expect(
      await body(
        await purchase(customer, item, { quantity: 1, fields: { player_id: '99999' } }, key),
      ),
    ).toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    const entries = await json<{ items: { kind: string; order: unknown }[] }>(
      await client.get('/api/wallet/entries', { cookie: customer.cookie }),
      200,
    );
    expect(entries.items[0]).toMatchObject({
      kind: 'purchase',
      order: { id: order.id, number: order.number },
    });
    expect((await auditOf(test.db, order.id)).map((entry) => entry.action)).toEqual(['order.paid']);
  });

  it('buys once for one key sent twice at once, and never overdraws in parallel', async () => {
    const item = await product(ids.gameId, 'direct', 0.88);
    const customer = await buyer(item.price * 2);
    const key = randomUUID();
    const statuses = await Promise.all([
      purchase(customer, item, {}, key),
      purchase(customer, item, {}, key),
    ]);
    expect(statuses.map((r) => r.status).sort()).toEqual([200, 201]);
    const results = await Promise.all(Array.from({ length: 3 }, () => purchase(customer, item)));
    const codes = await Promise.all(results.map(async (r) => (await body(r)).code ?? r.status));
    expect(codes.sort()).toEqual([201, 'INSUFFICIENT_BALANCE', 'INSUFFICIENT_BALANCE']);
    expect(await balance(customer)).toBe(0);
  });

  it('refuses a stopped store, a changed price, an unavailable product and bad fields', async () => {
    const item = await product(ids.gameId, 'direct', 0.88);
    const customer = await buyer(usd(10));
    await setSwitches(test.db, { purchases_stopped: true });
    expect(await body(await purchase(customer, item))).toMatchObject({
      status: 409,
      code: 'PURCHASES_STOPPED',
    });
    await setSwitches(test.db);
    expect(
      await body(
        await purchase(customer, item, { expectedUnitPriceUsdUnits: item.price + 10_000 }),
      ),
    ).toMatchObject({
      status: 409,
      code: 'PRICE_CHANGED',
      details: { unitPriceUsdUnits: item.price },
    });
    expect(
      await body(await purchase(customer, item, { fields: { player_id: '12' } })),
    ).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      details: { fields: { player_id: 'too_small' } },
    });
    expect(await body(await purchase(customer, item, { quantity: 2 }))).toMatchObject({
      status: 400,
      details: { fields: { quantity: 'too_big' } },
    });
    await test.db.execute(sql`update catalog_products set status = 'paused' where id = ${item.id}`);
    expect(await body(await purchase(customer, item))).toMatchObject({
      status: 409,
      code: 'PRODUCT_UNAVAILABLE',
      details: { availability: 'paused' },
    });
    expect(await body(await purchase(customer, { ...item, id: randomUUID() }))).toMatchObject({
      status: 404,
    });
    const missing = await client.post('/api/orders', {
      cookie: customer.cookie,
      body: { productId: item.id, quantity: 1, fields: {}, expectedUnitPriceUsdUnits: item.price },
    });
    expect(await body(missing)).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    expect(await balance(customer)).toBe(usd(10));
  });

  it('limits purchases to 10 per 10 minutes per customer', async () => {
    const item = await product(ids.gameId, 'direct', 0.88);
    const customer = await buyer(usd(10));
    const key = randomUUID();
    for (let index = 0; index < 10; index += 1) await purchase(customer, item, {}, key);
    expect(await body(await purchase(customer, item, {}, key))).toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
    });
  });

  it('needs a signed-in customer, and refuses the admin session', async () => {
    const item = await product(ids.gameId, 'direct', 0.88);
    expect((await client.post('/api/orders', { body: {} })).status).toBe(401);
    expect((await client.get('/api/orders')).status).toBe(401);
    expect((await client.get('/api/orders', { cookie: admin.cookie })).status).toBe(401);
    expect(item.id).toBeTruthy();
  });
});

describe("the customer's orders and codes (rules O13, C2)", () => {
  it("lists the customer's own orders, hides other customers' and reveals codes once logged", async () => {
    const item = await product(ids.codeGameId, 'code', 9.6);
    const customer = await buyer();
    const order = await json<{ id: string }>(
      await purchase(customer, item, { quantity: 2, fields: {} }),
      201,
    );
    const attemptId = await send(order.id, item);
    // The admin confirms the manual-like delivery with two codes (rule D2).
    await test.db.transaction(async (tx) => {
      const locked = await lockOrder(tx, order.id);
      if (!locked) throw new Error('No order');
      await transitionOrder(tx, locked, 'needs_review', { actor: 'system', reason: 'hard_limit' });
    });
    await reauthenticate();
    const resolved = await json<{ status: string }>(
      await adminPost(
        `/api/admin/orders/${order.id}/attempts/${attemptId}/resolve`,
        {
          outcome: 'delivered',
          quantity: 2,
          codes: ['GIFT-AAAA-BBBB-0001', 'GIFT-AAAA-BBBB-0002'],
          reason: 'سلّمت يدوياً',
        },
        { 'idempotency-key': randomUUID() },
      ),
      200,
    );
    expect(resolved.status).toBe('delivered');

    const page = await json<{ items: { id: string; stage: string }[]; nextCursor: null }>(
      await client.get('/api/orders', { cookie: customer.cookie }),
      200,
    );
    expect(page.items).toEqual([expect.objectContaining({ id: order.id, stage: 'delivered' })]);
    const view = await client.get(`/api/orders/${order.id}`, { cookie: customer.cookie });
    expect(view.headers.get('cache-control')).toBe('no-store');
    const detail = await json<{ codes: { id: string; masked: string; firstRevealedAt: null }[] }>(
      view,
      200,
    );
    expect(JSON.stringify(detail)).not.toContain('GIFT-AAAA');
    expect(detail.codes.map((code) => code.masked)).toEqual(['••••••0001', '••••••0002']);

    const stranger = await buyer();
    expect((await client.get(`/api/orders/${order.id}`, { cookie: stranger.cookie })).status).toBe(
      404,
    );
    const codeId = detail.codes[0]?.id as string;
    const revealPath = `/api/orders/${order.id}/codes/${codeId}/reveal`;
    expect((await client.post(revealPath, { cookie: stranger.cookie })).status).toBe(404);
    const revealed = await json<{ code: string; firstRevealedAt: string }>(
      await client.post(revealPath, { cookie: customer.cookie }),
      200,
    );
    expect(revealed.code).toBe('GIFT-AAAA-BBBB-0001');
    const again = await json<{ firstRevealedAt: string }>(
      await client.post(revealPath, { cookie: customer.cookie }),
      200,
    );
    expect(again.firstRevealedAt).toBe(revealed.firstRevealedAt);
    expect((await client.get('/api/orders/not-a-uuid', { cookie: customer.cookie })).status).toBe(
      404,
    );
    expect((await notificationsOf(test.db, customer.id)).map((n) => n.event)).toContain(
      'order_delivered',
    );

    // The admin sees it masked and reveals it with a re-authentication; the audit has no code.
    const adminView = await json<{ codes: { reveals: unknown[] }[] }>(
      await adminGet(`/api/admin/orders/${order.id}`),
      200,
    );
    expect(adminView.codes[0]?.reveals).toHaveLength(2);
    await reauthenticate();
    const shown = await json<{ code: string }>(
      await adminPost(`/api/admin/orders/${order.id}/codes/${codeId}/reveal`),
      200,
    );
    expect(shown.code).toBe('GIFT-AAAA-BBBB-0001');
    const audit = await auditOf(test.db, order.id);
    expect(audit.map((entry) => entry.action)).toContain('order.code_revealed');
    expect(JSON.stringify(audit)).not.toContain('GIFT-AAAA');
  });
});

describe("the admin's decisions (rules D1–D5)", () => {
  it('needs a re-authentication, and refuses a customer session on admin routes', async () => {
    const item = await product(ids.gameId, 'direct', 0.88);
    const customer = await buyer();
    const order = await json<{ id: string }>(await purchase(customer, item), 201);
    expect((await client.get('/api/admin/orders', { cookie: customer.cookie })).status).toBe(401);
    expect((await client.get('/api/admin/orders')).status).toBe(401);
    // Five minutes after the last re-authentication, as the panel would be.
    await test.db.execute(
      sql`update admin_sessions set reauthenticated_at = now() - interval '6 minutes' where user_id = ${admin.id}`,
    );
    for (const [path, payload] of [
      [`/api/admin/orders/${order.id}/refund`, { reason: 'تجربة الاسترداد' }],
      [`/api/admin/orders/${order.id}/attempts/${randomUUID()}/poll`, { reason: 'تجربة السؤال' }],
    ] as const) {
      expect(
        await body(await adminPost(path, payload, { 'idempotency-key': randomUUID() })),
      ).toMatchObject({
        status: 403,
        code: 'REAUTHENTICATION_REQUIRED',
      });
    }
    expect(
      await body(
        await client.put('/api/admin/orders/policy', {
          cookie: admin.cookie,
          body: ORDER_POLICY_DEFAULTS,
        }),
      ),
    ).toMatchObject({ code: 'REAUTHENTICATION_REQUIRED' });
  });

  it('refunds a held order once, and refuses a paid one', async () => {
    const item = await product(ids.gameId, 'direct', 0.88);
    const customer = await buyer(usd(10));
    const order = await json<{ id: string }>(await purchase(customer, item), 201);
    await reauthenticate();
    const key = randomUUID();
    expect(
      await body(
        await adminPost(
          `/api/admin/orders/${order.id}/refund`,
          { reason: 'لا جواب من المورد' },
          { 'idempotency-key': key },
        ),
      ),
    ).toMatchObject({ status: 409, code: 'ORDER_NOT_DECIDABLE' });
    const attemptId = await send(order.id, item);
    await hold(order.id);
    const counts = await json<{ needsReview: number }>(
      await adminGet('/api/admin/orders/counts'),
      200,
    );
    expect(counts.needsReview).toBeGreaterThanOrEqual(1);
    const refund = () =>
      adminPost(
        `/api/admin/orders/${order.id}/refund`,
        { reason: 'لا جواب من المورد' },
        { 'idempotency-key': key },
      );
    const [first, second] = await Promise.all([refund(), refund()]);
    expect([first.status, second.status]).toEqual([200, 200]);
    const refunded = await json<{
      status: string;
      refundReason: string;
      attempts: { id: string; status: string; resolvedBy: string }[];
    }>(await adminGet(`/api/admin/orders/${order.id}`), 200);
    expect(refunded).toMatchObject({ status: 'refunded', refundReason: 'admin' });
    expect(refunded.attempts[0]).toMatchObject({
      id: attemptId,
      status: 'failed',
      resolvedBy: 'admin',
    });
    expect(await balance(customer)).toBe(usd(10));
    expect(
      await body(
        await adminPost(
          `/api/admin/orders/${order.id}/refund`,
          { reason: 'مرة ثانية' },
          { 'idempotency-key': randomUUID() },
        ),
      ),
    ).toMatchObject({ code: 'ORDER_NOT_DECIDABLE' });
    expect((await auditOf(test.db, order.id)).map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['order.refunded', 'order.refund_decided']),
    );
  });

  it('confirms failed, polls again, and refuses a closed attempt or a wrong code count', async () => {
    const item = await product(ids.gameId, 'direct', 0.88);
    const customer = await buyer();
    const order = await json<{ id: string }>(await purchase(customer, item), 201);
    const attemptId = await send(order.id, item);
    await reauthenticate();
    const resolvePath = `/api/admin/orders/${order.id}/attempts/${attemptId}/resolve`;
    // Open but automatic and not held: not the admin's yet (rule D1).
    expect(
      await body(
        await adminPost(
          resolvePath,
          { outcome: 'failed', reason: 'فشل مؤكد' },
          { 'idempotency-key': randomUUID() },
        ),
      ),
    ).toMatchObject({ status: 409, code: 'ATTEMPT_NOT_RESOLVABLE' });
    await hold(order.id);
    expect(
      await json(
        await adminPost(`/api/admin/orders/${order.id}/attempts/${attemptId}/poll`, {
          reason: 'اسأل المورد',
        }),
        202,
      ),
    ).toMatchObject({ status: 'needs_review' });
    const { rows } = await test.db.execute<{ n: number }>(
      sql`select count(*)::int as n from pgboss.job where name = ${QUEUES.ordersPoll} and data->>'attemptId' = ${attemptId}`,
    );
    expect(rows[0]?.n).toBeGreaterThanOrEqual(1);
    expect(
      await body(
        await adminPost(
          resolvePath,
          { outcome: 'delivered', quantity: 1, codes: ['X'], reason: 'سلّمت' },
          { 'idempotency-key': randomUUID() },
        ),
      ),
    ).toMatchObject({ status: 400, code: 'CODES_COUNT_MISMATCH' });
    const key = randomUUID();
    const failed = await json<{ status: string; attempts: { status: string }[] }>(
      await adminPost(
        resolvePath,
        { outcome: 'failed', reason: 'فشل مؤكد من المورد' },
        { 'idempotency-key': key },
      ),
      200,
    );
    expect(failed.attempts[0]?.status).toBe('failed');
    const replay = await adminPost(
      resolvePath,
      { outcome: 'failed', reason: 'فشل مؤكد من المورد' },
      { 'idempotency-key': key },
    );
    expect(replay.status).toBe(200);
    expect(
      await body(
        await adminPost(
          resolvePath,
          { outcome: 'failed', reason: 'مرة ثانية' },
          { 'idempotency-key': randomUUID() },
        ),
      ),
    ).toMatchObject({ code: 'ATTEMPT_NOT_RESOLVABLE' });
  });

  it('lists by tab and number, and changes the policy with its audit entry', async () => {
    const item = await product(ids.gameId, 'direct', 0.88);
    const customer = await buyer();
    const order = await json<{ id: string; number: string }>(await purchase(customer, item), 201);
    const page = await json<{
      items: { id: string; customer: { isTest: boolean } }[];
      total: number;
    }>(await adminGet(`/api/admin/orders?q=${order.number.toLowerCase()}`), 200);
    expect(page).toMatchObject({ total: 1, items: [{ id: order.id }] });
    const active = await json<{ items: { id: string }[] }>(
      await adminGet(`/api/admin/orders?tab=active&productId=${item.id}`),
      200,
    );
    expect(active.items.map((row) => row.id)).toEqual([order.id]);
    expect((await adminGet('/api/admin/orders?tab=nope')).status).toBe(400);
    expect((await adminGet(`/api/admin/orders/${randomUUID()}`)).status).toBe(404);

    await reauthenticate();
    const policy = { ...ORDER_POLICY_DEFAULTS, hardLimitMinutes: 5 };
    expect(
      await json(
        await client.put('/api/admin/orders/policy', { cookie: admin.cookie, body: policy }),
        200,
      ),
    ).toEqual(policy);
    expect(await json(await adminGet('/api/admin/orders/policy'), 200)).toEqual(policy);
    expect(
      (
        await client.put('/api/admin/orders/policy', {
          cookie: admin.cookie,
          body: { ...policy, hardLimitMinutes: 1 },
        })
      ).status,
    ).toBe(400);
  });
});

describe('supplier webhooks (rule F4)', () => {
  const signed = (payload: object, secret = SECRET, at = Date.now()) => {
    const raw = JSON.stringify(payload);
    const timestamp = Math.floor(at / 1000).toString();
    return {
      raw,
      headers: {
        'content-type': 'application/json',
        [FAKE_TIMESTAMP_HEADER]: timestamp,
        [FAKE_SIGNATURE_HEADER]: hmacSha256(secret, `${timestamp}.${raw}`),
      },
    };
  };
  const deliver = (raw: string, headers: Record<string, string>, code = 'fake') =>
    fetch(`${test.url}/api/webhooks/suppliers/${code}`, { method: 'POST', headers, body: raw });

  it('stores a signed event once, encrypted, and queues it; a replay does nothing', async () => {
    const eventId = `evt-${randomUUID()}`;
    const { raw, headers } = signed({
      eventId,
      idempotencyKey: randomUUID(),
      supplierOrderId: 'f-1',
      status: 'delivered',
      quantity: 1,
      codes: ['SECRET-CODE-1234'],
    });
    expect((await deliver(raw, headers)).status).toBe(200);
    expect((await deliver(raw, headers)).status).toBe(200);
    const stored = await test.db
      .select()
      .from(supplierWebhookEvents)
      .where(
        and(
          eq(supplierWebhookEvents.supplierId, ids.fake),
          eq(supplierWebhookEvents.eventId, eventId),
        ),
      );
    expect(stored).toHaveLength(1);
    expect(stored[0]?.bodyCiphertext.includes(Buffer.from('SECRET-CODE'))).toBe(false);
    const { rows } = await test.db.execute<{ n: number }>(
      sql`select count(*)::int as n from pgboss.job where name = ${QUEUES.suppliersWebhook} and data->>'eventId' = ${stored[0]?.id as string}`,
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('refuses a bad signature, an old timestamp, an unknown supplier and a body over 64 KB', async () => {
    const payload = {
      eventId: `evt-${randomUUID()}`,
      idempotencyKey: randomUUID(),
      supplierOrderId: 'f',
      status: 'failed',
    };
    const wrong = signed(payload, 'not-the-secret');
    expect(await body(await deliver(wrong.raw, wrong.headers))).toMatchObject({
      status: 401,
      code: 'WEBHOOK_SIGNATURE_INVALID',
    });
    const old = signed(payload, SECRET, Date.now() - 10 * 60 * 1000);
    expect((await deliver(old.raw, old.headers)).status).toBe(401);
    const tampered = signed(payload);
    expect(
      (await deliver(tampered.raw.replace('failed', 'delivered'), tampered.headers)).status,
    ).toBe(401);
    const good = signed(payload);
    expect((await deliver(good.raw, good.headers, 'manual')).status).toBe(404);
    expect((await deliver(good.raw, good.headers, 'nope')).status).toBe(404);
    const big = signed({ ...payload, padding: 'x'.repeat(70 * 1024) });
    expect((await deliver(big.raw, big.headers)).status).toBe(413);
    const stored = await test.db
      .select()
      .from(supplierWebhookEvents)
      .where(eq(supplierWebhookEvents.eventId, payload.eventId));
    expect(stored).toEqual([]);
  });
});
