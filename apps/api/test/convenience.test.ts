import { randomBytes, randomUUID } from 'node:crypto';
import { ORDER_POLICY_DEFAULTS, priceFromCost } from '@vertex-digital/contracts';
import {
  applyOutcome,
  catalogCategories,
  checkouts,
  customerRateLimits,
  ensureCustomerWallet,
  ensureSystemAccount,
  fulfilmentAttempts,
  lockOrder,
  newId,
  orderCodesKey,
  orders,
  postJournal,
  savedPlayerHash,
  savedPlayers,
  supplierBalanceReads,
  supplierOffers,
  supplierSyncRuns,
  suppliers,
  transitionOrder,
} from '@vertex-digital/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseEnv } from '../src/core/config/env.js';
import {
  api,
  auditOf,
  PASSWORD,
  removeAccounts,
  seedCustomer,
  setSwitches,
  totp,
} from './helpers.js';
import { startApp, type TestApp } from './start-app.js';

/*
 * S10 over HTTP against the test database with the `fake` supplier: saved player ids, the
 * checkout, gifts, receipt and gift links, the public share pages and images, the admin's view
 * and revocation, and the wallet's checkout entry. Delivery is played by writing an attempt and
 * its outcome as the worker will. Categories are archived and the switches put back in
 * `afterAll`; orders and ledger rows stay (never deleted, by design).
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
const PLAYER = { player_id: '51234568' };

interface Item {
  id: string;
  price: number;
  routeId: string;
  offerId: string;
  cost: number;
}

async function json<T = Record<string, unknown>>(response: Response, status: number): Promise<T> {
  const payload = await response.json();
  expect(response.status, JSON.stringify(payload)).toBe(status);
  return payload as T;
}

const adminPost = (path: string, payload?: unknown) =>
  client.post(path, { cookie: admin.cookie, body: payload });

async function product(gameId: string, kind: 'direct' | 'code', cost: number): Promise<Item> {
  await test.db.execute(sql`update catalog_games set status = 'paused' where id = ${gameId}`);
  const created = await json<{ id: string }>(
    await adminPost(`/api/admin/catalog/games/${gameId}/products`, {
      kind,
      nameAr: `باقة ${randomBytes(3).toString('hex')}`,
      maxQuantity: 5,
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

async function buyer(funds = usd(100), options: { isTest?: boolean } = {}) {
  const customer = await seedCustomer(test.db, options);
  seeded.push(customer.id);
  if (funds > 0) {
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
  }
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
      fields: PLAYER,
      expectedUnitPriceUsdUnits: item.price,
      confirmPlayer: true,
      ...overrides,
    },
  });

const line = (item: Item, overrides: Record<string, unknown> = {}) => ({
  productId: item.id,
  quantity: 1,
  fields: PLAYER,
  expectedUnitPriceUsdUnits: item.price,
  confirmPlayer: true,
  ...overrides,
});

const checkout = (who: Buyer, lines: unknown[], key: string = randomUUID()) =>
  client.post('/api/checkouts', {
    cookie: who.cookie,
    headers: { 'idempotency-key': key },
    body: { lines },
  });

const balance = async (who: Buyer) =>
  (
    await json<{ balanceUnits: number }>(
      await client.get('/api/wallet', { cookie: who.cookie }),
      200,
    )
  ).balanceUnits;

/** Sends the order and applies the supplier's answer, as the worker's jobs will. */
async function settle(
  orderId: string,
  item: Item,
  outcome: Parameters<typeof applyOutcome>[3],
): Promise<void> {
  const attemptId = await test.db.transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (!order) throw new Error('No order');
    const id = newId();
    await tx.insert(fulfilmentAttempts).values({
      id,
      orderId,
      routeId: item.routeId,
      supplierId: ids.fake,
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
  await test.db.transaction((tx) =>
    applyOutcome(
      tx,
      {
        jobs: { send: async () => null },
        codesKey: orderCodesKey(parseEnv().ORDER_CODES_SECRET as string),
        now: new Date(),
      },
      attemptId,
      outcome,
      { by: 'supplier' },
    ),
  );
}

const tokenOf = (url: string) => url.split('/').at(-1) as string;

beforeAll(async () => {
  test = await startApp();
  client = api(test.url);
  admin = await client.adminWithTotp(test.db);
  seeded.push(admin.id);
  await setSwitches(test.db);
  const [fake] = await test.db.select().from(suppliers).where(eq(suppliers.code, 'fake'));
  ids.fake = fake?.id as string;
  await test.db
    .insert(supplierBalanceReads)
    .values({ supplierId: ids.fake, currency: 'USD', amountUnits: usd(1_000_000) });
  const reauth = await client.post('/api/admin/me/reauthenticate', {
    cookie: admin.cookie,
    body: { password: PASSWORD, totpCode: totp(admin.secret) },
  });
  expect(reauth.status).toBe(200);
  await json(
    await client.put('/api/admin/suppliers/fake/credentials', {
      cookie: admin.cookie,
      body: { values: { webhookSecret: `whsec-${run}-s10` } },
    }),
    200,
  );
  await test.db
    .update(supplierSyncRuns)
    .set({ status: 'failed', finishedAt: new Date(), errorCode: 'TEST' })
    .where(and(eq(supplierSyncRuns.supplierId, ids.fake), eq(supplierSyncRuns.status, 'running')));
  const category = await json<{ id: string }>(
    await adminPost('/api/admin/catalog/categories', { slug: `s10-${run}`, nameAr: `سلة ${run}` }),
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
  for (const [key, slug] of [
    ['gameId', `s10-pubg-${run}`],
    ['codeGameId', `s10-gift-${run}`],
  ] as const) {
    ids[key] = (
      await json<{ id: string }>(
        await adminPost('/api/admin/catalog/games', {
          categoryId: category.id,
          slug,
          nameAr: `لعبة ${slug}`,
          nameEn: 'Game',
        }),
        201,
      )
    ).id;
  }
  await json(
    await adminPost(`/api/admin/catalog/games/${ids.gameId}/fields`, {
      key: 'player_id',
      labelAr: 'معرّف اللاعب',
      type: 'digits',
      required: true,
      minLength: 5,
    }),
    201,
  );
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
  await client.put('/api/admin/orders/policy', {
    cookie: admin.cookie,
    body: ORDER_POLICY_DEFAULTS,
  });
  await removeAccounts(test.db, seeded);
  await test.app.close();
});

describe('saved player ids (S10 F14, rules SP1–SP7)', () => {
  it('saves with a purchase, lists, renames and deletes only the customer’s own', async () => {
    const item = await product(ids.gameId, 'direct', 0.88);
    const customer = await buyer();
    const created = await json<{ savedPlayer: Record<string, unknown> | null }>(
      await purchase(customer, item, { savePlayer: { label: 'حسابي' } }),
      201,
    );
    expect(created.savedPlayer).toMatchObject({
      gameId: ids.gameId,
      label: 'حسابي',
      fields: PLAYER,
      fieldLabels: { player_id: 'معرّف اللاعب' },
      playerName: null,
      rejected: false,
      complete: true,
      gameShown: true,
    });
    const id = created.savedPlayer?.id as string;
    // Without `savePlayer` the answer has none.
    expect((await json(await purchase(customer, item), 201)).savedPlayer).toBeNull();

    const list = await client.get(`/api/saved-players?gameId=${ids.gameId}`, {
      cookie: customer.cookie,
    });
    expect(list.headers.get('cache-control')).toBe('no-store');
    expect((await json<{ items: { id: string }[] }>(list, 200)).items.map((row) => row.id)).toEqual(
      [id],
    );
    const renamed = await client.patch(`/api/saved-players/${id}`, {
      cookie: customer.cookie,
      body: { label: '  أخي ' },
    });
    expect((await json(renamed, 200)).label).toBe('أخي');
    expect(
      (
        await client.patch(`/api/saved-players/${id}`, {
          cookie: customer.cookie,
          body: { label: 'a‮b' },
        })
      ).status,
    ).toBe(400);

    const other = await buyer(0);
    expect((await client.get('/api/saved-players', { cookie: other.cookie })).status).toBe(200);
    expect(
      (
        await client.patch(`/api/saved-players/${id}`, {
          cookie: other.cookie,
          body: { label: 'x' },
        })
      ).status,
    ).toBe(404);
    expect((await client.delete(`/api/saved-players/${id}`, { cookie: other.cookie })).status).toBe(
      404,
    );
    expect((await client.get('/api/saved-players')).status).toBe(401);
    expect((await client.get('/api/saved-players', { cookie: admin.cookie })).status).toBe(401);
    expect(
      (await client.delete(`/api/saved-players/${id}`, { cookie: customer.cookie })).status,
    ).toBe(204);
    expect(
      (await client.delete(`/api/saved-players/${id}`, { cookie: customer.cookie })).status,
    ).toBe(404);
  });

  it('skips saving at the game’s limit and still buys (SP1, edge case 24)', async () => {
    const item = await product(ids.gameId, 'direct', 0.88);
    const customer = await buyer();
    for (let index = 0; index < 10; index += 1) {
      const fields = { player_id: `9000000${index}` };
      await test.db.insert(savedPlayers).values({
        customerId: customer.id,
        gameId: ids.gameId,
        label: `id ${index}`,
        fields,
        fieldsHash: savedPlayerHash(ids.gameId, fields),
      });
    }
    const order = await json(
      await purchase(customer, item, { savePlayer: { label: 'جديد' } }),
      201,
    );
    expect(order.savedPlayer).toBeNull();
  });

  it('marks an id the supplier refused, clears it on a delivery, and flags changed fields (SP6, SP7)', async () => {
    const item = await product(ids.gameId, 'direct', 0.88);
    const customer = await buyer();
    const first = await json<{ id: string; savedPlayer: { id: string } }>(
      await purchase(customer, item, { savePlayer: { label: 'حسابي' } }),
      201,
    );
    await settle(first.id, item, { status: 'failed', reason: 'bad id', inputRejected: true });
    const saved = async () =>
      (
        await json<{ items: { rejected: boolean; complete: boolean }[] }>(
          await client.get(`/api/saved-players?gameId=${ids.gameId}`, { cookie: customer.cookie }),
          200,
        )
      ).items[0];
    expect(await saved()).toMatchObject({ rejected: true, complete: true });
    const second = await json<{ id: string }>(await purchase(customer, item), 201);
    await settle(second.id, item, { status: 'delivered', quantity: 1 });
    expect((await saved())?.rejected).toBe(false);
    // A row whose values no longer validate is incomplete (SP7).
    await test.db
      .update(savedPlayers)
      .set({ fields: { player_id: '12' } })
      .where(eq(savedPlayers.id, first.savedPlayer.id));
    expect((await saved())?.complete).toBe(false);
  });
});

describe('POST /api/checkouts (S10 F16, rules CT5–CT9)', () => {
  it('pays every line at once, answers the orders, replays the key and lists the checkout', async () => {
    const [a, b] = [
      await product(ids.gameId, 'direct', 0.88),
      await product(ids.codeGameId, 'code', 4.5),
    ];
    const customer = await buyer(usd(20));
    const key = randomUUID();
    const lines = [
      line(a, { gift: { senderName: 'أحمد', message: 'كل عام وأنت بخير' } }),
      line(b, { fields: {}, quantity: 2 }),
    ];
    const response = await checkout(customer, lines, key);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const paid = await json<{
      id: string;
      totalUsdUnits: number;
      orders: { id: string; checkoutId: string; isGift: boolean }[];
    }>(response, 201);
    const total = a.price + b.price * 2;
    expect(paid.totalUsdUnits).toBe(total);
    expect(paid.orders.map((order) => [order.checkoutId, order.isGift])).toEqual([
      [paid.id, true],
      [paid.id, false],
    ]);
    expect(await balance(customer)).toBe(usd(20) - total);
    // The purchase limit counted one request (CT9).
    const [limit] = await test.db
      .select()
      .from(customerRateLimits)
      .where(eq(customerRateLimits.key, `order:customer:${customer.id}`));
    expect(limit?.count).toBe(1);
    // A replay answers 200 with the same checkout; another body is refused.
    const replay = await json<{ id: string }>(await checkout(customer, lines, key), 200);
    expect(replay.id).toBe(paid.id);
    expect((await json(await checkout(customer, [line(a)], key), 409)).code).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );

    const view = await json<{
      items: { id: string }[];
      checkout: Record<string, unknown>;
      nextCursor: null;
    }>(await client.get(`/api/orders?checkout=${paid.id}`, { cookie: customer.cookie }), 200);
    expect(view.items.map((order) => order.id)).toEqual(paid.orders.map((order) => order.id));
    expect(view.checkout).toEqual({
      id: paid.id,
      totalUsdUnits: total,
      orderCount: 2,
      finishedAt: null,
    });
    const other = await buyer(0);
    expect(
      (await client.get(`/api/orders?checkout=${paid.id}`, { cookie: other.cookie })).status,
    ).toBe(404);
    expect(
      (await json(await client.get('/api/orders', { cookie: customer.cookie }), 200)).checkout,
    ).toBeNull();

    // One wallet entry names the checkout (W5).
    const entries = await json<{ items: Record<string, unknown>[] }>(
      await client.get('/api/wallet/entries', { cookie: customer.cookie }),
      200,
    );
    expect(entries.items[0]).toMatchObject({
      kind: 'purchase',
      amountUnits: -total,
      order: null,
      checkout: { id: paid.id, orderCount: 2 },
    });
    const adminEntries = await json<{ items: Record<string, unknown>[] }>(
      await client.get(`/api/admin/wallets/${customer.id}/entries`, { cookie: admin.cookie }),
      200,
    );
    expect(adminEntries.items[0]).toMatchObject({ checkout: { id: paid.id, orderCount: 2 } });
  });

  it('refuses the whole cart with each line’s reason, a short balance and a stop', async () => {
    const [a, b] = [
      await product(ids.gameId, 'direct', 0.88),
      await product(ids.codeGameId, 'code', 4.5),
    ];
    const customer = await buyer(usd(20));
    const refused = await json<{ code: string; details: { lines: unknown[] } }>(
      await checkout(customer, [
        line(a),
        line(a, { expectedUnitPriceUsdUnits: a.price + 10_000 }),
        line(b, { fields: {}, gift: {} }),
        line(a, { fields: { player_id: '1' } }),
      ]),
      409,
    );
    expect(refused).toMatchObject({
      code: 'CHECKOUT_REFUSED',
      details: {
        lines: [
          { index: 1, code: 'PRICE_CHANGED', details: { unitPriceUsdUnits: a.price } },
          { index: 2, code: 'VALIDATION_FAILED', details: { gift: 'code_product' } },
          { index: 3, code: 'VALIDATION_FAILED' },
        ],
      },
    });
    expect(await balance(customer)).toBe(usd(20));

    const poor = await buyer(usd(1));
    expect(await json(await checkout(poor, [line(b, { fields: {} })]), 409)).toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
      details: { balanceUnits: usd(1), totalUnits: b.price },
    });
    await setSwitches(test.db, { purchases_stopped: true });
    try {
      expect((await json(await checkout(customer, [line(a)]), 409)).code).toBe('PURCHASES_STOPPED');
    } finally {
      await setSwitches(test.db);
    }
  });

  it('validates the body, needs a verified customer and marks a test customer’s checkout', async () => {
    const item = await product(ids.gameId, 'direct', 0.88);
    const customer = await buyer();
    expect((await checkout(customer, [])).status).toBe(400);
    expect((await checkout(customer, Array(11).fill(line(item)))).status).toBe(400);
    expect(
      (
        await json(
          await checkout(customer, [line(item, { gift: { message: 'اتصل 0933123456' } })]),
          400,
        )
      ).code,
    ).toBe('VALIDATION_FAILED');
    expect(
      (
        await client.post('/api/checkouts', {
          headers: { 'idempotency-key': randomUUID() },
          body: { lines: [line(item)] },
        })
      ).status,
    ).toBe(401);
    // A session whose email stopped being verified (a change of address) cannot pay.
    const unverified = await buyer();
    await test.db.execute(
      sql`update customers set email_verified = false where id = ${unverified.id}`,
    );
    const refused = await checkout(unverified, [line(item)]);
    expect((await json(refused, 403)).code).toBe('EMAIL_NOT_VERIFIED');

    const tester = await buyer(usd(10), { isTest: true });
    const paid = await json<{ id: string }>(await checkout(tester, [line(item)]), 201);
    const [row] = await test.db.select().from(checkouts).where(eq(checkouts.id, paid.id));
    expect(row?.isTest).toBe(true);
  });
});

describe('gifts and share links (S10 rules GF1–GF5, RC1–RC3, SH1–SH5)', () => {
  it('refuses a gift on a code product and texts with links, phones or handles (GF1, GF3)', async () => {
    const code = await product(ids.codeGameId, 'code', 4.5);
    const direct = await product(ids.gameId, 'direct', 0.88);
    const customer = await buyer();
    expect(await json(await purchase(customer, code, { fields: {}, gift: {} }), 400)).toMatchObject(
      { code: 'VALIDATION_FAILED', details: { gift: 'code_product' } },
    );
    for (const message of ['تواصل معي 0933123456', 'زوروا example.com', 'تابعني @ahmad_99']) {
      expect((await json(await purchase(customer, direct, { gift: { message } }), 400)).code).toBe(
        'VALIDATION_FAILED',
      );
    }
  });

  it('makes the gift link at payment, shows only the gift’s data publicly, and revokes it', async () => {
    const item = await product(ids.gameId, 'direct', 0.88);
    const customer = await buyer();
    const order = await json<{
      id: string;
      isGift: boolean;
      gift: unknown;
      shareLinks: { id: string; kind: string; url: string }[];
    }>(
      await purchase(customer, item, { gift: { senderName: 'أحمد', message: 'كل عام وأنت بخير' } }),
      201,
    );
    expect(order.isGift).toBe(true);
    expect(order.gift).toEqual({ senderName: 'أحمد', message: 'كل عام وأنت بخير' });
    const [link] = order.shareLinks;
    expect(link?.kind).toBe('gift');
    expect(link?.url).toMatch(/\/g\/[A-Za-z0-9_-]{22}$/);
    const token = tokenOf(link?.url as string);

    const page = await client.get(`/api/shares/${token}`, { origin: null });
    expect(page.headers.get('cache-control')).toBe('public, max-age=30');
    expect(page.headers.get('set-cookie')).toBeNull();
    const share = await json(page, 200);
    expect(share).toEqual({
      kind: 'gift',
      orderNumber: null,
      game: expect.objectContaining({ nameAr: `لعبة s10-pubg-${run}` }),
      product: expect.objectContaining({ kind: 'direct' }),
      quantity: 1,
      deliveredQuantity: 0,
      stage: 'processing',
      paidAt: expect.any(String),
      finishedAt: null,
      price: null,
      fields: [{ label: 'معرّف اللاعب', value: '••••4568' }],
      gift: { senderName: 'أحمد', message: 'كل عام وأنت بخير' },
    });
    expect(JSON.stringify(share)).not.toContain(customer.email);

    const image = await client.get(`/api/shares/${token}/image?format=square`, { origin: null });
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('cache-control')).toBe('public, max-age=300');
    expect(await sharp(Buffer.from(await image.arrayBuffer())).metadata()).toMatchObject({
      width: 1080,
      height: 1080,
    });
    expect((await client.get(`/api/shares/${token}/image?format=banner`)).status).toBe(400);

    // A live gift link exists; revoking it is final, a new link is a new token (GF4, RC3).
    const giftLink = (who: Buyer = customer) =>
      client.post(`/api/orders/${order.id}/gift-link`, { cookie: who.cookie });
    expect(await json(await giftLink(), 409)).toMatchObject({
      code: 'ORDER_NOT_SHAREABLE',
      details: { reason: 'link_exists' },
    });
    const revoke = (linkId: string, who: Buyer = customer) =>
      client.post(`/api/orders/${order.id}/share-links/${linkId}/revoke`, { cookie: who.cookie });
    const other = await buyer(0);
    expect((await revoke(link?.id as string, other)).status).toBe(404);
    expect((await revoke(link?.id as string)).status).toBe(204);
    expect((await revoke(link?.id as string)).status).toBe(204);
    expect((await client.get(`/api/shares/${token}`)).status).toBe(404);
    expect((await client.get(`/api/shares/${token}/image`)).status).toBe(404);
    expect((await giftLink(other)).status).toBe(404);
    const fresh = await json<{ url: string }>(await giftLink(), 201);
    expect(tokenOf(fresh.url)).not.toBe(token);
    expect((await client.get(`/api/shares/${tokenOf(fresh.url)}`)).status).toBe(200);
    expect((await client.get('/api/shares/not-a-token')).status).toBe(404);
  });

  it('creates and changes a receipt link with its choices, never for a reservation (RC1, RC2)', async () => {
    const item = await product(ids.codeGameId, 'code', 4.5);
    const customer = await buyer(usd(10));
    const order = await json<{ id: string; number: string }>(
      await purchase(customer, item, { fields: {} }),
      201,
    );
    const receipt = (options: Record<string, unknown>, id = order.id) =>
      client.put(`/api/orders/${id}/receipt-link`, { cookie: customer.cookie, body: options });
    const created = await json<{ id: string; url: string; showPrice: boolean }>(
      await receipt({}),
      200,
    );
    expect(created).toMatchObject({ kind: 'receipt', showPrice: true, playerDisplay: 'masked' });
    expect(created.url).toMatch(/\/r\/[A-Za-z0-9_-]{22}$/);
    const token = tokenOf(created.url);
    expect(await json(await client.get(`/api/shares/${token}`), 200)).toMatchObject({
      kind: 'receipt',
      orderNumber: order.number,
      price: { totalUsdUnits: item.price, refundedUsdUnits: 0 },
      fields: [],
      gift: null,
    });
    const changed = await json<{ id: string; url: string }>(
      await receipt({ showPrice: false, playerDisplay: 'full' }),
      200,
    );
    expect(changed.id).toBe(created.id);
    expect(tokenOf(changed.url)).toBe(token);
    expect((await json(await client.get(`/api/shares/${token}`), 200)).price).toBeNull();
    // A gift link needs a gift order.
    expect(
      await json(
        await client.post(`/api/orders/${order.id}/gift-link`, { cookie: customer.cookie }),
        409,
      ),
    ).toMatchObject({ details: { reason: 'not_gift' } });

    const reservation = await json<{ id: string }>(
      await purchase(await buyer(0), item, { fields: {}, whenBalanceShort: 'reserve' }),
      201,
    );
    const poor = await buyer(0);
    expect((await receipt({}, reservation.id)).status).toBe(404);
    const own = await json<{ id: string }>(
      await purchase(poor, item, { fields: {}, whenBalanceShort: 'reserve' }),
      201,
    );
    expect(
      await json(
        await client.put(`/api/orders/${own.id}/receipt-link`, { cookie: poor.cookie, body: {} }),
        409,
      ),
    ).toMatchObject({ code: 'ORDER_NOT_SHAREABLE', details: { reason: 'status' } });
  });

  it('shows the full id on a receipt that chose it, masked otherwise (SH3)', async () => {
    const item = await product(ids.gameId, 'direct', 0.88);
    const customer = await buyer();
    const order = await json<{ id: string }>(await purchase(customer, item), 201);
    const link = await json<{ url: string }>(
      await client.put(`/api/orders/${order.id}/receipt-link`, {
        cookie: customer.cookie,
        body: { playerDisplay: 'full' },
      }),
      200,
    );
    expect((await json(await client.get(`/api/shares/${tokenOf(link.url)}`), 200)).fields).toEqual([
      { label: 'معرّف اللاعب', value: '51234568' },
    ]);
  });

  it('limits public reads to 60 a minute per address (SH5)', async () => {
    const ip = `10.99.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    const statuses: number[] = [];
    for (let index = 0; index < 61; index += 1) {
      statuses.push((await client.get('/api/shares/AAAAAAAAAAAAAAAAAAAAAA', { ip })).status);
    }
    expect(statuses.slice(0, 60).every((status) => status === 404)).toBe(true);
    expect(statuses[60]).toBe(429);
  });
});

describe('admin view and revocation (S10 rules AD1, AD2)', () => {
  it('shows the checkout, the gift and the links, and revokes one with a reason (audited)', async () => {
    const item = await product(ids.gameId, 'direct', 0.88);
    const customer = await buyer();
    const paid = await json<{ id: string; orders: { id: string }[] }>(
      await checkout(customer, [line(item, { gift: { message: 'مبروك' } }), line(item)]),
      201,
    );
    const orderId = paid.orders[0]?.id as string;
    const view = await json<{
      checkout: { id: string; orders: unknown[] };
      gift: unknown;
      shareLinks: { id: string; revokedAt: string | null }[];
    }>(await client.get(`/api/admin/orders/${orderId}`, { cookie: admin.cookie }), 200);
    expect(view.checkout).toMatchObject({ id: paid.id, orderCount: 2 });
    expect(view.checkout.orders).toHaveLength(2);
    expect(view.gift).toEqual({ senderName: null, message: 'مبروك' });
    const linkId = view.shareLinks[0]?.id as string;

    const revoke = (reason: string, cookie = admin.cookie) =>
      client.post(`/api/admin/orders/${orderId}/share-links/${linkId}/revoke`, {
        cookie,
        body: { reason },
      });
    expect((await revoke('abc')).status).toBe(400);
    expect((await revoke('بلاغ احتيال', customer.cookie)).status).toBe(401);
    const after = await json<{ shareLinks: Record<string, unknown>[] }>(
      await revoke('بلاغ احتيال'),
      200,
    );
    expect(after.shareLinks[0]).toMatchObject({
      revokedBy: 'admin',
      revokeReason: 'بلاغ احتيال',
      revokedAt: expect.any(String),
    });
    expect((await revoke('مرة أخرى')).status).toBe(200);
    const entries = (await auditOf(test.db, orderId)).filter(
      (entry) => entry.action === 'order.share_revoked',
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ reason: 'بلاغ احتيال', details: { linkId, kind: 'gift' } });

    // The list finds a checkout's orders by its id, with the badges (AD2).
    const found = await json<{ items: { id: string; checkoutId: string; isGift: boolean }[] }>(
      await client.get(`/api/admin/orders?q=${paid.id}`, { cookie: admin.cookie }),
      200,
    );
    expect(found.items.map((row) => [row.checkoutId, row.isGift]).sort()).toEqual(
      [
        [paid.id, false],
        [paid.id, true],
      ].sort(),
    );
    const [paidAudit] = (await auditOf(test.db, orderId)).filter(
      (entry) => entry.action === 'order.paid',
    );
    expect(paidAudit?.details).toMatchObject({ checkoutId: paid.id, gift: true });
    const [stored] = await test.db.select().from(orders).where(eq(orders.id, orderId));
    expect(stored?.giftMessage).toBe('مبروك');
  });
});
