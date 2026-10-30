import { randomBytes, randomUUID } from 'node:crypto';
import { damascusMonth, previousMonth } from '@vertex-digital/contracts';
import {
  catalogCategories,
  customerRateLimits,
  customers,
  ensureCustomerWallet,
  ensureSystemAccount,
  merchantProfiles,
  newId,
  postJournal,
  supplierBalanceReads,
  supplierOffers,
  supplierSyncRuns,
  suppliers,
} from '@vertex-digital/db';
import { and, eq, sql } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { priceText, renderPriceListImage } from '../src/modules/merchant-tools/price-list-image.js';
import { SupplierAdaptersService } from '../src/modules/suppliers/supplier-adapters.service.js';
import { api, PASSWORD, removeAccounts, seedCustomer, setSwitches, totp } from './helpers.js';
import { startApp, type TestApp } from './start-app.js';

/*
 * The merchant's documents (S21 PR 3) over HTTP against the test database with the `fake`
 * supplier: the price list and its image (PL1–PL3), the statements, a month's statement with its
 * balance equation and its Excel file (ST1–ST3). Supplier calls are spied on, never recorded.
 */

let test: TestApp;
let client: ReturnType<typeof api>;
let admin: Awaited<ReturnType<ReturnType<typeof api>['adminWithTotp']>>;
const seeded: string[] = [];
const run = randomBytes(4).toString('hex');
const usd = (dollars: number) => Math.round(dollars * 1_000_000);
const ids = { fake: '', categoryId: '', gameId: '', slug: `md-pubg-${run}` };
let item: { id: string; nameAr: string };

async function json<T = Record<string, unknown>>(response: Response, status: number): Promise<T> {
  const payload = await response.json();
  expect(response.status, JSON.stringify(payload)).toBe(status);
  return payload as T;
}

const adminSend = (method: string, path: string, payload?: unknown, cookie = admin.cookie) =>
  client.request(method, path, { cookie, body: payload });
const send = (method: string, path: string, cookie: string, payload?: unknown) =>
  client.request(method, path, { cookie, body: payload });

/** A direct pack of the test game routed to a fake offer at `costUsd`. */
async function product(costUsd: number) {
  await test.db.execute(sql`update catalog_games set status = 'paused' where id = ${ids.gameId}`);
  const nameAr = `باقة ${randomBytes(3).toString('hex')}`;
  const created = await json<{ id: string }>(
    await adminSend('POST', `/api/admin/catalog/games/${ids.gameId}/products`, {
      kind: 'direct',
      nameAr,
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
  return { id: created.id, nameAr };
}

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

/** A merchant who accepted the terms, with `funds` in the wallet. */
async function merchant(funds = usd(100)) {
  const person = await seedCustomer(test.db);
  seeded.push(person.id);
  await test.db
    .update(customers)
    .set({ accountType: 'merchant' })
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
  if (funds > 0) await fund(person.id, funds);
  return { ...person, cookie: await client.signInCustomer(person.email) };
}

async function buyer(funds = usd(100)) {
  const person = await seedCustomer(test.db);
  seeded.push(person.id);
  if (funds > 0) await fund(person.id, funds);
  return { ...person, cookie: await client.signInCustomer(person.email) };
}

/** The pack's price for this account (the merchant's list or retail). */
async function priceFor(cookie: string, productId: string): Promise<number> {
  const prices = await json<{ products: { id: string; priceUsdUnits: number | null }[] }>(
    await client.get(`/api/catalog/games/${ids.slug}/prices`, { cookie }),
    200,
  );
  return prices.products.find((row) => row.id === productId)?.priceUsdUnits as number;
}

async function buy(cookie: string, playerId = '5123456789') {
  return json<{ id: string; verificationCode: string; number: string }>(
    await client.post('/api/orders', {
      cookie,
      headers: { 'idempotency-key': randomUUID() },
      body: {
        productId: item.id,
        quantity: 1,
        fields: { player_id: playerId },
        expectedUnitPriceUsdUnits: await priceFor(cookie, item.id),
        confirmPlayer: true,
      },
    }),
    201,
  );
}

beforeAll(async () => {
  test = await startApp();
  client = api(test.url);
  admin = await client.adminWithTotp(test.db);
  seeded.push(admin.id);
  const reauth = await client.post('/api/admin/me/reauthenticate', {
    cookie: admin.cookie,
    body: { password: PASSWORD, totpCode: totp(admin.secret) },
  });
  expect(reauth.status).toBe(200);
  await setSwitches(test.db);
  // A rate of our own: the SYP selling prices are checked against $10,000 at the rate in force,
  // and files of one worker share the rate.
  const rate = await client.post('/api/admin/rates', {
    cookie: admin.cookie,
    body: { sypPerUsd: '13000', displayStepSypUnits: 500, rateConfirmation: '13000' },
  });
  expect(rate.status).toBe(201);
  vi.spyOn(SupplierAdaptersService.prototype, 'recordCall').mockImplementation(async () => {});
  const [fake] = await test.db.select().from(suppliers).where(eq(suppliers.code, 'fake'));
  ids.fake = fake?.id as string;
  await test.db
    .insert(supplierBalanceReads)
    .values({ supplierId: ids.fake, currency: 'USD', amountUnits: usd(1_000_000) });
  await json(
    await adminSend('PUT', '/api/admin/suppliers/fake/credentials', {
      values: { webhookSecret: `whsec-${run}-documents` },
    }),
    200,
  );
  await test.db
    .update(supplierSyncRuns)
    .set({ status: 'failed', finishedAt: new Date(), errorCode: 'TEST' })
    .where(and(eq(supplierSyncRuns.supplierId, ids.fake), eq(supplierSyncRuns.status, 'running')));
  const category = await json<{ id: string }>(
    await adminSend('POST', '/api/admin/catalog/categories', {
      slug: `md-${run}`,
      nameAr: `المستندات ${run}`,
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
  vi.restoreAllMocks();
  await test.db
    .update(catalogCategories)
    .set({ archivedAt: new Date() })
    .where(eq(catalogCategories.id, ids.categoryId));
  await setSwitches(test.db);
  await removeAccounts(test.db, seeded);
  await test.app.close();
});

const month = () => damascusMonth(new Date());

interface ListRow {
  productId: string;
  available: boolean;
  usdUnits: number | null;
  sypUnits: number | null;
}

interface List {
  games: { gameId: string; rows: ListRow[] }[];
  omittedCount: number;
  gameIds: string[];
  tradeName: string;
  imagePages: number;
}

describe('access (S21 MA1, "Access")', () => {
  it('refuses strangers, the admin and customers on the document routes', async () => {
    const routes = [
      '/api/merchant/price-list',
      '/api/merchant/price-list.png',
      '/api/merchant/statements',
      `/api/merchant/statements/${month()}`,
      `/api/merchant/statements/${month()}/export`,
    ];
    const person = await buyer(0);
    for (const path of routes) {
      expect((await client.get(path)).status, path).toBe(401);
      expect((await client.get(path, { cookie: admin.cookie })).status, path).toBe(401);
      expect(await json(await client.get(path, { cookie: person.cookie }), 403)).toMatchObject({
        code: 'NOT_MERCHANT',
      });
    }
  });
});

describe('the price list (S21 PL1–PL3)', () => {
  it('lists selling or purchase prices of the chosen games, and unavailable packs when asked', async () => {
    const shop = await merchant(usd(10));
    await test.db.execute(sql`update catalog_games set status = 'paused' where id = ${ids.gameId}`);
    const off = await json<{ id: string }>(
      await adminSend('POST', `/api/admin/catalog/games/${ids.gameId}/products`, {
        kind: 'direct',
        nameAr: `بلا مسار ${run}`,
      }),
      201,
    );
    await test.db.execute(sql`update catalog_games set status = 'active' where id = ${ids.gameId}`);
    const list = async (query: string) =>
      json<List>(
        await client.get(`/api/merchant/price-list?gameIds=${ids.gameId}${query}`, {
          cookie: shop.cookie,
        }),
        200,
      );
    const rowOf = (result: List, productId: string) =>
      result.games[0]?.rows.find((candidate) => candidate.productId === productId);

    // No selling price yet: the pack is left out and counted (PL2).
    expect(await list('')).toMatchObject({
      games: [],
      omittedCount: 1,
      tradeName: 'محل النور',
      // S23 ID6, RC2: the header's tier line; Bronze prints the logo at its usual size.
      tier: 'bronze',
      largeLogo: false,
      imagePages: 1,
    });

    await json(
      await send('PUT', '/api/merchant/selling-settings', shop.cookie, {
        markupBp: 1_000,
        sypStepUnits: null,
      }),
      200,
    );
    const purchase = await priceFor(shop.cookie, item.id);
    const selling = await list('&currency=both');
    expect(selling.omittedCount).toBe(0);
    expect(rowOf(selling, item.id)?.usdUnits).toBeGreaterThan(purchase);
    expect(rowOf(selling, item.id)?.sypUnits).toBeGreaterThan(0);
    expect(rowOf(selling, off.id)).toBeUndefined();

    const bought = await list('&mode=purchase&unavailable=true');
    expect(rowOf(bought, item.id)).toMatchObject({ available: true, usdUnits: purchase });
    expect(rowOf(bought, off.id)).toMatchObject({
      available: false,
      usdUnits: null,
      sypUnits: null,
    });

    // Without games (owner, 2026-10-30): never the whole catalog, and a follow is no choice.
    const unchosen = async () =>
      json<List>(await client.get('/api/merchant/price-list', { cookie: shop.cookie }), 200);
    await json(
      await send('PUT', '/api/merchant/watches', shop.cookie, {
        gameIds: [ids.gameId],
        productIds: [],
      }),
      200,
    );
    expect(await unchosen()).toMatchObject({ gameIds: [], games: [] });
    // "ألعابك" first.
    await json(
      await send('PUT', '/api/merchant/pinned-games', shop.cookie, { gameIds: [ids.gameId] }),
      200,
    );
    expect((await unchosen()).gameIds).toEqual([ids.gameId]);
    // Else the games the merchant sold lately.
    const seller = await merchant(usd(10));
    await buy(seller.cookie, '5100000066');
    expect(
      (await json<List>(await client.get('/api/merchant/price-list', { cookie: seller.cookie }), 200))
        .gameIds,
    ).toEqual([ids.gameId]);
    expect(
      (await client.get('/api/merchant/price-list?mode=cost', { cookie: shop.cookie })).status,
    ).toBe(400);
  });

  it('renders a 1080 px PNG per 60 packs, 20 an hour (PL3)', async () => {
    const shop = await merchant(usd(10));
    await json(
      await send('PUT', '/api/merchant/selling-settings', shop.cookie, {
        markupBp: 500,
        sypStepUnits: null,
      }),
      200,
    );
    const path = `/api/merchant/price-list.png?gameIds=${ids.gameId}`;
    const image = await client.get(path, { cookie: shop.cookie });
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('cache-control')).toBe('no-store');
    const meta = await sharp(Buffer.from(await image.arrayBuffer())).metadata();
    expect(meta.width).toBe(1080);
    expect(
      await json(await client.get(`${path}&page=2`, { cookie: shop.cookie }), 404),
    ).toMatchObject({ code: 'NOT_FOUND' });
    await test.db
      .update(customerRateLimits)
      .set({ count: 20 })
      .where(eq(customerRateLimits.key, `price-list-image:customer:${shop.id}`));
    expect(await json(await client.get(path, { cookie: shop.cookie }), 429)).toMatchObject({
      code: 'RATE_LIMITED',
    });
  });
});

interface StatementBody {
  openingUsdUnits: number;
  closingUsdUnits: number;
  current: boolean;
  tradeName: string;
  email: string;
  tier: { netPurchasesUsdUnits: number } | null;
  entries: {
    kind: string;
    amountUnits: number;
    balanceAfterUnits: number;
    order: { number: string; fields: { value: string }[] } | null;
  }[];
  totals: { kind: string; count: number; amountUnits: number }[];
}

describe('the statement (S21 ST1–ST3)', () => {
  it('lists the months, balances the month and shows the full player ID, frozen too', async () => {
    const shop = await merchant(usd(10));
    const order = await buy(shop.cookie, '5100000077');
    expect(
      await json(await client.get('/api/merchant/statements', { cookie: shop.cookie }), 200),
    ).toEqual({ items: [{ month: month(), current: true }] });

    // A frozen merchant still reads (Access).
    await test.db.update(customers).set({ frozenAt: new Date() }).where(eq(customers.id, shop.id));
    const statement = await json<StatementBody>(
      await client.get(`/api/merchant/statements/${month()}`, { cookie: shop.cookie }),
      200,
    );
    expect(statement).toMatchObject({
      openingUsdUnits: 0,
      current: true,
      tradeName: 'محل النور',
      email: shop.email,
      // S23 ID9: this month's tier block (no level live here: no next tier).
      tier: { tier: 'bronze', savingsUsdUnits: null },
      // The screen's sales (owner, 2026-10-30): nothing delivered yet, nothing counted.
      sales: { salesUsdUnits: 0, costUsdUnits: 0, profitUsdUnits: 0, ordersWithoutSale: 0 },
    });
    expect(statement.tier?.netPurchasesUsdUnits).toBe(-(statement.entries[1]?.amountUnits ?? 0));
    expect(statement.entries.map((entry) => entry.kind)).toEqual(['adjustment', 'purchase']);
    const paid = statement.entries[1];
    expect(paid?.order).toMatchObject({ number: order.number, fields: [{ value: '5100000077' }] });
    expect(statement.closingUsdUnits).toBe(usd(10) + (paid?.amountUnits ?? 0));
    expect(paid?.balanceAfterUnits).toBe(statement.closingUsdUnits);
    expect(statement.totals).toEqual([
      { kind: 'purchase', count: 1, amountUnits: paid?.amountUnits },
      { kind: 'adjustment', count: 1, amountUnits: usd(10) },
    ]);

    for (const bad of [previousMonth(month()), 'abc', '2999-01']) {
      expect(
        await json(
          await client.get(`/api/merchant/statements/${bad}`, { cookie: shop.cookie }),
          422,
        ),
      ).toMatchObject({ code: 'STATEMENT_MONTH_INVALID' });
    }
  });

  it('exports the month as two right-to-left sheets, text never a formula, 20 an hour (ST3)', async () => {
    const shop = await merchant(usd(5));
    await test.db
      .update(merchantProfiles)
      .set({ tradeName: '=HYPERLINK("http://x")' })
      .where(eq(merchantProfiles.customerId, shop.id));
    await buy(shop.cookie, '5100000088');
    const path = `/api/merchant/statements/${month()}/export`;
    const file = await client.get(path, { cookie: shop.cookie });
    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toBe(
      `attachment; filename="statement-${month()}.xlsx"`,
    );
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      Buffer.from(await file.arrayBuffer()) as unknown as Parameters<typeof workbook.xlsx.load>[0],
    );
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['الملخص', 'الحركات']);
    const entries = workbook.getWorksheet('الحركات');
    expect(entries?.views[0]).toMatchObject({ rightToLeft: true });
    expect(entries?.rowCount).toBe(3);
    expect(String(entries?.getRow(3).getCell(3).value)).toContain('5100000088');
    expect(typeof entries?.getRow(2).getCell(4).value).toBe('number');
    const shopCell = workbook.getWorksheet('الملخص')?.getRow(2).getCell(2);
    expect(shopCell?.value).toBe(`'=HYPERLINK("http://x")`);
    expect(shopCell?.formula).toBeUndefined();
    // S23 ID9: the summary's tier block.
    const summaryText = JSON.stringify(workbook.getWorksheet('الملخص')?.getSheetValues() ?? []);
    expect(summaryText).toContain('فئتك هذا الشهر');
    expect(summaryText).toContain('تاجر معتمد');
    await test.db
      .update(customerRateLimits)
      .set({ count: 20 })
      .where(eq(customerRateLimits.key, `statement-export:customer:${shop.id}`));
    expect(await json(await client.get(path, { cookie: shop.cookie }), 429)).toMatchObject({
      code: 'RATE_LIMITED',
    });
  });
});

describe('the documents after audit A06', () => {
  it('A06-34: refuses a revoked merchant on the document routes', async () => {
    const shop = await merchant(usd(1));
    expect((await client.get('/api/merchant/statements', { cookie: shop.cookie })).status).toBe(
      200,
    );
    await test.db
      .update(customers)
      .set({ accountType: 'customer' })
      .where(eq(customers.id, shop.id));
    await test.db
      .update(merchantProfiles)
      .set({ revokedAt: new Date() })
      .where(eq(merchantProfiles.customerId, shop.id));
    for (const path of [
      `/api/merchant/price-list?gameIds=${ids.gameId}`,
      `/api/merchant/price-list.png?gameIds=${ids.gameId}`,
      '/api/merchant/statements',
      `/api/merchant/statements/${month()}`,
      `/api/merchant/statements/${month()}/export`,
    ]) {
      expect(await json(await client.get(path, { cookie: shop.cookie }), 403), path).toMatchObject({
        code: 'NOT_MERCHANT',
      });
    }
  });

  it('A06-34: answers NOT_FOUND for a price-list image past its last page', async () => {
    const shop = await merchant(0);
    const path = `/api/merchant/price-list.png?gameIds=${ids.gameId}`;
    const list = await json<{ imagePages: number }>(
      await client.get(`/api/merchant/price-list?gameIds=${ids.gameId}`, { cookie: shop.cookie }),
      200,
    );
    expect(
      (await client.get(`${path}&page=${list.imagePages}`, { cookie: shop.cookie })).status,
    ).toBe(200);
    expect(
      await json(
        await client.get(`${path}&page=${list.imagePages + 1}`, { cookie: shop.cookie }),
        404,
      ),
    ).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('A06-40: reads a month’s statement 60 times an hour', async () => {
    const shop = await merchant(usd(1));
    const path = `/api/merchant/statements/${month()}`;
    expect((await client.get(path, { cookie: shop.cookie })).status).toBe(200);
    await test.db
      .update(customerRateLimits)
      .set({ count: 60 })
      .where(eq(customerRateLimits.key, `statement-read:customer:${shop.id}`));
    expect(await json(await client.get(path, { cookie: shop.cookie }), 429)).toMatchObject({
      code: 'RATE_LIMITED',
    });
    // The export keeps its own limit.
    expect((await client.get(`${path}/export`, { cookie: shop.cookie })).status).toBe(200);
  });

  it('A06-38: stops the whole price-list render at its time budget, text blocks included', async () => {
    const list = {
      tradeName: 'محل النور',
      generatedAt: new Date().toISOString(),
      currency: 'usd' as const,
      tier: 'gold' as const,
      largeLogo: true,
      whatsapp: null,
      games: [
        {
          gameId: randomUUID(),
          nameAr: 'ببجي',
          rows: Array.from({ length: 60 }, (_, index) => ({
            productId: randomUUID(),
            nameAr: `باقة ${index}`,
            available: true,
            usdUnits: usd(1),
            sypUnits: null,
          })),
        },
      ],
    };
    await expect(
      renderPriceListImage(list, { page: 1, pages: 1 }, null, new Map(), 1),
    ).rejects.toThrow(/price list image/);
    // The game's cover beside its name and the shop's WhatsApp in the footer (owner, 2026-10-30).
    const cover = await sharp({
      create: { width: 200, height: 200, channels: 3, background: '#B9A87A' },
    })
      .png()
      .toBuffer();
    const image = await renderPriceListImage(
      { ...list, whatsapp: '+963933123456' },
      { page: 1, pages: 2 },
      null,
      new Map([[list.games[0]?.gameId as string, cover]]),
    );
    expect((await sharp(image).metadata()).width).toBe(1080);
    // USD leads when both currencies show.
    const both = priceText(
      { productId: randomUUID(), nameAr: '60', available: true, usdUnits: usd(5.08), sypUnits: 73_000 },
      'both',
    );
    expect(both.indexOf('5.08')).toBeLessThan(both.indexOf('730'));
    expect(priceText({ productId: randomUUID(), nameAr: '60', available: false, usdUnits: null, sypUnits: null }, 'both')).toBe('غير متوفر');
  });
});
