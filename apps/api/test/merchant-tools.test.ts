import { randomBytes, randomUUID } from 'node:crypto';
import { markupPrice, WATCHES_MAX } from '@vertex-digital/contracts';
import {
  catalogCategories,
  customers,
  ensureCustomerWallet,
  ensureSystemAccount,
  merchantProfiles,
  newId,
  postJournal,
  priceLists,
  supplierBalanceReads,
  supplierOffers,
  supplierSyncRuns,
  suppliers,
} from '@vertex-digital/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RatesService } from '../src/modules/rates/index.js';
import { api, PASSWORD, removeAccounts, seedCustomer, setSwitches, totp } from './helpers.js';
import { startApp, type TestApp } from './start-app.js';

/*
 * The merchant area (S21 PR 1) over HTTP against the test database with the `fake` supplier:
 * access (MA1), selling settings and prices (SP1–SP3), the sale row of a purchase (SP4), the
 * dashboard (DB1–DB5), follows (AL1) and alert settings (AL5, AL6). The panel's tiers (S23) are
 * in `merchant-tiers.test.ts`. The category is archived in `afterAll`.
 */

let test: TestApp;
let client: ReturnType<typeof api>;
let admin: Awaited<ReturnType<ReturnType<typeof api>['adminWithTotp']>>;
const seeded: string[] = [];
const run = randomBytes(4).toString('hex');
const usd = (dollars: number) => Math.round(dollars * 1_000_000);
const ids = { fake: '', categoryId: '', gameId: '', slug: `mt-pubg-${run}` };
let item: { id: string };

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

const adminSend = (method: string, path: string, payload?: unknown, cookie = admin.cookie) =>
  client.request(method, path, { cookie, body: payload });
const send = (method: string, path: string, cookie: string, payload?: unknown) =>
  client.request(method, path, { cookie, body: payload });

/** A product of the test game routed to a fake offer at `costUsd`. */
async function product(costUsd: number) {
  await test.db.execute(sql`update catalog_games set status = 'paused' where id = ${ids.gameId}`);
  const created = await json<{ id: string }>(
    await adminSend('POST', `/api/admin/catalog/games/${ids.gameId}/products`, {
      kind: 'direct',
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
      kind: 'direct',
      requiredFields: ['playerId'],
      costUsdUnits: usd(costUsd),
      inStock: true,
      costConfirmedAt: now,
      lastSeenAt: now,
    })
    .returning({ id: supplierOffers.id });
  await json(
    await adminSend('POST', `/api/admin/catalog/products/${created.id}/routes`, {
      offerId: offer?.id,
      fieldMap: { playerId: 'player_id' },
    }),
    201,
  );
  await test.db.execute(sql`update catalog_games set status = 'active' where id = ${ids.gameId}`);
  return created;
}

/** A merchant who accepted the terms, with `funds` in the wallet. */
async function merchant(funds = usd(100)) {
  const person = await seedCustomer(test.db);
  seeded.push(person.id);
  await test.db
    .update(customers)
    .set({ accountType: 'merchant' })
    .where(eq(customers.id, person.id));
  // A merchant terms version of its own, accepted (MT2): purchases need one.
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
    grantedAt: new Date(),
    termsVersionId,
  });
  if (funds > 0) {
    await test.db.transaction(async (tx) => {
      await postJournal(tx, {
        idempotencyKey: `test:${newId()}`,
        kind: 'adjustment',
        postings: [
          { accountId: await ensureCustomerWallet(tx, person.id), amountUnits: funds },
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
  return { ...person, cookie: await client.signInCustomer(person.email) };
}

interface PriceRow {
  productId: string;
  purchaseUsdUnits: number | null;
  ownPrice: { currency: string; amountUnits: number } | null;
  sellingUsdUnits: number | null;
  sellingSypUnits: number | null;
  source: string;
  belowCost: boolean;
}

const pricesOf = async (cookie: string) =>
  json<{ settings: unknown; storeStepUnits: number; products: PriceRow[] }>(
    await client.get(`/api/merchant/selling-prices?gameId=${ids.gameId}`, { cookie }),
    200,
  );

const rowOf = async (cookie: string, productId: string) =>
  (await pricesOf(cookie)).products.find((row) => row.productId === productId) as PriceRow;

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
    await adminSend('PUT', '/api/admin/suppliers/fake/credentials', {
      values: { webhookSecret: `whsec-${run}-tools` },
    }),
    200,
  );
  await test.db
    .update(supplierSyncRuns)
    .set({ status: 'failed', finishedAt: new Date(), errorCode: 'TEST' })
    .where(and(eq(supplierSyncRuns.supplierId, ids.fake), eq(supplierSyncRuns.status, 'running')));
  const category = await json<{ id: string }>(
    await adminSend('POST', '/api/admin/catalog/categories', {
      slug: `mt-${run}`,
      nameAr: `أدوات ${run}`,
    }),
    201,
  );
  ids.categoryId = category.id;
  const game = await json<{ id: string }>(
    await adminSend('POST', '/api/admin/catalog/games', {
      categoryId: category.id,
      slug: ids.slug,
      nameAr: `ببجي ${run}`,
      nameEn: 'PUBG',
    }),
    201,
  );
  ids.gameId = game.id;
  await json(
    await adminSend('POST', `/api/admin/catalog/games/${game.id}/fields`, {
      key: 'player_id',
      labelAr: 'المعرف',
      type: 'digits',
      required: true,
      minLength: 5,
    }),
    201,
  );
  item = await product(1);
});

afterAll(async () => {
  await test.db
    .update(priceLists)
    .set({ archivedAt: new Date() })
    .where(and(eq(priceLists.kind, 'custom'), isNull(priceLists.archivedAt)));
  await test.db
    .update(catalogCategories)
    .set({ archivedAt: new Date() })
    .where(eq(catalogCategories.id, ids.categoryId));
  await setSwitches(test.db);
  await removeAccounts(test.db, seeded);
  await test.app.close();
});

describe('access (S21 MA1, "Access")', () => {
  it('refuses strangers, customers, the admin on merchant routes and a frozen merchant’s writes', async () => {
    expect((await client.get('/api/merchant/dashboard')).status).toBe(401);
    expect((await client.get('/api/merchant/dashboard', { cookie: admin.cookie })).status).toBe(
      401,
    );
    const person = await seedCustomer(test.db);
    seeded.push(person.id);
    const cookie = await client.signInCustomer(person.email);
    for (const path of [
      '/api/merchant/dashboard',
      '/api/merchant/selling-settings',
      '/api/merchant/watches',
      '/api/merchant/alerts',
      '/api/merchant/alert-settings',
      `/api/merchant/selling-prices?gameId=${ids.gameId}`,
    ]) {
      expect(await json(await client.get(path, { cookie }), 403), path).toMatchObject({
        code: 'NOT_MERCHANT',
      });
    }

    const shop = await merchant(0);
    await test.db.update(customers).set({ frozenAt: new Date() }).where(eq(customers.id, shop.id));
    // A frozen merchant reads, never writes (MA1).
    await json(await client.get('/api/merchant/selling-settings', { cookie: shop.cookie }), 200);
    expect(
      await json(
        await send('PUT', '/api/merchant/selling-settings', shop.cookie, {
          markupBp: 1000,
          sypStepUnits: null,
        }),
        403,
      ),
    ).toMatchObject({ code: 'ACCOUNT_FROZEN' });
  });
});

describe('selling prices (S21 SP1–SP4)', () => {
  it('prices packs by markup or their own price, marks a price below cost', async () => {
    const shop = await merchant();
    const empty = await rowOf(shop.cookie, item.id);
    expect(empty).toMatchObject({ source: 'none', sellingUsdUnits: null, belowCost: false });
    const purchase = empty.purchaseUsdUnits as number;
    expect(purchase).toBeGreaterThan(0);

    expect(
      await json(
        await send('PUT', '/api/merchant/selling-settings', shop.cookie, {
          markupBp: 1000,
          sypStepUnits: 50_000,
        }),
        200,
      ),
    ).toEqual({ markupBp: 1000, sypStepUnits: 50_000 });
    expect(await rowOf(shop.cookie, item.id)).toMatchObject({
      source: 'markup',
      sellingUsdUnits: markupPrice(purchase, 1000),
    });

    const own = await json<PriceRow>(
      await send('PUT', `/api/merchant/selling-prices/${item.id}`, shop.cookie, {
        currency: 'usd',
        amountUnits: usd(0.5),
      }),
      200,
    );
    expect(own).toMatchObject({ source: 'product', sellingUsdUnits: usd(0.5), belowCost: true });
    expect(
      await json(
        await send('PUT', `/api/merchant/selling-prices/${item.id}`, shop.cookie, {
          currency: 'usd',
          amountUnits: usd(0.505),
        }),
        400,
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(
      await json(
        await send('PUT', `/api/merchant/selling-prices/${randomUUID()}`, shop.cookie, {
          currency: 'usd',
          amountUnits: usd(1),
        }),
        404,
      ),
    ).toMatchObject({ code: 'NOT_FOUND' });
    const cleared = await json<PriceRow>(
      await send('DELETE', `/api/merchant/selling-prices/${item.id}`, shop.cookie),
      200,
    );
    expect(cleared).toMatchObject({ source: 'markup', ownPrice: null });

    // Another merchant's prices are their own.
    const other = await merchant(0);
    expect((await rowOf(other.cookie, item.id)).source).toBe('none');
    expect(
      await json(
        await client.get(`/api/merchant/selling-prices?gameId=${randomUUID()}`, {
          cookie: shop.cookie,
        }),
        404,
      ),
    ).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('snapshots the selling price on a purchase and counts it on the dashboard (SP4, DB3)', async () => {
    const shop = await merchant(usd(10));
    await json(
      await send('PUT', '/api/merchant/selling-settings', shop.cookie, {
        markupBp: 2000,
        sypStepUnits: null,
      }),
      200,
    );
    const purchase = (await rowOf(shop.cookie, item.id)).purchaseUsdUnits as number;
    const order = await json<{ id: string }>(
      await client.post('/api/orders', {
        cookie: shop.cookie,
        headers: { 'idempotency-key': randomUUID() },
        body: {
          productId: item.id,
          quantity: 1,
          fields: { player_id: '5123456789' },
          expectedUnitPriceUsdUnits: purchase,
          confirmPlayer: true,
        },
      }),
      201,
    );
    const [sale] = (
      await test.db.execute<{ unit_usd_units: string; source: string }>(
        sql`select unit_usd_units, source from merchant_order_sales where order_id = ${order.id}`,
      )
    ).rows;
    expect(sale).toEqual({
      unit_usd_units: String(markupPrice(purchase, 2000)),
      source: 'markup',
    });

    const dashboard = await json<Record<string, unknown>>(
      await client.get('/api/merchant/dashboard?period=month', { cookie: shop.cookie }),
      200,
    );
    expect(dashboard).toMatchObject({
      period: 'month',
      spendingUsdUnits: purchase,
      balanceUsdUnits: usd(10) - purchase,
      // Not delivered yet: no sale counted (DB2).
      salesUsdUnits: 0,
      ordersWithoutSale: 0,
      sellingConfigured: true,
    });
  });
});

describe('follows and alert settings (S21 AL1, AL5, AL6)', () => {
  it('saves follows, suggests the games of followed packs, and caps them at 200', async () => {
    const shop = await merchant(0);
    const saved = await json<{
      games: unknown[];
      products: { productId: string }[];
      suggestions: { games: { gameId: string }[] };
    }>(
      await send('PUT', '/api/merchant/watches', shop.cookie, {
        gameIds: [],
        productIds: [item.id],
      }),
      200,
    );
    expect(saved.products.map((row) => row.productId)).toEqual([item.id]);
    expect(saved.suggestions.games.map((row) => row.gameId)).toEqual([ids.gameId]);
    const games = await json<{ games: { gameId: string }[] }>(
      await send('PUT', '/api/merchant/watches', shop.cookie, {
        gameIds: [ids.gameId],
        productIds: [],
      }),
      200,
    );
    expect(games.games.map((row) => row.gameId)).toEqual([ids.gameId]);
    expect(
      await json(
        await send('PUT', '/api/merchant/watches', shop.cookie, {
          gameIds: [randomUUID()],
          productIds: [],
        }),
        404,
      ),
    ).toMatchObject({ code: 'NOT_FOUND' });
    const many = Array.from({ length: WATCHES_MAX }, () => randomUUID());
    expect(
      await json(
        await send('PUT', '/api/merchant/watches', shop.cookie, {
          gameIds: many,
          productIds: [item.id],
        }),
        409,
      ),
    ).toMatchObject({ code: 'WATCHES_LIMIT_REACHED' });
    expect(
      await json(await client.get('/api/merchant/alerts', { cookie: shop.cookie }), 200),
    ).toEqual({ items: [], nextCursor: null });
  });

  it('saves the low-balance threshold and re-arms the alert when it changes', async () => {
    const shop = await merchant(0);
    expect(
      await json(await client.get('/api/merchant/alert-settings', { cookie: shop.cookie }), 200),
    ).toEqual({ lowBalanceUsdUnits: null, dailyEmail: false });
    await json(
      await send('PUT', '/api/merchant/alert-settings', shop.cookie, {
        lowBalanceUsdUnits: usd(20),
        dailyEmail: true,
      }),
      200,
    );
    await test.db.execute(
      sql`update merchant_alert_settings set low_balance_alerted_at = now() where customer_id = ${shop.id}`,
    );
    await json(
      await send('PUT', '/api/merchant/alert-settings', shop.cookie, {
        lowBalanceUsdUnits: usd(30),
        dailyEmail: true,
      }),
      200,
    );
    const [row] = (
      await test.db.execute<{ alerted: string | null }>(
        sql`select low_balance_alerted_at as alerted from merchant_alert_settings where customer_id = ${shop.id}`,
      )
    ).rows;
    expect(row?.alerted).toBeNull();
    expect(
      await json(
        await send('PUT', '/api/merchant/alert-settings', shop.cookie, {
          lowBalanceUsdUnits: usd(0.5),
          dailyEmail: false,
        }),
        400,
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('the merchant area after audit A06', () => {
  it('A06-34: refuses a revoked merchant on the tools routes', async () => {
    const shop = await merchant(0);
    expect(
      (await client.get('/api/merchant/dashboard?period=month', { cookie: shop.cookie })).status,
    ).toBe(200);
    await test.db
      .update(customers)
      .set({ accountType: 'customer' })
      .where(eq(customers.id, shop.id));
    await test.db
      .update(merchantProfiles)
      .set({ revokedAt: new Date() })
      .where(eq(merchantProfiles.customerId, shop.id));
    for (const path of [
      '/api/merchant/dashboard?period=month',
      `/api/merchant/selling-prices?gameId=${ids.gameId}`,
      '/api/merchant/watches',
    ]) {
      expect(await json(await client.get(path, { cookie: shop.cookie }), 403), path).toMatchObject({
        code: 'NOT_MERCHANT',
      });
    }
    expect(
      await json(
        await send('PUT', `/api/merchant/selling-prices/${item.id}`, shop.cookie, {
          currency: 'usd',
          amountUnits: usd(2),
        }),
        403,
      ),
    ).toMatchObject({ code: 'NOT_MERCHANT' });
  });

  it('A06-41: refuses a SYP selling price without a rate as such, not as above $10,000', async () => {
    const shop = await merchant(0);
    const rate = vi.spyOn(RatesService.prototype, 'current').mockResolvedValue(null);
    const refused = await json<{ details: { path: string[]; message: string }[] }>(
      await send('PUT', `/api/merchant/selling-prices/${item.id}`, shop.cookie, {
        currency: 'syp',
        amountUnits: 20_000_00,
      }),
      400,
    );
    rate.mockRestore();
    expect(refused.details).toEqual([
      { path: ['currency'], message: 'No exchange rate in force to convert a SYP price at' },
    ]);
  });
});
