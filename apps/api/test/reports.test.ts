import { randomBytes, randomUUID } from 'node:crypto';
import {
  MAX_QUANTITY_LIMIT,
  priceFromCost,
  TOP_CUSTOMERS_LIMIT,
  TREASURY_PLACES,
} from '@vertex-digital/contracts';
import {
  applyOutcome,
  auditEntries,
  catalogCategories,
  catalogProducts,
  customers,
  damascusDate,
  ensureCustomerWallet,
  ensureSystemAccount,
  fulfilmentAttempts,
  lockOrder,
  merchantProfiles,
  newId,
  orderCodesKey,
  postJournal,
  supplierBalanceReads,
  supplierOffers,
  suppliers,
  transitionOrder,
} from '@vertex-digital/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseEnv } from '../src/core/config/env.js';
import {
  api,
  body,
  PASSWORD,
  PHONE,
  removeAccounts,
  seedCustomer,
  setSwitches,
  totp,
} from './helpers.js';
import { startApp, type TestApp } from './start-app.js';

/*
 * Reports (S13 rules RP1–RP9, X1–X4) over HTTP. Orders are bought through the API and delivered
 * as the worker does (`applyOutcome`), as in `live-operations.test.ts`. Today's figures are
 * compared before and after, since other suites sell today too.
 */

let test: TestApp;
let client: ReturnType<typeof api>;
let admin: Awaited<ReturnType<ReturnType<typeof api>['adminWithTotp']>>;
const seeded: string[] = [];
const categories: string[] = [];
const run = randomBytes(4).toString('hex');
const usd = (dollars: number) => Math.round(dollars * 1_000_000);
const RULE = { percentBp: 1000, fixedUsdUnits: 0, minMarginUsdUnits: usd(0.1) };
/** The pack's units per order: the export test buys its way into R5's top customers in one order. */
const MAX_UNITS = MAX_QUANTITY_LIMIT;
const state = { fake: '', gameId: '', productId: '', routeId: '', offerId: '', price: 0, cost: 0 };
const today = damascusDate(new Date());

async function json<T = Record<string, unknown>>(response: Response, status: number): Promise<T> {
  const payload = await response.json();
  expect(response.status, JSON.stringify(payload)).toBe(status);
  return payload as T;
}

const adminGet = (path: string) => client.get(path, { cookie: admin.cookie });

async function buyer(options: { isTest?: boolean; name?: string; funded?: boolean } = {}) {
  const customer = await seedCustomer(test.db, options.isTest ? { isTest: true } : {});
  seeded.push(customer.id);
  if (options.name) {
    await test.db
      .update(customers)
      .set({ name: options.name })
      .where(eq(customers.id, customer.id));
  }
  if (options.funded === false) {
    return { ...customer, cookie: await client.signInCustomer(customer.email) };
  }
  await test.db.transaction(async (tx) => {
    await postJournal(tx, {
      idempotencyKey: `test:${newId()}`,
      kind: 'adjustment',
      postings: [
        { accountId: await ensureCustomerWallet(tx, customer.id), amountUnits: usd(100) },
        {
          accountId: await ensureSystemAccount(tx, {
            code: 'adjustments:test_funds',
            kind: 'adjustments',
            currency: 'USD',
          }),
          amountUnits: -usd(100),
        },
      ],
    });
  });
  return { ...customer, cookie: await client.signInCustomer(customer.email) };
}

type Buyer = Awaited<ReturnType<typeof buyer>>;

/** Buys `quantity` units, sends them to the fake supplier and applies the delivery, as the worker does. */
async function delivered(who: Buyer, quantity = 1) {
  const { id: orderId } = await json<{ id: string }>(
    await client.post('/api/orders', {
      cookie: who.cookie,
      headers: { 'idempotency-key': randomUUID() },
      body: {
        productId: state.productId,
        quantity,
        fields: { player_id: '5123456789' },
        expectedUnitPriceUsdUnits: state.price,
        confirmPlayer: true,
      },
    }),
    201,
  );
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
      quantity,
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
      { status: 'delivered', quantity },
      { by: 'webhook' },
    ),
  );
  return orderId;
}

const period = `from=${today}&to=${today}`;

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
    await client.put('/api/admin/suppliers/fake/credentials', {
      cookie: admin.cookie,
      body: { values: { webhookSecret: `whsec-${run}-reports` } },
    }),
    200,
  );
  // Saving the credentials starts a sync no worker runs here: end it, as `live-operations` does,
  // or the worker's sync tests find it running.
  await test.db.execute(
    sql`update supplier_sync_runs set status = 'failed', finished_at = now(), error_code = 'TEST'
        where supplier_id = ${state.fake} and status = 'running'`,
  );
  const category = await json<{ id: string }>(
    await client.post('/api/admin/catalog/categories', {
      cookie: admin.cookie,
      body: { slug: `reports-${run}`, nameAr: `تقارير ${run}` },
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
  const game = await json<{ id: string }>(
    await client.post('/api/admin/catalog/games', {
      cookie: admin.cookie,
      body: {
        categoryId: category.id,
        slug: `reports-game-${run}`,
        nameAr: `لعبة ${run}`,
        nameEn: 'Game',
      },
    }),
    201,
  );
  state.gameId = game.id;
  await json(
    await client.post(`/api/admin/catalog/games/${game.id}/fields`, {
      cookie: admin.cookie,
      body: { key: 'player_id', labelAr: 'المعرف', type: 'digits', required: true, minLength: 5 },
    }),
    201,
  );
  const product = await json<{ id: string }>(
    await client.post(`/api/admin/catalog/games/${game.id}/products`, {
      cookie: admin.cookie,
      body: { kind: 'direct', nameAr: `باقة ${run}` },
    }),
    201,
  );
  state.productId = product.id;
  state.cost = usd(0.88);
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
    await client.post(`/api/admin/catalog/products/${product.id}/routes`, {
      cookie: admin.cookie,
      body: { offerId: state.offerId, fieldMap: { playerId: 'player_id' } },
    }),
    201,
  );
  state.routeId = routed.routes[0]?.id as string;
  state.price = priceFromCost(state.cost, RULE);
  await test.db
    .update(catalogProducts)
    .set({ maxQuantity: MAX_UNITS })
    .where(eq(catalogProducts.id, product.id));
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

describe('access and periods', () => {
  it('answers 401 without a session and refuses a customer session', async () => {
    const customer = await seedCustomer(test.db);
    seeded.push(customer.id);
    const cookie = await client.signInCustomer(customer.email);
    for (const options of [{}, { cookie }]) {
      for (const kind of ['sales', 'breakdown', 'deposits', 'refunds', 'customers', 'ledger']) {
        expect((await client.get(`/api/admin/reports/${kind}?${period}`, options)).status).toBe(
          401,
        );
        expect(
          (await client.get(`/api/admin/reports/${kind}/export?${period}`, options)).status,
        ).toBe(401);
      }
    }
  });

  it('refuses a reversed or too long period and an unknown report (RP1)', async () => {
    expect(
      await body(await adminGet('/api/admin/reports/sales?from=2026-10-02&to=2026-10-01')),
    ).toMatchObject({
      status: 400,
      code: 'REPORT_PERIOD_INVALID',
    });
    expect(
      await body(await adminGet('/api/admin/reports/ledger?from=2025-10-01&to=2026-10-02')),
    ).toMatchObject({
      status: 400,
      code: 'REPORT_PERIOD_INVALID',
    });
    expect(
      await body(await adminGet('/api/admin/reports/sales?from=2026-10-1&to=2026-10-02')),
    ).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
    expect(await body(await adminGet(`/api/admin/reports/orders/export?${period}`))).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
  });

  it('answers every report for an empty period, with zero totals (edge case 13)', async () => {
    for (const kind of ['sales', 'breakdown', 'deposits', 'refunds', 'customers', 'ledger']) {
      const response = await adminGet(`/api/admin/reports/${kind}?from=2001-01-01&to=2001-01-02`);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    const sales = await json<{ rows: unknown[]; totals: { salesUsdUnits: number } }>(
      await adminGet('/api/admin/reports/sales?from=2001-01-01&to=2001-01-02'),
      200,
    );
    expect(sales.rows).toHaveLength(2);
    expect(sales.totals.salesUsdUnits).toBe(0);
  });
});

interface Sales {
  rows: { date: string; salesUsdUnits: number; costUsdUnits: number; delivered: number }[];
  totals: {
    salesUsdUnits: number;
    costUsdUnits: number;
    profitUsdUnits: number;
    delivered: number;
  };
}

describe('figures', () => {
  it('counts real customers only, equal to the dashboard for today (RP2, RP3)', async () => {
    const before = await json<Sales>(await adminGet(`/api/admin/reports/sales?${period}`), 200);
    await delivered(await buyer());
    await delivered(await buyer({ isTest: true }));
    const after = await json<Sales>(await adminGet(`/api/admin/reports/sales?${period}`), 200);
    expect(after.totals.salesUsdUnits - before.totals.salesUsdUnits).toBe(state.price);
    expect(after.totals.costUsdUnits - before.totals.costUsdUnits).toBe(state.cost);
    expect(after.totals.delivered - before.totals.delivered).toBe(1);
    expect(after.rows).toEqual([
      expect.objectContaining({ date: today, salesUsdUnits: after.totals.salesUsdUnits }),
    ]);
    const dashboard = await json<{ sales: { today: number }; profit: { today: number } }>(
      await adminGet('/api/admin/dashboard'),
      200,
    );
    expect(after.totals.salesUsdUnits).toBe(dashboard.sales.today);
    expect(after.totals.profitUsdUnits).toBe(dashboard.profit.today);
  });

  it('breaks the figures down by game and by supplier with its attempts (RP4)', async () => {
    const byGame = await json<{
      rows: { key: string; salesUsdUnits: number; delivered: number }[];
    }>(await adminGet(`/api/admin/reports/breakdown?${period}&by=game`), 200);
    expect(byGame.rows.find((row) => row.key === state.gameId)).toMatchObject({
      salesUsdUnits: state.price,
      delivered: 1,
    });
    const bySupplier = await json<{
      by: string;
      rows: { key: string; attemptsSent: number; deliveredUnits: number }[];
      totals: { attemptsSent: number | null; delivered: number };
    }>(await adminGet(`/api/admin/reports/breakdown?${period}&by=supplier`), 200);
    // The totals count each order once, as R1 does, whatever suppliers delivered it (A09-17).
    const sales = await json<Sales>(await adminGet(`/api/admin/reports/sales?${period}`), 200);
    expect(bySupplier.totals.delivered).toBe(sales.totals.delivered);
    expect(bySupplier.by).toBe('supplier');
    const fake = bySupplier.rows.find((row) => row.key === 'fake');
    expect(fake?.attemptsSent).toBeGreaterThanOrEqual(1);
    expect(fake?.deliveredUnits).toBeGreaterThanOrEqual(1);
    expect(bySupplier.totals.attemptsSent).toBeGreaterThanOrEqual(1);
  });

  it('counts no cancelled reservation as a finished order (A09-11)', async () => {
    const productRow = async () =>
      (
        await json<{ products: { productId: string; finished: number; refunded: number }[] }>(
          await adminGet(`/api/admin/reports/refunds?${period}`),
          200,
        )
      ).products.find((row) => row.productId === state.productId);
    const before = await productRow();
    const poor = await buyer({ funded: false });
    const { id } = await json<{ id: string; status: string }>(
      await client.post('/api/orders', {
        cookie: poor.cookie,
        headers: { 'idempotency-key': randomUUID() },
        body: {
          productId: state.productId,
          quantity: 1,
          fields: { player_id: '5123456789' },
          expectedUnitPriceUsdUnits: state.price,
          confirmPlayer: true,
          whenBalanceShort: 'reserve',
        },
      }),
      201,
    );
    await json(await client.post(`/api/orders/${id}/cancel`, { cookie: poor.cookie }), 200);
    const after = await productRow();
    expect(after?.finished ?? 0).toBe(before?.finished ?? 0);
  });

  it('leaves a merchant’s retail orders from before the grant out of the merchant breakdown (A09-20)', async () => {
    const shop = await buyer();
    await delivered(shop);
    await test.db.insert(merchantProfiles).values({
      customerId: shop.id,
      tradeName: `Shop ${run}`,
      governorate: 'damascus',
      city: 'Damascus',
      grantedAt: new Date(),
    });
    const byMerchant = await json<{ rows: { key: string }[] }>(
      await adminGet(`/api/admin/reports/breakdown?${period}&by=merchant`),
      200,
    );
    expect(byMerchant.rows.find((row) => row.key === shop.id)).toBeUndefined();
  });

  it('shows the ledger with test customers apart (RP8)', async () => {
    const ledger = await json<{
      rows: { line: string; usdUnits: number; testUsdUnits: number | null }[];
      places: { place: string }[];
    }>(await adminGet(`/api/admin/reports/ledger?${period}`), 200);
    const purchases = ledger.rows.filter((row) => row.line === 'purchase');
    expect(purchases.length).toBeGreaterThan(0);
    for (const row of purchases) expect(row.testUsdUnits).not.toBeNull();
    for (const row of ledger.rows.filter((item) => item.line === 'cost_of_goods')) {
      expect(row.testUsdUnits).toBeNull();
    }
    expect(ledger.places).toHaveLength(TREASURY_PLACES.length);
  });
});

describe('Excel export (X1–X4)', () => {
  it('streams an audited right-to-left workbook, with text never read as a formula and no phone', async () => {
    const name = `=HYPERLINK("http://x.test","${run}")`;
    const customer = await buyer({ name });
    // R5 lists the top customers of the day: earlier runs' customers stay in the test database,
    // so this one buys past the last of a full list (ties go to the older customer).
    const { rows } = await json<{ rows: { salesUsdUnits: number }[] }>(
      await adminGet(`/api/admin/reports/customers?${period}`),
      200,
    );
    const last = rows.length < TOP_CUSTOMERS_LIMIT ? 0 : (rows.at(-1)?.salesUsdUnits ?? 0);
    // One order of several units, not many orders: the purchase limits count orders.
    const units = Math.max(3, Math.floor(last / state.price) + 1);
    expect(units, 'R5 needs more than one order can buy').toBeLessThanOrEqual(MAX_UNITS);
    await delivered(customer, units);
    const response = await adminGet(`/api/admin/reports/customers/export?${period}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="vertex-customers-${today}-${today}.xlsx"`,
    );
    const workbook = new ExcelJS.Workbook();
    // `exceljs` reads an ArrayBuffer; its types name an older `Buffer`.
    await workbook.xlsx.load(
      (await response.arrayBuffer()) as unknown as Parameters<typeof workbook.xlsx.load>[0],
    );
    const sheet = workbook.worksheets[0];
    expect(sheet?.views[0]?.rightToLeft).toBe(true);
    const cells: unknown[] = [];
    sheet?.eachRow((row) => row.eachCell((cell) => cells.push(cell.value)));
    // The name is a plain string cell, not `{ formula }`.
    expect(cells).toContain(name);
    expect(
      cells.some((value) => typeof value === 'object' && value !== null && 'formula' in value),
    ).toBe(false);
    expect(cells.join(' ')).not.toContain(PHONE);
    expect(cells).not.toContain('الهاتف');
    const [entry] = await test.db
      .select()
      .from(auditEntries)
      .where(and(eq(auditEntries.action, 'report.exported'), eq(auditEntries.actorId, admin.id)))
      .orderBy(desc(auditEntries.occurredAt))
      .limit(1);
    expect(entry?.details).toMatchObject({
      kind: 'customers',
      breakdown: null,
      from: today,
      to: today,
    });
  });
});
