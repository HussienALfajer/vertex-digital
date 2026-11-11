import { randomBytes } from 'node:crypto';
import { priceFromCost, ROOT_PRICE_LIST_IDS } from '@vertex-digital/contracts';
import {
  accountBalance,
  applyOutcome,
  catalogCategories,
  customers,
  ensureCustomerWallet,
  ensureSystemAccount,
  findShopCustomerWallet,
  fulfilmentAttempts,
  lockOrder,
  merchantProfiles,
  newId,
  orderCodesKey,
  orders,
  postJournal,
  shopDailyStats,
  supplierBalanceReads,
  supplierOffers,
  suppliers,
  supportTickets,
  transferToShopCustomer,
  transitionOrder,
} from '@vertex-digital/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseEnv } from '../src/core/config/env.js';
import {
  api,
  auditOf,
  cookieHeader,
  emailsTo,
  PASSWORD,
  removeAccounts,
  seedCustomer,
  setSwitches,
  totp,
  uniqueEmail,
} from './helpers.js';
import { startApp, type TestApp } from './start-app.js';

/*
 * Selling in a merchant's shop (S26 PR 2) over HTTP: the public pages at the selling price
 * (PR1–PR4, SH3, SP4), the purchase and the shop customer's orders and codes (PR5–PR12), the
 * merchant's shop orders, statistics and sticker (PR9, SP2, SP3), the admin's compensation
 * (PR10) and shop tickets with escalation (TK1–TK5); with the access cases of every route: no
 * session, a Vertex session on a shop route, another shop's customer, another merchant.
 */

let test: TestApp;
let client: ReturnType<typeof api>;
let admin: Awaited<ReturnType<ReturnType<typeof api>['adminWithTotp']>>;
const seeded: string[] = [];
const categories: string[] = [];
const run = randomBytes(4).toString('hex');
const usd = (dollars: number) => Math.round(dollars * 1_000_000);
const RULE = { percentBp: 1000, fixedUsdUnits: 0, minMarginUsdUnits: usd(0.1) };
const state = {
  fake: '',
  gameId: '',
  gameSlug: `shop-game-${run}`,
  productId: '',
  routeId: '',
  offerId: '',
  price: 0,
  cost: usd(0.88),
};
const key = () => ({ 'idempotency-key': newId() });
/** The merchant's 20% markup over its purchase price (the retail list here), up to whole cents. */
const sell = () => Math.ceil((state.price * 1.2) / 10_000) * 10_000;

async function json<T = Record<string, unknown>>(response: Response, status: number): Promise<T> {
  const text = await response.text();
  expect(response.status, text).toBe(status);
  return (text ? JSON.parse(text) : {}) as T;
}

const send = (method: string, path: string, cookie: string, payload?: unknown, headers = {}) =>
  client.request(method, path, { cookie, body: payload, headers });

async function fund(customerId: string, amountUnits: number) {
  await test.db.transaction(async (tx) => {
    await postJournal(tx, {
      idempotencyKey: `test:${newId()}`,
      kind: 'adjustment',
      postings: [
        { accountId: await ensureCustomerWallet(tx, customerId), amountUnits },
        {
          accountId: await ensureSystemAccount(tx, {
            code: 'adjustments:test_funds',
            kind: 'adjustments',
            currency: 'USD',
          }),
          amountUnits: -amountUnits,
        },
      ],
    });
  });
}

/** A merchant on the retail list (its purchase price is the pack's retail price), 20% markup. */
async function merchant() {
  const person = await seedCustomer(test.db);
  seeded.push(person.id);
  await test.db
    .update(customers)
    .set({ accountType: 'merchant', priceListId: ROOT_PRICE_LIST_IDS.retail })
    .where(eq(customers.id, person.id));
  const termsVersionId = newId();
  await test.db.execute(sql`insert into content_page_versions
    (id, page, version, title, body, draft_revision, admin_id)
    values (${termsVersionId}, 'merchant_terms', 1000 + floor(random() * 1e9)::int, 'شروط التاجر',
      'النص', 1, ${newId()})`);
  await test.db.insert(merchantProfiles).values({
    customerId: person.id,
    tradeName: 'محل النور',
    governorate: 'aleppo',
    city: 'اعزاز',
    grantedAt: new Date(Date.now() - 60_000),
    termsVersionId,
  });
  await fund(person.id, usd(100));
  const cookie = await client.signInCustomer(person.email);
  await json(
    await send('PUT', '/api/merchant/selling-settings', cookie, {
      markupBp: 2_000,
      sypStepUnits: null,
    }),
    200,
  );
  return { ...person, cookie };
}

/** A merchant with an approved shop. */
async function shopFor() {
  const owner = await merchant();
  const slug = `t${randomBytes(5).toString('hex')}`;
  const shop = await json<{ id: string }>(
    await send(
      'POST',
      '/api/merchant/shop',
      owner.cookie,
      { slug, brandColor: '#1f7a6c', rateMode: 'store' },
      key(),
    ),
    201,
  );
  await json(
    await send('POST', `/api/admin/shops/${shop.id}/approve`, admin.cookie, {
      limits: {
        customerBalanceCapUsdUnits: usd(200),
        dailyTransferCapUsdUnits: usd(1_000),
        customerLimit: 2_000,
      },
    }),
    200,
  );
  return { owner, slug, shopId: shop.id };
}

type Shop = Awaited<ReturnType<typeof shopFor>>;

/** A shop customer the merchant created, signed in from the invitation, with `funds`. */
async function customerOf(context: Shop, funds = usd(20)) {
  const email = uniqueEmail('shop');
  const row = await json<{ id: string }>(
    await send(
      'POST',
      '/api/merchant/shop/customers',
      context.owner.cookie,
      { name: 'سامي علي', email, phone: '0944123456' },
      key(),
    ),
    201,
  );
  const [invitation] = (await emailsTo(test.db, email)).filter(
    (mail) => mail.template === 'shop_customer_invitation',
  );
  const token = (invitation?.params as { token?: string } | undefined)?.token ?? '';
  const accepted = await client.post(`/api/shops/${context.slug}/auth/invitation`, {
    body: { token, password: PASSWORD },
  });
  expect(accepted.status, await accepted.clone().text()).toBe(200);
  if (funds > 0) {
    await test.db.transaction((tx) =>
      transferToShopCustomer(
        tx,
        { send: async () => null },
        {
          shopId: context.shopId,
          merchantId: context.owner.id,
          shopCustomerId: row.id,
          currency: 'usd',
          amountUnits: funds,
          expectedUsdUnits: funds,
          idempotencyKey: newId(),
          actor: { kind: 'customer', id: context.owner.id, channel: 'store' },
        },
      ),
    );
  }
  return { id: row.id, email, cookie: cookieHeader(accepted) };
}

type ShopCustomer = Awaited<ReturnType<typeof customerOf>>;

const purchase = (context: Shop, customer: ShopCustomer, unit = sell(), headers = key()) =>
  send(
    'POST',
    `/api/shops/${context.slug}/orders`,
    customer.cookie,
    {
      productId: state.productId,
      quantity: 1,
      fields: { player_id: '5123456789' },
      expectedUnitSellUsdUnits: unit,
      confirmPlayer: true,
    },
    headers,
  );

async function shopBalance(shopCustomerId: string) {
  const wallet = await findShopCustomerWallet(test.db, shopCustomerId);
  return wallet === null ? 0 : accountBalance(test.db, wallet);
}

async function merchantBalance(merchantId: string) {
  return accountBalance(
    test.db,
    await test.db.transaction((tx) => ensureCustomerWallet(tx, merchantId)),
  );
}

/** Sends the order to the fake supplier and applies its delivery, as the worker does. */
async function deliver(orderId: string) {
  const attemptId = await test.db.transaction(async (tx) => {
    const order = await lockOrder(tx, orderId);
    if (!order) throw new Error('No order');
    const id = newId();
    await tx.insert(fulfilmentAttempts).values({
      id,
      orderId,
      routeId: state.routeId,
      supplierId: state.fake,
      offerId: state.offerId,
      supplierOfferId: 'o-test',
      quantity: order.quantity,
      unitCostUsdUnits: state.cost,
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
      { status: 'delivered', quantity: 1 },
      { by: 'webhook' },
    ),
  );
}

const adminPost = (path: string, body: unknown = {}) =>
  client.post(path, { cookie: admin.cookie, body });
const adminPut = (path: string, body: unknown) => client.put(path, { cookie: admin.cookie, body });

beforeAll(async () => {
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
  state.fake = fake?.id as string;
  await test.db
    .insert(supplierBalanceReads)
    .values({ supplierId: state.fake, currency: 'USD', amountUnits: usd(1_000_000) });
  await json(
    await adminPut('/api/admin/suppliers/fake/credentials', {
      values: { webhookSecret: `whsec-${run}-shops` },
    }),
    200,
  );
  await test.db.execute(
    sql`update supplier_sync_runs set status = 'failed', finished_at = now(), error_code = 'TEST'
        where supplier_id = ${state.fake} and status = 'running'`,
  );
  const category = await json<{ id: string }>(
    await adminPost('/api/admin/catalog/categories', {
      slug: `shops-${run}`,
      nameAr: `متاجر ${run}`,
    }),
    201,
  );
  categories.push(category.id);
  await json(
    await adminPut('/api/admin/pricing/rules', {
      scope: 'category',
      targetId: category.id,
      ...RULE,
    }),
    200,
  );
  const game = await json<{ id: string }>(
    await adminPost('/api/admin/catalog/games', {
      categoryId: category.id,
      slug: state.gameSlug,
      nameAr: `لعبة ${run}`,
      nameEn: 'Game',
    }),
    201,
  );
  state.gameId = game.id;
  await json(
    await adminPost(`/api/admin/catalog/games/${game.id}/fields`, {
      key: 'player_id',
      labelAr: 'المعرف',
      type: 'digits',
      required: true,
      minLength: 5,
    }),
    201,
  );
  const product = await json<{ id: string }>(
    await adminPost(`/api/admin/catalog/games/${game.id}/products`, {
      kind: 'direct',
      nameAr: `باقة ${run}`,
    }),
    201,
  );
  state.productId = product.id;
  const now = new Date();
  const [offer] = await test.db
    .insert(supplierOffers)
    .values({
      supplierId: state.fake,
      offerId: `o-${randomBytes(4).toString('hex')}`,
      name: 'Fake offer',
      kind: 'direct',
      requiredFields: ['playerId'],
      costUsdUnits: state.cost,
      inStock: true,
      costConfirmedAt: now,
      lastSeenAt: now,
    })
    .returning({ id: supplierOffers.id });
  state.offerId = offer?.id as string;
  const routed = await json<{ routes: { id: string }[] }>(
    await adminPost(`/api/admin/catalog/products/${product.id}/routes`, {
      offerId: state.offerId,
      fieldMap: { playerId: 'player_id' },
    }),
    201,
  );
  state.routeId = routed.routes[0]?.id as string;
  state.price = priceFromCost(state.cost, RULE);
  await test.db.execute(sql`update catalog_games set status = 'active' where id = ${game.id}`);
});

afterAll(async () => {
  await test.db
    .update(catalogCategories)
    .set({ archivedAt: new Date() })
    .where(inArray(catalogCategories.id, categories));
  await removeAccounts(test.db, seeded);
  await test.app.close();
});

describe('the public pages (PR1–PR4, SH3, SP1, SP3, SP4)', () => {
  it('shows the game at the selling price only, never the purchase price', async () => {
    const context = await shopFor();
    const response = await client.get(`/api/shops/${context.slug}/games/${state.gameSlug}`);
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    const game = await json<{
      shop: { name: string; brandColor: string; letter: string; logoUrl: string | null };
      products: { id: string; available: boolean; unitSellUsdUnits: number | null }[];
    }>(response, 200);
    expect(game.shop).toMatchObject({ brandColor: '#1f7a6c', logoUrl: null });
    expect(game.products).toContainEqual(
      expect.objectContaining({ id: state.productId, available: true, unitSellUsdUnits: sell() }),
    );
    const text = JSON.stringify(game);
    expect(text).not.toContain('priceUsdUnits');
    expect(text).not.toContain(`:${state.price},`);
    const home = await json<{ categories: { games: { slug: string }[] }[] }>(
      await client.get(`/api/shops/${context.slug}`),
      200,
    );
    expect(home.categories.flatMap((c) => c.games.map((g) => g.slug))).toContain(state.gameSlug);
  });

  it('leaves a hidden game out, answers an old slug with 301 and an unknown one with 404', async () => {
    const context = await shopFor();
    await json(
      await send('PUT', '/api/merchant/shop/hidden-games', context.owner.cookie, {
        gameIds: [state.gameId],
      }),
      200,
    );
    await json(await client.get(`/api/shops/${context.slug}/games/${state.gameSlug}`), 404);
    const renamed = `t${randomBytes(5).toString('hex')}`;
    await json(
      await send('PATCH', `/api/admin/shops/${context.shopId}`, admin.cookie, {
        slug: renamed,
        reason: 'طلب التاجر بتذكرة',
      }),
      200,
    );
    const moved = await fetch(`${test.url}/api/shops/${context.slug}`, { redirect: 'manual' });
    expect(moved.status).toBe(301);
    expect(await moved.json()).toEqual({ slug: renamed });
    await json(await client.get(`/api/shops/nope${randomBytes(4).toString('hex')}`), 404);
  });

  it('serves the manifest and a letter-mark icon, and counts a visit but not a bot', async () => {
    const context = await shopFor();
    const manifest = await json<{ icons: { size: number; url: string }[] }>(
      await client.get(`/api/shops/${context.slug}/manifest`),
      200,
    );
    expect(manifest.icons.map((icon) => icon.size)).toEqual([192, 512]);
    const icon = await client.get(`/api/shops/${context.slug}/icon?size=192`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get('content-type')).toBe('image/png');
    const visit = (agent: string) =>
      client.post(`/api/shops/${context.slug}/visits`, { headers: { 'user-agent': agent } });
    expect((await visit('Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile')).status).toBe(204);
    expect((await visit('Googlebot/2.1')).status).toBe(204);
    const [stats] = await test.db
      .select()
      .from(shopDailyStats)
      .where(eq(shopDailyStats.shopId, context.shopId));
    expect(stats?.visits).toBe(1);
  });
});

describe('the purchase and the orders (PR5–PR12)', () => {
  it('charges the selling price from the shop wallet and replays the same key', async () => {
    const context = await shopFor();
    const customer = await customerOf(context);
    const merchantBefore = await merchantBalance(context.owner.id);
    const headers = key();
    const order = await json<{ id: string; number: string; totalSellUsdUnits: number }>(
      await purchase(context, customer, sell(), headers),
      201,
    );
    expect(order.totalSellUsdUnits).toBe(sell());
    const again = await json<{ id: string }>(
      await purchase(context, customer, sell(), headers),
      200,
    );
    expect(again.id).toBe(order.id);
    expect(await shopBalance(customer.id)).toBe(usd(20) - sell());
    expect(await merchantBalance(context.owner.id)).toBe(merchantBefore);
    const page = await json<{ items: { id: string }[] }>(
      await send('GET', `/api/shops/${context.slug}/orders`, customer.cookie),
      200,
    );
    expect(page.items.map((row) => row.id)).toEqual([order.id]);
    const read = await json<{ unitSellUsdUnits: number }>(
      await send('GET', `/api/shops/${context.slug}/orders/${order.number}`, customer.cookie),
      200,
    );
    expect(read.unitSellUsdUnits).toBe(sell());
    // PR9: the merchant's own orders leave the shop order out.
    await json(await send('GET', `/api/orders/${order.id}`, context.owner.cookie), 404);
    // Nor may the merchant publish a receipt link of it (the shop customer's fields).
    await json(
      await send('PUT', `/api/orders/${order.id}/receipt-link`, context.owner.cookie, {
        playerDisplay: 'full',
      }),
      404,
    );
    const mine = await json<{ items: { id: string }[] }>(
      await send('GET', '/api/orders', context.owner.cookie),
      200,
    );
    expect(mine.items.map((row) => row.id)).not.toContain(order.id);
    expect((await auditOf(test.db, order.id)).map((entry) => entry.action)).toContain(
      'shop.order_paid',
    );
  });

  it('refuses another price, an empty wallet, and other sessions', async () => {
    const context = await shopFor();
    const customer = await customerOf(context, usd(0.5));
    const changed = await json<{ code: string; details: { unitPriceUsdUnits: number } }>(
      await purchase(context, customer, sell() + 10_000),
      409,
    );
    expect(changed).toMatchObject({
      code: 'PRICE_CHANGED',
      details: { unitPriceUsdUnits: sell() },
    });
    expect((await json<{ code: string }>(await purchase(context, customer), 409)).code).toBe(
      'INSUFFICIENT_BALANCE',
    );
    // No session, a Vertex session, another shop's customer: 401.
    const other = await shopFor();
    const stranger = await customerOf(other, 0);
    const vertex = await seedCustomer(test.db);
    seeded.push(vertex.id);
    const vertexCookie = await client.signInCustomer(vertex.email);
    for (const cookie of ['', vertexCookie, stranger.cookie]) {
      await json(await purchase(context, { ...customer, cookie }), 401);
      await json(await send('GET', `/api/shops/${context.slug}/orders`, cookie), 401);
    }
  });

  it("keeps another customer's order and codes out of reach", async () => {
    const context = await shopFor();
    const buyer = await customerOf(context);
    const other = await customerOf(context, 0);
    const order = await json<{ number: string }>(await purchase(context, buyer), 201);
    await json(
      await send('GET', `/api/shops/${context.slug}/orders/${order.number}`, other.cookie),
      404,
    );
    await json(
      await send(
        'POST',
        `/api/shops/${context.slug}/orders/${order.number}/codes/${newId()}/reveal`,
        buyer.cookie,
      ),
      404,
    );
  });

  it('releases the margin to the merchant on delivery and lists it in the shop orders', async () => {
    const context = await shopFor();
    const customer = await customerOf(context);
    const order = await json<{ id: string }>(await purchase(context, customer), 201);
    const before = await merchantBalance(context.owner.id);
    await deliver(order.id);
    expect(await merchantBalance(context.owner.id)).toBe(before + sell() - state.price);
    const rows = await json<{
      items: {
        id: string;
        marginState: string;
        marginUsdUnits: number;
        customer: { id: string };
      }[];
    }>(await send('GET', '/api/merchant/shop/orders', context.owner.cookie), 200);
    expect(rows.items).toEqual([
      expect.objectContaining({
        id: order.id,
        marginState: 'released',
        marginUsdUnits: sell() - state.price,
        customer: expect.objectContaining({ id: customer.id }),
      }),
    ]);
    const stats = await json<{ totals: { orders: number; marginReleasedUsdUnits: number } }>(
      await send('GET', '/api/merchant/shop/stats?period=today', context.owner.cookie),
      200,
    );
    expect(stats.totals).toMatchObject({ orders: 1, marginReleasedUsdUnits: sell() - state.price });
    // Another merchant without a shop, and no session.
    const outsider = await merchant();
    await json(await send('GET', '/api/merchant/shop/orders', outsider.cookie), 404);
    await json(await send('GET', '/api/merchant/shop/stats', ''), 401);
  });

  it('compensates a delivered order: Vertex’s part and the margin back from the merchant', async () => {
    const context = await shopFor();
    const customer = await customerOf(context);
    const order = await json<{ id: string }>(await purchase(context, customer), 201);
    await deliver(order.id);
    const before = await merchantBalance(context.owner.id);
    const path = `/api/admin/orders/${order.id}/shop-compensation`;
    const body = { units: 1, reason: 'الكود لا يعمل', marginFrom: 'merchant' };
    const headers = key();
    const compensation = await json<{ vertexUsdUnits: number; marginUsdUnits: number }>(
      await send('POST', path, admin.cookie, body, headers),
      201,
    );
    expect(compensation).toMatchObject({
      vertexUsdUnits: state.price,
      marginUsdUnits: sell() - state.price,
    });
    await json(await send('POST', path, admin.cookie, body, headers), 200);
    expect(await merchantBalance(context.owner.id)).toBe(before - (sell() - state.price));
    expect(await shopBalance(customer.id)).toBe(usd(20));
    expect(
      (await json<{ code: string }>(await send('POST', path, admin.cookie, body, key()), 409)).code,
    ).toBe('ORDER_NOT_COMPENSABLE');
    // A customer session on an admin route is 401.
    await json(await send('POST', path, context.owner.cookie, body, key()), 401);
  });

  it('downloads the sticker as a PNG, 20 an hour', async () => {
    const context = await shopFor();
    const response = await send(
      'GET',
      '/api/merchant/shop/sticker.png?size=80mm',
      context.owner.cookie,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(1, 4)].map((byte) => String.fromCharCode(byte)).join('')).toBe('PNG');
  });
});

describe('the notification center (PR9)', () => {
  it("lists the shop customer's own notifications and marks them read", async () => {
    const context = await shopFor();
    const customer = await customerOf(context);
    const page = await json<{ items: { id: string; event: string }[]; unreadCount: number }>(
      await send('GET', `/api/shops/${context.slug}/notifications`, customer.cookie),
      200,
    );
    expect(page.items.map((item) => item.event)).toEqual(['transfer_received']);
    expect(page.unreadCount).toBe(1);
    const read = await json<{ unreadCount: number }>(
      await send('POST', `/api/shops/${context.slug}/notifications/read`, customer.cookie, {
        upToId: page.items[0]?.id,
      }),
      200,
    );
    expect(read.unreadCount).toBe(0);
    await json(await send('GET', `/api/shops/${context.slug}/notifications`, ''), 401);
  });
});

describe('shop tickets (TK1–TK5)', () => {
  const formOf = (fields: Record<string, string>) => {
    const data = new FormData();
    for (const [name, value] of Object.entries(fields)) data.append(name, value);
    return data;
  };

  const open = async (context: Shop, customer: ShopCustomer) =>
    client.request('POST', `/api/shops/${context.slug}/tickets`, {
      cookie: customer.cookie,
      form: formOf({ category: 'other', subject: 'سؤال عن الشحن', body: 'متى يصل الشحن؟' }),
      headers: { ...key(), ...(await client.altcha()) },
    });

  it('goes to the merchant first, who replies; the customer escalates only after 24 hours', async () => {
    const context = await shopFor();
    const customer = await customerOf(context, 0);
    const ticket = await json<{ id: string; canEscalate: boolean; lastReplier: string }>(
      await open(context, customer),
      201,
    );
    expect(ticket).toMatchObject({ canEscalate: false, lastReplier: 'customer' });
    const queue = await json<{ items: { id: string; unanswered: boolean }[] }>(
      await send('GET', '/api/merchant/shop/tickets', context.owner.cookie),
      200,
    );
    expect(queue.items).toEqual([expect.objectContaining({ id: ticket.id, unanswered: true })]);
    const early = await json<{ code: string }>(
      await send(
        'POST',
        `/api/shops/${context.slug}/tickets/${ticket.id}/escalate`,
        customer.cookie,
      ),
      409,
    );
    expect(early.code).toBe('TICKET_ESCALATION_TOO_EARLY');
    // 24 hours without a reply: the customer may ask for the admin.
    await test.db
      .update(supportTickets)
      .set({ lastCustomerMessageAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where(eq(supportTickets.id, ticket.id));
    const escalated = await json<{ escalatedAt: string | null }>(
      await send(
        'POST',
        `/api/shops/${context.slug}/tickets/${ticket.id}/escalate`,
        customer.cookie,
      ),
      200,
    );
    expect(escalated.escalatedAt).not.toBeNull();
    const replied = await json<{ messages: { from: string }[] }>(
      await client.request('POST', `/api/merchant/shop/tickets/${ticket.id}/messages`, {
        cookie: context.owner.cookie,
        form: formOf({ body: 'سيصل خلال دقائق' }),
        headers: key(),
      }),
      201,
    );
    expect(replied.messages.map((message) => message.from)).toEqual(['customer', 'shop']);
    const seen = await json<{ messages: { from: string }[] }>(
      await send('GET', `/api/shops/${context.slug}/tickets/${ticket.id}`, customer.cookie),
      200,
    );
    expect(seen.messages.map((message) => message.from)).toEqual(['customer', 'shop']);
    expect((await auditOf(test.db, ticket.id)).map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['ticket.opened', 'ticket.escalated', 'ticket.merchant_replied']),
    );
  });

  it("keeps another shop's merchant and customer, and the admin's queue, away from it", async () => {
    const context = await shopFor();
    const customer = await customerOf(context, 0);
    const ticket = await json<{ id: string }>(await open(context, customer), 201);
    const other = await shopFor();
    await json(
      await send('GET', `/api/merchant/shop/tickets/${ticket.id}`, other.owner.cookie),
      404,
    );
    const stranger = await customerOf(other, 0);
    await json(
      await send('GET', `/api/shops/${other.slug}/tickets/${ticket.id}`, stranger.cookie),
      404,
    );
    await json(await send('GET', `/api/admin/support/tickets/${ticket.id}`, admin.cookie), 404);
    const [row] = await test.db
      .select({ customerId: supportTickets.customerId })
      .from(supportTickets)
      .where(and(eq(supportTickets.id, ticket.id)));
    expect(row?.customerId).toBeNull();
  });
});

describe('a purchase as a shop order of the merchant', () => {
  it('stores the merchant as the customer and the shop customer as the buyer', async () => {
    const context = await shopFor();
    const customer = await customerOf(context);
    const order = await json<{ id: string }>(await purchase(context, customer), 201);
    const [row] = await test.db.select().from(orders).where(eq(orders.id, order.id));
    expect(row).toMatchObject({ customerId: context.owner.id, shopCustomerId: customer.id });
  });
});
