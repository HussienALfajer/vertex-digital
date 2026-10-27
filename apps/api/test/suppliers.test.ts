import { randomBytes } from 'node:crypto';
import {
  priceFromCost,
  ROOT_PRICE_LIST_IDS,
  SUPPLIER_POLICY_DEFAULTS,
} from '@vertex-digital/contracts';
import {
  appendProductPrice,
  catalogCategories,
  catalogGames,
  catalogProducts,
  decryptCredentials,
  lockProductsForPricing,
  newId,
  type ProductRoutingState,
  priceReviews,
  productPrices,
  productRoutes,
  productRoutingStates,
  repriceProducts,
  supplierBalanceReads,
  supplierCalls,
  supplierCategories,
  supplierCredentials,
  supplierKey,
  supplierOffers,
  supplierSyncRuns,
  suppliers,
} from '@vertex-digital/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseEnv } from '../src/core/config/env.js';
import {
  api,
  auditOf,
  body,
  PASSWORD,
  removeAccounts,
  seedCustomer,
  setSwitches,
  totp,
} from './helpers.js';
import { startApp, type TestApp } from './start-app.js';

/*
 * Suppliers, routes, stored prices and reviews (S07) over HTTP against the test database, with the
 * `fake` and `manual` suppliers. The worker's sync is played by writing offers and calling the
 * repricing write path as it does. Products of this file are archived in `afterAll` (prices are
 * append-only, so they stay), so none stays available to other files (rule P9); switches, the
 * policy and the fake supplier's balance are put back.
 */

let test: TestApp;
let client: ReturnType<typeof api>;
let admin: Awaited<ReturnType<ReturnType<typeof api>['adminWithTotp']>>;
let customerCookie: string;
const seeded: string[] = [];
const categories: string[] = [];
const run = randomBytes(4).toString('hex');
const usd = (dollars: number) => Math.round(dollars * 1_000_000);
const RULE = { percentBp: 1000, fixedUsdUnits: 0, minMarginUsdUnits: usd(0.1) };
const price = (cost: number) => priceFromCost(usd(cost), RULE);
const SECRET = `whsec-${run}-a1b2`;
const ids = { fake: '', manual: '', gameId: '', bigGameId: '', categoryId: '' };
const offers: Record<string, string> = {};

async function reauthenticate(cookie = admin.cookie) {
  const response = await client.post('/api/admin/me/reauthenticate', {
    cookie,
    body: { password: PASSWORD, totpCode: totp(admin.secret) },
  });
  expect(response.status).toBe(200);
}

async function json<T = Record<string, unknown>>(response: Response, status: number): Promise<T> {
  const payload = await response.json();
  expect(response.status, JSON.stringify(payload)).toBe(status);
  return payload as T;
}

const get = (path: string) => client.get(path, { cookie: admin.cookie });
const post = (path: string, payload?: unknown) =>
  client.post(path, { cookie: admin.cookie, body: payload });
const put = (path: string, payload: unknown) =>
  client.put(path, { cookie: admin.cookie, body: payload });
const patch = (path: string, payload: unknown) =>
  client.patch(path, { cookie: admin.cookie, body: payload });

interface Routing {
  productId: string;
  routes: {
    id: string;
    supplierCode: string;
    tier: string | null;
    unusableReason: string | null;
    basis: boolean;
    enabled: boolean;
    archivedAt: string | null;
    requirementsUnknown: boolean;
    offer: { id: string };
    priceBasis: boolean;
    expectedDeliveryMinutes: number | null;
    hardLimitMinutes: number | null;
  }[];
  basisRouteId: string | null;
  priceHeld: boolean;
  currentPrice: { priceUsdUnits: number; costUsdUnits: number; routeId: string } | null;
  targetPriceUsdUnits: number | null;
  openReview: { id: string; proposedPriceUsdUnits: number; costAfterUsdUnits: number } | null;
  availability: string;
}

const routing = async (productId: string) =>
  json<Routing>(await get(`/api/admin/catalog/products/${productId}/routes`), 200);

/** A fake offer as the worker's sync would write it. */
async function fakeOffer(
  key: string,
  values: {
    cost: number | null;
    group?: string;
    kind?: 'direct' | 'code' | null;
    required?: string[] | null;
    missing?: boolean;
    inStock?: boolean;
  },
) {
  const now = new Date();
  const [row] = await test.db
    .insert(supplierOffers)
    .values({
      supplierId: ids.fake,
      offerId: `${key}-${run}`,
      name: `Fake ${key}`,
      groupName: values.group ?? `PUBG Mobile ${run}`,
      kind: values.kind === undefined ? 'direct' : values.kind,
      requiredFields: values.required === undefined ? ['playerId'] : values.required,
      costUsdUnits: values.cost === null ? null : usd(values.cost),
      costRaw: values.cost === null ? '12.5 EUR' : null,
      inStock: values.inStock ?? true,
      costConfirmedAt: values.cost === null ? null : now,
      lastSeenAt: now,
      missingSince: values.missing ? now : null,
    })
    .returning({ id: supplierOffers.id });
  offers[key] = (row as { id: string }).id;
  return offers[key] as string;
}

/** A sync's cost change and its repricing, as the worker writes them (rules SY4, P2). */
async function syncCost(offerKey: string, cost: number, productIds: string[]) {
  await test.db
    .update(supplierOffers)
    .set({ costUsdUnits: usd(cost), costConfirmedAt: new Date() })
    .where(eq(supplierOffers.id, offers[offerKey] as string));
  return test.db.transaction((tx) =>
    repriceProducts(tx, {
      productIds,
      cause: 'cost_sync',
      context: { now: new Date(), fakeEnabled: true },
    }),
  );
}

async function product(nameAr: string, gameId = ids.gameId, kind: 'direct' | 'code' = 'direct') {
  const created = await json<{ id: string }>(
    await post(`/api/admin/catalog/games/${gameId}/products`, { kind, nameAr }),
    201,
  );
  return created.id;
}

beforeAll(async () => {
  test = await startApp();
  client = api(test.url);
  admin = await client.adminWithTotp(test.db);
  seeded.push(admin.id);
  const customer = await seedCustomer(test.db);
  seeded.push(customer.id);
  customerCookie = await client.signInCustomer(customer.email);
  await reauthenticate();
  await setSwitches(test.db);
  const rows = await test.db.select().from(suppliers);
  ids.fake = rows.find((row) => row.code === 'fake')?.id as string;
  ids.manual = rows.find((row) => row.code === 'manual')?.id as string;
  const category = await json<{ id: string }>(
    await post('/api/admin/catalog/categories', { slug: `sup-${run}`, nameAr: `موردون ${run}` }),
    201,
  );
  ids.categoryId = category.id;
  categories.push(category.id);
  for (const [key, slug] of [
    ['gameId', `pubg-${run}`],
    ['bigGameId', `big-${run}`],
  ] as const) {
    const game = await json<{ id: string }>(
      await post('/api/admin/catalog/games', {
        categoryId: category.id,
        slug,
        nameAr: `لعبة ${slug}`,
        nameEn: 'Game',
      }),
      201,
    );
    ids[key] = game.id;
    await json(
      await post(`/api/admin/catalog/games/${game.id}/fields`, {
        key: 'player_id',
        labelAr: 'المعرف',
        type: 'digits',
        required: true,
      }),
      201,
    );
  }
  const cover = new FormData();
  const png = await sharp(randomBytes(32 * 32 * 3), { raw: { width: 32, height: 32, channels: 3 } })
    .png()
    .toBuffer();
  cover.set('file', new Blob([new Uint8Array(png)]), 'cover.png');
  const image = await json<{ id: string }>(
    await client.post('/api/admin/catalog/images', { cookie: admin.cookie, form: cover }),
    201,
  );
  await json(
    await patch(`/api/admin/catalog/games/${ids.gameId}`, {
      coverFileId: image.id,
      status: 'active',
    }),
    200,
  );
  await json(
    await put('/api/admin/pricing/rules', {
      scope: 'category',
      targetId: category.id,
      ...RULE,
    }),
    200,
  );
});

afterAll(async () => {
  await test.db
    .update(catalogCategories)
    .set({ archivedAt: new Date() })
    .where(inArray(catalogCategories.id, categories));
  await test.db
    .update(supplierSyncRuns)
    .set({ status: 'failed', finishedAt: new Date(), errorCode: 'TEST' })
    .where(and(eq(supplierSyncRuns.supplierId, ids.fake), eq(supplierSyncRuns.status, 'running')));
  await test.db
    .insert(supplierBalanceReads)
    .values({ supplierId: ids.fake, currency: 'USD', amountUnits: usd(1_000_000) });
  await setSwitches(test.db);
  await reauthenticate();
  await put('/api/admin/suppliers/policy', SUPPLIER_POLICY_DEFAULTS);
  await removeAccounts(test.db, seeded);
  await test.app.close();
});

describe('access', () => {
  const routes: [string, string][] = [
    ['GET', '/api/admin/suppliers'],
    ['GET', '/api/admin/suppliers/fake'],
    ['PUT', '/api/admin/suppliers/fake/credentials'],
    ['PATCH', '/api/admin/suppliers/fake'],
    ['PUT', '/api/admin/suppliers/fake/validation-quota'],
    ['POST', '/api/admin/suppliers/fake/sync'],
    ['GET', '/api/admin/suppliers/fake/runs'],
    ['GET', '/api/admin/suppliers/fake/offers'],
    ['POST', '/api/admin/suppliers/fake/import'],
    ['GET', '/api/admin/suppliers/policy'],
    ['PUT', '/api/admin/suppliers/policy'],
    ['GET', '/api/admin/suppliers/offers/0199a000-0000-7000-8000-000000000001/costs'],
    ['GET', '/api/admin/catalog/products/0199a000-0000-7000-8000-000000000001/routes'],
    ['POST', '/api/admin/catalog/products/0199a000-0000-7000-8000-000000000001/routes'],
    ['POST', '/api/admin/catalog/products/0199a000-0000-7000-8000-000000000001/routes/manual'],
    ['GET', '/api/admin/catalog/products/0199a000-0000-7000-8000-000000000001/prices'],
    ['PATCH', '/api/admin/routes/0199a000-0000-7000-8000-000000000001'],
    ['POST', '/api/admin/routes/0199a000-0000-7000-8000-000000000001/archive'],
    ['POST', '/api/admin/routes/0199a000-0000-7000-8000-000000000001/restore'],
    ['PUT', '/api/admin/routes/0199a000-0000-7000-8000-000000000001/manual-cost'],
    ['GET', '/api/admin/pricing/reviews'],
    ['POST', '/api/admin/pricing/reviews/decide'],
    ['POST', '/api/admin/pricing/reviews/0199a000-0000-7000-8000-000000000001/adjust-margin'],
  ];

  it('answers 401 without a session and to a customer session', async () => {
    for (const cookie of [undefined, customerCookie]) {
      for (const [method, path] of routes) {
        const response = await client.request(method, path, {
          ...(cookie ? { cookie } : {}),
          ...(method === 'GET' ? {} : { body: {} }),
        });
        expect(response.status, `${method} ${path}`).toBe(401);
      }
    }
  });

  it('needs a re-authentication for keys, the threshold, the policy, manual costs and margins', async () => {
    const fresh = await client.adminWithTotp(test.db);
    seeded.push(fresh.id);
    const sensitive: [string, string, unknown][] = [
      ['PUT', '/api/admin/suppliers/fake/credentials', { values: { webhookSecret: SECRET } }],
      [
        'PUT',
        '/api/admin/suppliers/fazercards/credentials',
        { values: { apiKey: 'x', webhookSecret: SECRET } },
      ],
      ['PATCH', '/api/admin/suppliers/fake', { lowBalanceUsdUnits: usd(10) }],
      ['PUT', '/api/admin/suppliers/policy', SUPPLIER_POLICY_DEFAULTS],
      [
        'POST',
        '/api/admin/catalog/products/0199a000-0000-7000-8000-000000000001/routes/manual',
        { costUsdUnits: usd(1) },
      ],
      [
        'PUT',
        '/api/admin/routes/0199a000-0000-7000-8000-000000000001/manual-cost',
        { costUsdUnits: usd(1) },
      ],
      [
        'POST',
        '/api/admin/pricing/reviews/0199a000-0000-7000-8000-000000000001/adjust-margin',
        RULE,
      ],
    ];
    for (const [method, path, payload] of sensitive) {
      const response = await client.request(method, path, { cookie: fresh.cookie, body: payload });
      expect(await body(response), `${method} ${path}`).toMatchObject({
        status: 403,
        code: 'REAUTHENTICATION_REQUIRED',
      });
    }
    // `adminWithTotp` replaced the only admin: sign the file's admin in again.
    admin = await client.adminWithTotp(test.db);
    seeded.push(admin.id);
    await reauthenticate();
  });

  it('never caches its answers', async () => {
    for (const path of ['/api/admin/suppliers', '/api/admin/suppliers/policy']) {
      expect((await get(path)).headers.get('cache-control')).toBe('no-store');
    }
  });
});

describe('suppliers (rules SP1–SP3)', () => {
  it('lists the four suppliers, FazerCards with its adapter (S19 FC2)', async () => {
    const list = await json<
      { code: string; available: boolean; configured: boolean; lowBalanceUsdUnits: number }[]
    >(await get('/api/admin/suppliers'), 200);
    expect(list.map((item) => [item.code, item.available])).toEqual([
      ['wdgzone', true],
      ['fazercards', true],
      ['manual', true],
      ['fake', true],
    ]);
    // D8: FazerCards' low-balance alert starts at $5.
    expect(list.find((item) => item.code === 'fazercards')?.lowBalanceUsdUnits).toBe(usd(5));
    expect(list.find((item) => item.code === 'manual')?.configured).toBe(true);
    expect(list.find((item) => item.code === 'wdgzone')?.configured).toBeTypeOf('boolean');
  });

  it('answers NOT_FOUND for an unknown supplier', async () => {
    expect(await body(await get('/api/admin/suppliers/acme'))).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
  });

  it('refuses credentials that are not exactly the supplier fields', async () => {
    for (const [code, values] of [
      ['fake', { apiKey: 'x' }],
      ['fake', { webhookSecret: SECRET, apiKey: 'x' }],
      ['manual', { apiKey: 'x' }],
      ['fazercards', { apiKey: 'x' }],
      ['fazercards', { webhookSecret: SECRET }],
    ] as const) {
      expect(
        await body(await put(`/api/admin/suppliers/${code}/credentials`, { values })),
      ).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    }
  });

  it('stores credentials encrypted, answers and audits hints only, and tests the connection', async () => {
    const response = await put('/api/admin/suppliers/fake/credentials', {
      values: { webhookSecret: SECRET },
    });
    const text = await response.clone().text();
    expect(text).not.toContain(SECRET.slice(0, -4));
    const detail = await json<{
      configured: boolean;
      credentials: { hints: Record<string, string> };
      lastRun: { id: string; status: string; trigger: string } | null;
    }>(response, 200);
    expect(detail.configured).toBe(true);
    expect(detail.credentials.hints).toEqual({ webhookSecret: 'a1b2' });
    expect(detail.lastRun).toMatchObject({ status: 'running', trigger: 'admin' });
    const [stored] = await test.db
      .select()
      .from(supplierCredentials)
      .where(eq(supplierCredentials.supplierId, ids.fake))
      .orderBy(desc(supplierCredentials.createdAt))
      .limit(1);
    const key = supplierKey(parseEnv().SUPPLIER_KEYS_SECRET);
    expect(decryptCredentials(key, ids.fake, stored?.ciphertext as Buffer)).toEqual({
      webhookSecret: SECRET,
    });
    const audit = await auditOf(test.db, ids.fake);
    const entry = audit.filter((row) => row.action === 'supplier.credentials_set').at(-1);
    expect(entry?.details).toEqual({
      supplier: 'fake',
      fields: ['webhookSecret'],
      hints: { webhookSecret: 'a1b2' },
    });
    expect(JSON.stringify(audit)).not.toContain(SECRET.slice(0, -4));
  });

  it('stores FazerCards key and webhook secret, then tests them with a sync (S19 FC2)', async () => {
    const detail = await json<{
      available: boolean;
      configured: boolean;
      credentialFields: string[];
      credentials: { hints: Record<string, string> };
      lastRun: unknown;
    }>(
      await put('/api/admin/suppliers/fazercards/credentials', {
        values: { apiKey: `fzr-${run}-c3d4`, webhookSecret: SECRET },
      }),
      200,
    );
    // Rule SP2: new keys are tested by an admin run (the worker reads FazerCards with them).
    expect(detail).toMatchObject({
      available: true,
      configured: true,
      lastRun: { status: 'running', trigger: 'admin' },
    });
    expect(detail.credentialFields).toEqual(['apiKey', 'webhookSecret']);
    expect(detail.credentials.hints).toEqual({ apiKey: 'c3d4', webhookSecret: 'a1b2' });
  });

  it('starts a sync once: the running run, then one a minute (rule SY1)', async () => {
    // WDGZone has no keys in any test: not configured.
    expect(await body(await post('/api/admin/suppliers/wdgzone/sync'))).toMatchObject({
      status: 409,
      code: 'SUPPLIER_NOT_CONFIGURED',
    });
    // The manual supplier lists no offers: nothing to sync.
    expect(await body(await post('/api/admin/suppliers/manual/sync'))).toMatchObject({
      status: 409,
      code: 'SUPPLIER_UNAVAILABLE',
    });
    const first = await json<{ id: string; status: string }>(
      await post('/api/admin/suppliers/fake/sync'),
      202,
    );
    const again = await json<{ id: string }>(await post('/api/admin/suppliers/fake/sync'), 202);
    expect(again.id).toBe(first.id);
    // The worker ends the run; a new request within the minute is refused.
    await test.db
      .update(supplierSyncRuns)
      .set({ status: 'succeeded', finishedAt: new Date() })
      .where(eq(supplierSyncRuns.id, first.id));
    expect(await body(await post('/api/admin/suppliers/fake/sync'))).toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
    });
    const runs = await json<{ items: { id: string }[]; total: number }>(
      await get('/api/admin/suppliers/fake/runs?pageSize=5'),
      200,
    );
    expect(runs.items[0]?.id).toBe(first.id);
  });

  it('sets the low-balance threshold, audited, and shows a low balance (A07)', async () => {
    const detail = await json<{ lowBalanceUsdUnits: number }>(
      await patch('/api/admin/suppliers/fake', { lowBalanceUsdUnits: usd(75) }),
      200,
    );
    expect(detail.lowBalanceUsdUnits).toBe(usd(75));
    expect(
      await body(await patch('/api/admin/suppliers/fake', { lowBalanceUsdUnits: 1 })),
    ).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    await test.db
      .insert(supplierBalanceReads)
      .values({ supplierId: ids.fake, currency: 'USD', amountUnits: usd(20) });
    const low = await json<{ balanceLow: boolean; balanceHistory: unknown[] }>(
      await get('/api/admin/suppliers/fake'),
      200,
    );
    expect(low.balanceLow).toBe(true);
    expect(low.balanceHistory.length).toBeGreaterThan(0);
    await test.db
      .insert(supplierBalanceReads)
      .values({ supplierId: ids.fake, currency: 'USD', amountUnits: usd(1_000_000) });
    await json(await patch('/api/admin/suppliers/fake', { lowBalanceUsdUnits: usd(50) }), 200);
    const entries = (await auditOf(test.db, ids.fake)).filter(
      (row) => row.action === 'supplier.updated',
    );
    expect(entries.at(-2)?.details).toEqual({
      supplier: 'fake',
      before: { lowBalanceUsdUnits: usd(50) },
      after: { lowBalanceUsdUnits: usd(75) },
    });
  });
  it("sets the daily validation quota with today's usage, audited (S09 rule AD2)", async () => {
    const list = await json<
      {
        code: string;
        canValidatePlayer: boolean;
        validationQuota: number;
        validationsToday: number;
      }[]
    >(await get('/api/admin/suppliers'), 200);
    const fake = list.find((row) => row.code === 'fake');
    expect(fake).toMatchObject({ canValidatePlayer: true, validationsToday: expect.any(Number) });
    expect(list.find((row) => row.code === 'manual')?.canValidatePlayer).toBe(false);
    const before = fake?.validationQuota as number;
    try {
      const detail = await json<{ validationQuota: number }>(
        await put('/api/admin/suppliers/fake/validation-quota', { quota: 250 }),
        200,
      );
      expect(detail.validationQuota).toBe(250);
      expect(
        await body(await put('/api/admin/suppliers/fake/validation-quota', { quota: 1_000_001 })),
      ).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
      expect(
        await body(await put('/api/admin/suppliers/nobody/validation-quota', { quota: 5 })),
      ).toMatchObject({ status: 404, code: 'NOT_FOUND' });
      const [entry] = (await auditOf(test.db, ids.fake))
        .filter((row) => row.action === 'supplier.validation_quota_set')
        .slice(-1);
      expect(entry?.details).toEqual({ supplier: 'fake', before, after: 250 });
    } finally {
      await json(await put('/api/admin/suppliers/fake/validation-quota', { quota: before }), 200);
    }
  });
});

describe('offers', () => {
  beforeAll(async () => {
    await fakeOffer('uc-60', { cost: 0.88 });
    await fakeOffer('uc-325', { cost: 4.4 });
    await fakeOffer('uc-660', { cost: 8.8 });
    await fakeOffer('uc-1800', { cost: 22 });
    await fakeOffer('gift-10', { cost: 9.6, group: `iTunes ${run}`, kind: 'code', required: [] });
    await fakeOffer('eur', { cost: null });
    await fakeOffer('gone', { cost: 1, missing: true });
    await fakeOffer('nokind', { cost: 2, kind: null, required: null });
  });

  it('lists them with filters, stale costs and raw values', async () => {
    const page = await json<{
      items: { offerId: string; costRaw: string | null }[];
      total: number;
    }>(
      await get(
        `/api/admin/suppliers/fake/offers?group=${encodeURIComponent(`PUBG Mobile ${run}`)}`,
      ),
      200,
    );
    expect(page.items.map((item) => item.offerId)).toEqual(
      expect.arrayContaining([`uc-60-${run}`, `uc-325-${run}`, `eur-${run}`]),
    );
    expect(page.items.find((item) => item.offerId === `eur-${run}`)?.costRaw).toBe('12.5 EUR');
    const missing = await json<{ items: { offerId: string }[] }>(
      await get(`/api/admin/suppliers/fake/offers?missing=true&q=gone-${run}`),
      200,
    );
    expect(missing.items.map((item) => item.offerId)).toEqual([`gone-${run}`]);
    const unmapped = await json<{ total: number }>(
      await get(`/api/admin/suppliers/fake/offers?mapped=false&q=${run}`),
      200,
    );
    expect(unmapped.total).toBe(8);
    expect(await body(await get('/api/admin/suppliers/fake/offers?inStock=maybe'))).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
  });

  it('answers NOT_FOUND for the costs of an unknown offer', async () => {
    expect(
      await body(
        await get('/api/admin/suppliers/offers/0199a000-0000-7000-8000-000000000001/costs'),
      ),
    ).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});

describe('import (rule RT8)', () => {
  const importOffers = (payload: unknown) => post('/api/admin/suppliers/fake/import', payload);

  it('refuses every bad row, and creates nothing', async () => {
    const taken = await product(`مأخوذ ${run}`);
    const refused = await body(
      await importOffers({
        gameId: ids.gameId,
        fieldMap: { playerId: 'player_id' },
        rows: [
          { offerId: offers['uc-325'], nameAr: `325 شدة ${run}` },
          { offerId: offers.gone, nameAr: `مفقود ${run}` },
          { offerId: offers['gift-10'], nameAr: `بطاقة ${run}` },
        ],
        kind: 'direct',
      }),
    );
    expect(refused).toMatchObject({
      status: 409,
      code: 'OFFER_MISSING',
      details: {
        rows: [
          { index: 1, code: 'OFFER_MISSING' },
          { index: 2, code: 'ROUTE_KIND_MISMATCH' },
        ],
      },
    });
    const unmapped = await body(
      await importOffers({
        gameId: ids.gameId,
        rows: [{ offerId: offers['uc-325'], nameAr: 'x' }],
      }),
    );
    expect(unmapped).toMatchObject({
      code: 'ROUTE_FIELDS_UNMAPPED',
      details: { rows: [{ index: 0, code: 'ROUTE_FIELDS_UNMAPPED', fields: ['playerId'] }] },
    });
    const name = await body(
      await importOffers({
        gameId: ids.gameId,
        fieldMap: { playerId: 'player_id' },
        rows: [{ offerId: offers['uc-325'], nameAr: `مأخوذ ${run}` }],
      }),
    );
    expect(name).toMatchObject({
      code: 'NAME_TAKEN',
      details: { rows: [{ index: 0, code: 'NAME_TAKEN' }] },
    });
    expect(
      await body(
        await importOffers({
          gameId: ids.gameId,
          fieldMap: { playerId: 'zone_id' },
          rows: [{ offerId: offers['uc-325'], nameAr: 'x' }],
        }),
      ),
    ).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    const routingOfTaken = await routing(taken);
    expect(routingOfTaken.routes).toEqual([]);
  });

  it('creates paused products with their routes and prices (PR3), audited', async () => {
    const result = await json<{
      products: { id: string; nameAr: string; routeId: string; priceUsdUnits: number }[];
    }>(
      await importOffers({
        gameId: ids.gameId,
        fieldMap: { playerId: 'player_id' },
        rows: [
          { offerId: offers['uc-325'], nameAr: `325 شدة ${run}` },
          { offerId: offers['uc-660'], nameAr: `660 شدة ${run}` },
          { offerId: offers['uc-1800'], nameAr: `1800 شدة ${run}` },
        ],
      }),
      201,
    );
    expect(result.products.map((item) => item.priceUsdUnits)).toEqual([
      price(4.4),
      price(8.8),
      price(22),
    ]);
    const first = result.products[0] as { id: string };
    const state = await routing(first.id);
    expect(state).toMatchObject({ availability: 'paused', basisRouteId: expect.any(String) });
    expect(state.routes[0]).toMatchObject({ supplierCode: 'fake', tier: 'healthy', basis: true });
    const audit = await auditOf(test.db, ids.fake);
    expect(audit.filter((row) => row.action === 'supplier.import').at(-1)?.details).toEqual({
      supplier: 'fake',
      gameId: ids.gameId,
      count: 3,
    });
    expect(
      await body(
        await importOffers({
          gameId: ids.gameId,
          fieldMap: { playerId: 'player_id' },
          rows: [{ offerId: offers['uc-325'], nameAr: `مرة أخرى ${run}` }],
        }),
      ),
    ).toMatchObject({
      code: 'OFFER_ALREADY_MAPPED',
      details: { rows: [{ index: 0, code: 'OFFER_ALREADY_MAPPED' }] },
    });
  });

  it('imports 100 rows at once and refuses the 101st (CATALOG_LIMIT_REACHED)', async () => {
    const rows: { offerId: string; nameAr: string }[] = [];
    for (let index = 0; index < 101; index++) {
      const id = await fakeOffer(`bulk-${index}`, { cost: 1 + index / 100, group: `Bulk ${run}` });
      rows.push({ offerId: id, nameAr: `باقة ${index} ${run}` });
    }
    const result = await json<{ products: unknown[] }>(
      await importOffers({
        gameId: ids.bigGameId,
        fieldMap: { playerId: 'player_id' },
        rows: rows.slice(0, 100),
      }),
      201,
    );
    expect(result.products).toHaveLength(100);
    expect(
      await body(
        await importOffers({
          gameId: ids.bigGameId,
          fieldMap: { playerId: 'player_id' },
          rows: rows.slice(100),
        }),
      ),
    ).toMatchObject({
      code: 'CATALOG_LIMIT_REACHED',
      details: { rows: [{ index: 0, code: 'CATALOG_LIMIT_REACHED' }] },
    });
  });

  it("keeps on each route only its own offer's fields (audit F9-4)", async () => {
    const game = await json<{ id: string }>(
      await post('/api/admin/catalog/games', {
        categoryId: ids.categoryId,
        slug: `mixed-${run}`,
        nameAr: `لعبة مختلطة ${run}`,
        nameEn: 'Mixed',
      }),
      201,
    );
    for (const key of ['player_id', 'zone_id']) {
      await json(
        await post(`/api/admin/catalog/games/${game.id}/fields`, {
          key,
          labelAr: key,
          type: 'digits',
          required: true,
        }),
        201,
      );
    }
    const byPlayer = await fakeOffer('mixed-player', { cost: 1, required: ['player_id'] });
    const byUser = await fakeOffer('mixed-user', { cost: 2, required: ['user_id'] });
    const result = await json<{ products: { id: string }[] }>(
      await importOffers({
        gameId: game.id,
        fieldMap: { player_id: 'player_id', user_id: 'zone_id' },
        rows: [
          { offerId: byPlayer, nameAr: `حساب أ ${run}` },
          { offerId: byUser, nameAr: `حساب ب ${run}` },
        ],
      }),
      201,
    );
    const routes = await test.db
      .select({ offerId: productRoutes.offerId, fieldMap: productRoutes.fieldMap })
      .from(productRoutes)
      .where(
        inArray(
          productRoutes.productId,
          result.products.map((item) => item.id),
        ),
      );
    expect(Object.fromEntries(routes.map((route) => [route.offerId, route.fieldMap]))).toEqual({
      [byPlayer]: { player_id: 'player_id' },
      [byUser]: { user_id: 'zone_id' },
    });
  });

  it('refuses an offer ignored while the import waited on it (audit F9-8)', async () => {
    const offerId = await fakeOffer('ignored-meanwhile', { cost: 1 });
    let imported: Promise<Response> | undefined;
    // An ignore holding the offer: the import checked it before and waits on it to write.
    await test.db.transaction(async (tx) => {
      await tx.select().from(supplierOffers).where(eq(supplierOffers.id, offerId)).for('update');
      await tx
        .update(supplierOffers)
        .set({ ignoredAt: new Date(), ignoredAdminId: admin.id })
        .where(eq(supplierOffers.id, offerId));
      imported = importOffers({
        gameId: ids.gameId,
        fieldMap: { playerId: 'player_id' },
        rows: [{ offerId, nameAr: `متجاهل ${run}` }],
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    });
    expect(await body(await (imported as Promise<Response>))).toMatchObject({
      status: 409,
      code: 'OFFER_IGNORED',
      details: { rows: [{ index: 0, code: 'OFFER_IGNORED' }] },
    });
    const left = await test.db
      .select({ id: productRoutes.id })
      .from(productRoutes)
      .where(eq(productRoutes.offerId, offerId));
    expect(left).toEqual([]);
  });
});

describe('routes and prices (rules RT1–RT7, P1, P2)', () => {
  let productId: string;
  let fakeRouteId: string;
  let manualRouteId: string;

  beforeAll(async () => {
    productId = await product(`60 UC ${run}`);
  });

  it('refuses a route to a missing, unknown, other-kind or unmapped offer', async () => {
    const create = (payload: unknown) =>
      post(`/api/admin/catalog/products/${productId}/routes`, payload);
    expect(await body(await create({ offerId: offers.gone }))).toMatchObject({
      status: 409,
      code: 'OFFER_MISSING',
    });
    expect(
      await body(await create({ offerId: '0199a000-0000-7000-8000-000000000001' })),
    ).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(await body(await create({ offerId: offers['gift-10'] }))).toMatchObject({
      status: 409,
      code: 'ROUTE_KIND_MISMATCH',
    });
    expect(await body(await create({ offerId: offers['uc-60'] }))).toMatchObject({
      status: 409,
      code: 'ROUTE_FIELDS_UNMAPPED',
      details: { fields: ['playerId'] },
    });
    expect(
      await body(await create({ offerId: offers['uc-325'], fieldMap: { playerId: 'player_id' } })),
    ).toMatchObject({
      status: 409,
      code: 'OFFER_ALREADY_MAPPED',
      details: { productNameAr: `325 شدة ${run}` },
    });
    expect(
      await body(
        await post('/api/admin/catalog/products/0199a000-0000-7000-8000-000000000001/routes', {
          offerId: offers['uc-60'],
        }),
      ),
    ).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('maps the product to an offer and prices it from its cost at once', async () => {
    const state = await json<Routing>(
      await post(`/api/admin/catalog/products/${productId}/routes`, {
        offerId: offers['uc-60'],
        fieldMap: { playerId: 'player_id' },
      }),
      201,
    );
    fakeRouteId = state.basisRouteId as string;
    expect(state).toMatchObject({
      currentPrice: { priceUsdUnits: price(0.88), costUsdUnits: usd(0.88), routeId: fakeRouteId },
      availability: 'available',
    });
    // S17: an expected time at the policy's 30-minute limit, with no limit of its own.
    expect(
      await body(
        await post(`/api/admin/catalog/products/${productId}/routes`, {
          offerId: offers.nokind,
          expectedDeliveryMinutes: 30,
        }),
      ),
    ).toMatchObject({ status: 400, code: 'ROUTE_TIMING_INVALID' });
    expect((await routing(productId)).routes).toHaveLength(1);
  });

  it('adds a manual route as the last resort, whatever its cost (rule RT5)', async () => {
    const state = await json<Routing>(
      await post(`/api/admin/catalog/products/${productId}/routes/manual`, {
        costUsdUnits: usd(0.5),
      }),
      201,
    );
    manualRouteId = state.routes.find((route) => route.supplierCode === 'manual')?.id as string;
    expect(state.basisRouteId).toBe(fakeRouteId);
    expect(state.routes.map((route) => [route.supplierCode, route.tier])).toEqual([
      ['fake', 'healthy'],
      ['manual', 'manual'],
    ]);
    expect(
      await body(
        await post(`/api/admin/catalog/products/${productId}/routes/manual`, {
          costUsdUnits: 5,
        }),
      ),
    ).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
  });

  it('follows the manual route when the automatic one is disabled, and back', async () => {
    const disabled = await json<Routing>(
      await patch(`/api/admin/routes/${fakeRouteId}`, { enabled: false }),
      200,
    );
    expect(disabled).toMatchObject({
      basisRouteId: manualRouteId,
      currentPrice: { priceUsdUnits: price(0.5), routeId: manualRouteId },
    });
    expect(disabled.routes.find((route) => route.id === fakeRouteId)?.unusableReason).toBe(
      'disabled',
    );
    expect(
      await body(await patch(`/api/admin/routes/${fakeRouteId}`, { enabled: true, fieldMap: {} })),
    ).toMatchObject({ status: 409, code: 'ROUTE_FIELDS_UNMAPPED' });
    const enabled = await json<Routing>(
      await patch(`/api/admin/routes/${fakeRouteId}`, { enabled: true, priority: 3 }),
      200,
    );
    expect(enabled.currentPrice?.routeId).toBe(fakeRouteId);
    const audit = (await auditOf(test.db, fakeRouteId)).map((row) => row.action);
    expect(audit).toEqual([
      'product_route.created',
      'product_route.updated',
      'product_route.updated',
    ]);
  });

  it('pauses a supplier: its routes are unusable at once (rule SP3)', async () => {
    const change = (value: boolean) =>
      post('/api/admin/switches', { switch: 'fake_paused', value });
    await json(await change(true), 200);
    const paused = await routing(productId);
    expect(paused.basisRouteId).toBe(manualRouteId);
    expect(paused.routes.find((route) => route.id === fakeRouteId)?.unusableReason).toBe(
      'supplier_paused',
    );
    await json(await change(false), 200);
    expect((await routing(productId)).currentPrice?.routeId).toBe(fakeRouteId);
  });

  it('sets a manual cost with its history, refused on an automatic route', async () => {
    const state = await json<Routing>(
      await put(`/api/admin/routes/${manualRouteId}/manual-cost`, { costUsdUnits: usd(1.2) }),
      200,
    );
    expect(state.basisRouteId).toBe(fakeRouteId);
    expect(
      await body(
        await put(`/api/admin/routes/${fakeRouteId}/manual-cost`, { costUsdUnits: usd(1) }),
      ),
    ).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    const manualOffer = (
      await test.db
        .select({ id: supplierOffers.id })
        .from(supplierOffers)
        .where(eq(supplierOffers.supplierId, ids.manual))
        .orderBy(desc(supplierOffers.createdAt))
        .limit(1)
    )[0]?.id as string;
    const costs = await json<{
      items: { fromUsdUnits: number | null; toUsdUnits: number; byAdmin: boolean }[];
    }>(await get(`/api/admin/suppliers/offers/${manualOffer}/costs`), 200);
    expect(costs.items.map((item) => [item.fromUsdUnits, item.toUsdUnits, item.byAdmin])).toEqual([
      [usd(0.5), usd(1.2), true],
      [null, usd(0.5), true],
    ]);
  });

  it('archives and restores a route, beside another route of its supplier (S17 WR1)', async () => {
    const archived = await json<Routing>(
      await post(`/api/admin/routes/${manualRouteId}/archive`),
      200,
    );
    expect(archived.routes.find((route) => route.id === manualRouteId)?.archivedAt).not.toBeNull();
    const second = await json<Routing>(
      await post(`/api/admin/catalog/products/${productId}/routes/manual`, {
        costUsdUnits: usd(2),
      }),
      201,
    );
    const newManual = second.routes.find(
      (route) => route.supplierCode === 'manual' && !route.archivedAt,
    )?.id as string;
    // RT7: one live manual route a product, by add and by restore (audit A05-12).
    expect(
      await body(
        await post(`/api/admin/catalog/products/${productId}/routes/manual`, {
          costUsdUnits: usd(3),
        }),
      ),
    ).toMatchObject({ status: 409, code: 'MANUAL_ROUTE_EXISTS' });
    expect(await body(await post(`/api/admin/routes/${manualRouteId}/restore`))).toMatchObject({
      status: 409,
      code: 'MANUAL_ROUTE_EXISTS',
    });
    await json(await post(`/api/admin/routes/${newManual}/archive`), 200);
    const restored = await json<Routing>(
      await post(`/api/admin/routes/${manualRouteId}/restore`),
      200,
    );
    expect(restored.routes.find((route) => route.id === manualRouteId)?.archivedAt).toBeNull();
  });

  it('shows the price, SYP price, basis supplier and availability on the game', async () => {
    const game = await json<{
      products: {
        id: string;
        priceUsdUnits: number | null;
        basisSupplierNameAr: string | null;
        availability: string;
        reviewOpen: boolean;
      }[];
    }>(await get(`/api/admin/catalog/games/${ids.gameId}`), 200);
    expect(game.products.find((item) => item.id === productId)).toMatchObject({
      priceUsdUnits: price(0.88),
      basisSupplierNameAr: 'مورد تجريبي',
      availability: 'available',
      reviewOpen: false,
    });
  });

  it('adds a second route of one supplier that does not count for the price (S17 WR1–WR6)', async () => {
    const id = await product(`ويب ${run}`);
    const autoOffer = await fakeOffer('s17-auto', { cost: 1 });
    const webOffer = await fakeOffer('s17-web', { cost: 0.9 });
    const fieldMap = { playerId: 'player_id' };
    const auto = await json<Routing>(
      await post(`/api/admin/catalog/products/${id}/routes`, { offerId: autoOffer, fieldMap }),
      201,
    );
    const autoRoute = auto.basisRouteId as string;
    const both = await json<Routing>(
      await post(`/api/admin/catalog/products/${id}/routes`, {
        offerId: webOffer,
        fieldMap,
        priceBasis: false,
        expectedDeliveryMinutes: 30,
        hardLimitMinutes: 45,
      }),
      201,
    );
    const web = both.routes.find((route) => route.offer.id === webOffer) as Routing['routes'][0];
    expect(web).toMatchObject({
      priceBasis: false,
      expectedDeliveryMinutes: 30,
      hardLimitMinutes: 45,
      basis: false,
    });
    // The router meets the cheaper route first; the price stays on the one that counts (WR3).
    expect(both.routes[0]?.id).toBe(web.id);
    expect(both).toMatchObject({
      basisRouteId: autoRoute,
      priceHeld: false,
      currentPrice: { priceUsdUnits: price(1), routeId: autoRoute },
    });
    expect(
      await body(await patch(`/api/admin/routes/${web.id}`, { hardLimitMinutes: 20 })),
    ).toMatchObject({ status: 400, code: 'ROUTE_TIMING_INVALID' });
    // WR4: no route that counts is usable: the price stays as it is.
    const held = await json<Routing>(
      await patch(`/api/admin/routes/${autoRoute}`, { enabled: false }),
      200,
    );
    expect(held).toMatchObject({
      basisRouteId: null,
      priceHeld: true,
      availability: 'available',
      currentPrice: { routeId: autoRoute },
    });
    await json(await patch(`/api/admin/routes/${autoRoute}`, { enabled: true }), 200);
    // WR6: counting it reprices at once, with no review.
    const counted = await json<Routing>(
      await patch(`/api/admin/routes/${web.id}`, { priceBasis: true }),
      200,
    );
    expect(counted).toMatchObject({
      basisRouteId: web.id,
      openReview: null,
      currentPrice: { priceUsdUnits: price(0.9), routeId: web.id },
    });
    const entries = await auditOf(test.db, web.id);
    expect(entries.map((entry) => entry.action)).toEqual([
      'product_route.created',
      'product_route.updated',
    ]);
    expect(entries.at(-1)?.details).toEqual({
      productId: id,
      before: { priceBasis: false },
      after: { priceBasis: true },
    });
    expect(entries[0]?.details).toMatchObject({
      priceBasis: false,
      expectedDeliveryMinutes: 30,
      hardLimitMinutes: 45,
    });
  });

  it('maps one offer to one product when two ask at once (rule RT1)', async () => {
    const [a, b] = [await product(`أ ${run}`), await product(`ب ${run}`)];
    const offerId = await fakeOffer('race', { cost: 1 });
    const answers = await Promise.all(
      [a, b].map((id) =>
        post(`/api/admin/catalog/products/${id}/routes`, {
          offerId,
          fieldMap: { playerId: 'player_id' },
        }),
      ),
    );
    expect(answers.map((response) => response.status).sort()).toEqual([201, 409]);
    const refused = await body(answers.find((response) => response.status === 409) as Response);
    expect(refused.code).toBe('OFFER_ALREADY_MAPPED');
  });

  it('follows the backup route when a mapped field is archived, and back (rules RT3, P2)', async () => {
    const field = (
      await json<{ fields: { id: string; key: string }[] }>(
        await get(`/api/admin/catalog/games/${ids.gameId}`),
        200,
      )
    ).fields.find((item) => item.key === 'player_id')?.id as string;
    // The game needs a required field while active: add a second one first.
    const spare = await json<{ id: string }>(
      await post(`/api/admin/catalog/games/${ids.gameId}/fields`, {
        key: `spare_${run}`,
        labelAr: 'احتياطي',
        type: 'text',
        required: true,
      }),
      201,
    );
    await json(await post(`/api/admin/catalog/fields/${field}/archive`), 200);
    const archived = await routing(productId);
    expect(archived.currentPrice?.routeId).toBe(manualRouteId);
    expect(archived.routes.find((route) => route.id === fakeRouteId)?.unusableReason).toBe(
      'fields_incomplete',
    );
    await json(await post(`/api/admin/catalog/fields/${field}/restore`), 200);
    expect((await routing(productId)).currentPrice?.routeId).toBe(fakeRouteId);
    await json(await post(`/api/admin/catalog/fields/${spare.id}/archive`), 200);
  });

  it('never attaches a manual offer to another product (rule RT7)', async () => {
    const other = await product(`يدوي آخر ${run}`);
    const manualOffer = (
      await test.db
        .select({ id: supplierOffers.id })
        .from(supplierOffers)
        .where(eq(supplierOffers.supplierId, ids.manual))
        .orderBy(desc(supplierOffers.createdAt))
        .limit(1)
    )[0]?.id as string;
    expect(
      await body(
        await post(`/api/admin/catalog/products/${other}/routes`, { offerId: manualOffer }),
      ),
    ).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    expect(
      await body(
        await post('/api/admin/suppliers/manual/import', {
          gameId: ids.gameId,
          kind: 'direct',
          rows: [{ offerId: manualOffer, nameAr: `يدوي مستورد ${run}` }],
        }),
      ),
    ).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
  });

  it('lists the stored prices newest first', async () => {
    const prices = await json<{ items: { cause: string; supplierCode: string }[]; total: number }>(
      await get(`/api/admin/catalog/products/${productId}/prices`),
      200,
    );
    expect(prices.items[0]).toMatchObject({ supplierCode: 'fake', cause: 'route_change' });
    expect(
      await body(
        await get('/api/admin/catalog/products/0199a000-0000-7000-8000-000000000001/prices'),
      ),
    ).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('refuses a display step above 2% of the cheapest available product (rule P9)', async () => {
    // $0.98 at 118 SYP: 115.64 SYP, 2% is 2.31: at most 2 pounds.
    const refused = await body(
      await post('/api/admin/rates', {
        sypPerUsd: '118',
        displayStepSypUnits: 500,
        rateConfirmation: '118',
      }),
    );
    expect(refused).toMatchObject({
      status: 400,
      code: 'DISPLAY_STEP_TOO_LARGE',
      details: { maxStepSypUnits: expect.any(Number) },
    });
  });
});

describe('reviews (rules P3, P4, P5)', () => {
  let productId: string;
  let reviewId: string;

  const decide = (decisions: unknown[]) => post('/api/admin/pricing/reviews/decide', { decisions });

  beforeAll(async () => {
    productId = await product(`مراجعة ${run}`);
    await fakeOffer('review', { cost: 0.92 });
    await json(
      await post(`/api/admin/catalog/products/${productId}/routes`, {
        offerId: offers.review,
        fieldMap: { playerId: 'player_id' },
      }),
      201,
    );
  });

  it('holds a sync change above 10% for review; the guard pauses the held price', async () => {
    expect(await syncCost('review', 1.1, [productId])).toEqual({
      repriced: 0,
      reviewsOpened: 1,
      listRowsAppended: 0,
    });
    const state = await routing(productId);
    expect(state).toMatchObject({
      currentPrice: { priceUsdUnits: price(0.92) },
      openReview: { proposedPriceUsdUnits: price(1.1), costAfterUsdUnits: usd(1.1) },
      availability: 'paused_by_margin_guard',
    });
    reviewId = state.openReview?.id as string;
    const page = await json<{ items: { id: string; heldMarginUsdUnits: number }[] }>(
      await get('/api/admin/pricing/reviews?supplier=fake&pageSize=100'),
      200,
    );
    expect(page.items.find((item) => item.id === reviewId)).toMatchObject({
      heldMarginUsdUnits: price(0.92) - usd(1.1),
    });
    expect(await body(await get('/api/admin/pricing/reviews?status=nope'))).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
  });

  it('refreshes the proposal on a rule change (P5)', async () => {
    await json(
      await put('/api/admin/pricing/rules', {
        scope: 'product',
        targetId: productId,
        ...RULE,
        percentBp: 2000,
      }),
      200,
    );
    const state = await routing(productId);
    expect(state.openReview?.proposedPriceUsdUnits).toBe(
      priceFromCost(usd(1.1), { ...RULE, percentBp: 2000 }),
    );
    expect(state.currentPrice?.priceUsdUnits).toBe(price(0.92));
  });

  it('refuses a stale accept with the new figure, then accepts', async () => {
    const proposed = priceFromCost(usd(1.1), { ...RULE, percentBp: 2000 });
    const stale = await json<{ results: unknown[] }>(
      await decide([
        { reviewId, action: 'accept', expectedPriceUsdUnits: price(1.1) },
        { reviewId: '0199a000-0000-7000-8000-000000000001', action: 'accept' },
      ]),
      200,
    );
    expect(stale.results).toEqual([
      { reviewId, result: 'refused', errorCode: 'REVIEW_STALE', proposedPriceUsdUnits: proposed },
      {
        reviewId: '0199a000-0000-7000-8000-000000000001',
        result: 'refused',
        errorCode: 'NOT_FOUND',
      },
    ]);
    const accepted = await json<{ results: unknown[] }>(
      await decide([{ reviewId, action: 'accept', expectedPriceUsdUnits: proposed }]),
      200,
    );
    expect(accepted.results).toEqual([{ reviewId, result: 'accepted' }]);
    const rows = await test.db
      .select()
      .from(productPrices)
      .where(eq(productPrices.productId, productId))
      .orderBy(desc(productPrices.createdAt));
    const newest = (listId: string) => rows.find((row) => row.priceListId === listId);
    expect(newest(ROOT_PRICE_LIST_IDS.retail)).toMatchObject({
      priceUsdUnits: proposed,
      cause: 'review_accepted',
      reviewId,
    });
    // S20 RP2: the review held every list; accepting reprices them all with its cause.
    expect(newest(ROOT_PRICE_LIST_IDS.wholesale)).toMatchObject({
      priceUsdUnits: priceFromCost(usd(1.1), {
        percentBp: 500,
        fixedUsdUnits: 0,
        minMarginUsdUnits: usd(0.05),
      }),
      costUsdUnits: usd(1.1),
      cause: 'review_accepted',
      reviewId,
    });
    expect((await routing(productId)).availability).toBe('available');
    expect(
      (await json<{ results: unknown[] }>(await decide([{ reviewId, action: 'pause' }]), 200))
        .results,
    ).toEqual([{ reviewId, result: 'refused', errorCode: 'REVIEW_CLOSED' }]);
    expect((await auditOf(test.db, reviewId)).map((row) => row.details)).toEqual([
      { productId, priceBeforeUsdUnits: price(0.92), priceAfterUsdUnits: proposed },
    ]);
  });

  it('decides a review once when two decisions arrive at once', async () => {
    const other = await product(`سباق ${run}`);
    await fakeOffer('race-review', { cost: 1 });
    await json(
      await post(`/api/admin/catalog/products/${other}/routes`, {
        offerId: offers['race-review'],
        fieldMap: { playerId: 'player_id' },
      }),
      201,
    );
    await syncCost('race-review', 1.5, [other]);
    const review = (await routing(other)).openReview?.id as string;
    const answers = await Promise.all([
      decide([{ reviewId: review, action: 'accept' }]),
      decide([{ reviewId: review, action: 'pause' }]),
    ]);
    const results = (
      await Promise.all(
        answers.map((response) => json<{ results: { result: string }[] }>(response, 200)),
      )
    ).map((payload) => payload.results[0]?.result);
    expect(results.filter((result) => result === 'refused')).toHaveLength(1);
    expect((await auditOf(test.db, review)).length).toBe(1);
  });

  it('pauses the product from a review, keeping the price', async () => {
    const before = (await routing(productId)).currentPrice?.priceUsdUnits;
    await syncCost('review', 2, [productId]);
    const review = (await routing(productId)).openReview?.id as string;
    expect(
      (
        await json<{ results: unknown[] }>(
          await decide([{ reviewId: review, action: 'pause' }]),
          200,
        )
      ).results,
    ).toEqual([{ reviewId: review, result: 'paused' }]);
    const state = await routing(productId);
    expect(state).toMatchObject({ availability: 'paused', openReview: null });
    expect(state.currentPrice?.priceUsdUnits).toBe(before);
    expect((await auditOf(test.db, productId)).map((row) => row.action)).toContain(
      'catalog_product.updated',
    );
  });

  it('adjusts the margin from a review: a product rule and its price in one change', async () => {
    await syncCost('review', 3, [productId]);
    const review = (await routing(productId)).openReview?.id as string;
    const values = { percentBp: 500, fixedUsdUnits: 0, minMarginUsdUnits: usd(0.1) };
    const decided = await json<{ status: string; id: string }>(
      await post(`/api/admin/pricing/reviews/${review}/adjust-margin`, values),
      200,
    );
    expect(decided).toMatchObject({ id: review, status: 'margin_adjusted' });
    expect((await routing(productId)).currentPrice?.priceUsdUnits).toBe(
      priceFromCost(usd(3), values),
    );
    expect(
      await body(await post(`/api/admin/pricing/reviews/${review}/adjust-margin`, values)),
    ).toMatchObject({ status: 409, code: 'REVIEW_CLOSED' });
    expect(
      (
        await test.db.select().from(priceReviews).where(eq(priceReviews.productId, productId))
      ).every((row) => row.status !== 'open'),
    ).toBe(true);
  });

  it("guards a held price with its own row's minimum, not a lowered rule's (A05-10)", async () => {
    const held = await product(`حد محجوز ${run}`);
    const values = { percentBp: 0, fixedUsdUnits: 0, minMarginUsdUnits: usd(0.3) };
    await json(
      await put('/api/admin/pricing/rules', { scope: 'product', targetId: held, ...values }),
      200,
    );
    await fakeOffer('held-guard', { cost: 1 });
    await json(
      await post(`/api/admin/catalog/products/${held}/routes`, {
        offerId: offers['held-guard'],
        fieldMap: { playerId: 'player_id' },
      }),
      201,
    );
    // $1.30 held at a cost of $1.12: $0.18 of margin, under the row's $0.30.
    await syncCost('held-guard', 1.12, [held]);
    expect(await routing(held)).toMatchObject({
      currentPrice: { priceUsdUnits: usd(1.3) },
      availability: 'paused_by_margin_guard',
    });
    // A purchase would copy the row's $0.30: a $0.05 rule must not show the pack available.
    await json(
      await put('/api/admin/pricing/rules', {
        scope: 'product',
        targetId: held,
        ...values,
        minMarginUsdUnits: usd(0.05),
      }),
      200,
    );
    expect(await routing(held)).toMatchObject({
      currentPrice: { priceUsdUnits: usd(1.3) },
      availability: 'paused_by_margin_guard',
    });
  });

  it('adjusting the margin to the held price writes the new rule and cost (A05-1)', async () => {
    const held = await product(`هامش ثابت ${run}`);
    await fakeOffer('held-margin', { cost: 1 });
    await json(
      await post(`/api/admin/catalog/products/${held}/routes`, {
        offerId: offers['held-margin'],
        fieldMap: { playerId: 'player_id' },
      }),
      201,
    );
    await syncCost('held-margin', 0.8, [held]);
    const review = (await routing(held)).openReview?.id as string;
    // $0.80 + $0.30 keeps the held $1.10.
    const values = { percentBp: 0, fixedUsdUnits: usd(0.3), minMarginUsdUnits: usd(0.01) };
    expect(priceFromCost(usd(0.8), values)).toBe(price(1));
    await json(await post(`/api/admin/pricing/reviews/${review}/adjust-margin`, values), 200);
    const [newest] = await test.db
      .select()
      .from(productPrices)
      .where(
        and(
          eq(productPrices.productId, held),
          eq(productPrices.priceListId, ROOT_PRICE_LIST_IDS.retail),
        ),
      )
      .orderBy(desc(productPrices.createdAt), desc(productPrices.id))
      .limit(1);
    expect(newest).toMatchObject({
      priceUsdUnits: price(1),
      costUsdUnits: usd(0.8),
      minMarginUsdUnits: usd(0.01),
      cause: 'margin_adjusted',
      reviewId: review,
    });
    // The same cost again opens no review: the row in force holds it.
    expect(await syncCost('held-margin', 0.8, [held])).toMatchObject({ reviewsOpened: 0 });
    expect((await routing(held)).openReview).toBeNull();
  });
});

describe('the supplier policy', () => {
  it('reads the defaults and saves a new version, audited', async () => {
    await json(await put('/api/admin/suppliers/policy', SUPPLIER_POLICY_DEFAULTS), 200);
    expect(await json(await get('/api/admin/suppliers/policy'), 200)).toEqual(
      SUPPLIER_POLICY_DEFAULTS,
    );
    const changed = { ...SUPPLIER_POLICY_DEFAULTS, costStaleMinutes: 30 };
    expect(await json(await put('/api/admin/suppliers/policy', changed), 200)).toEqual(changed);
    expect(
      await body(await put('/api/admin/suppliers/policy', { ...changed, downSuccessBp: 9_500 })),
    ).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
  });
});

describe('catalog changes that move a price (audit A2)', () => {
  it('a move to a category with its own margin rule reprices the game at once', async () => {
    await reauthenticate();
    const target = await json<{ id: string }>(
      await post('/api/admin/catalog/categories', { slug: `move-${run}`, nameAr: `نقل ${run}` }),
      201,
    );
    categories.push(target.id);
    const wide = { percentBp: 0, fixedUsdUnits: usd(0.5), minMarginUsdUnits: usd(0.5) };
    await json(
      await put('/api/admin/pricing/rules', { scope: 'category', targetId: target.id, ...wide }),
      200,
    );
    const game = await json<{ id: string }>(
      await post('/api/admin/catalog/games', {
        categoryId: ids.categoryId,
        slug: `moving-${run}`,
        nameAr: `لعبة تنتقل ${run}`,
        nameEn: 'Moving',
      }),
      201,
    );
    const productId = await product('باقة تنتقل', game.id, 'code');
    await json(
      await post(`/api/admin/catalog/products/${productId}/routes/manual`, {
        costUsdUnits: usd(1),
      }),
      201,
    );
    expect((await routing(productId)).currentPrice?.priceUsdUnits).toBe(price(1));

    await json(await patch(`/api/admin/catalog/games/${game.id}`, { categoryId: target.id }), 200);
    const moved = await routing(productId);
    expect(moved.currentPrice?.priceUsdUnits).toBe(priceFromCost(usd(1), wide));
    expect(moved.targetPriceUsdUnits).toBe(moved.currentPrice?.priceUsdUnits);
  });

  /** A game of its own with one code pack on a manual route at $1. */
  async function pricedGame(slug: string, categoryId = ids.categoryId) {
    const game = await json<{ id: string }>(
      await post('/api/admin/catalog/games', {
        categoryId,
        slug: `${slug}-${run}`,
        nameAr: `لعبة ${slug} ${run}`,
        nameEn: 'Game',
      }),
      201,
    );
    const productId = await product(`باقة ${slug}`, game.id, 'code');
    await json(
      await post(`/api/admin/catalog/products/${productId}/routes/manual`, {
        costUsdUnits: usd(1),
      }),
      201,
    );
    return { gameId: game.id, productId };
  }

  const priceOf = async (productId: string) =>
    (await routing(productId)).currentPrice?.priceUsdUnits;
  const margin = (dollars: number) => ({
    percentBp: 0,
    fixedUsdUnits: usd(dollars),
    minMarginUsdUnits: usd(dollars),
  });
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('a restored pack or game is priced on the rules changed while it was archived (F8-1)', async () => {
    await reauthenticate();
    const category = await json<{ id: string }>(
      await post('/api/admin/catalog/categories', { slug: `back-${run}`, nameAr: `عودة ${run}` }),
      201,
    );
    categories.push(category.id);
    const { gameId, productId } = await pricedGame('restored', category.id);
    expect(await priceOf(productId)).toBe(price(1));

    await json(await post(`/api/admin/catalog/products/${productId}/archive`), 200);
    const rule = await json<{ id: string }>(
      await put('/api/admin/pricing/rules', { scope: 'game', targetId: gameId, ...margin(0.5) }),
      200,
    );
    await json(await post(`/api/admin/catalog/products/${productId}/restore`), 200);
    expect(await priceOf(productId)).toBe(usd(1.5));

    await json(await post(`/api/admin/catalog/games/${gameId}/archive`), 200);
    expect((await post(`/api/admin/pricing/rules/${rule.id}/archive`)).status).toBe(204);
    await json(
      await put('/api/admin/pricing/rules', {
        scope: 'category',
        targetId: category.id,
        ...margin(0.7),
      }),
      200,
    );
    expect(await priceOf(productId)).toBe(usd(1.5));
    await json(await post(`/api/admin/catalog/games/${gameId}/restore`), 200);
    expect(await priceOf(productId)).toBe(usd(1.7));
  });

  it("a pack's maximum quantity edit reprices it on the routes it may use now (audit A03-2)", async () => {
    await reauthenticate();
    // Its manual route at $1 is the last resort behind a fake one at $0.50 (RT5; one live
    // manual route a product, A05-12).
    const { productId } = await pricedGame('bounded');
    await fakeOffer('bounded', { cost: 0.5, kind: 'code', required: [] });
    await json(
      await post(`/api/admin/catalog/products/${productId}/routes`, { offerId: offers.bounded }),
      201,
    );
    expect(await priceOf(productId)).toBe(price(0.5));
    // The fake offer takes at most 5 units per order (S19), recorded without a repricing.
    await test.db
      .update(supplierOffers)
      .set({ maxQuantity: 5 })
      .where(eq(supplierOffers.id, offers.bounded as string));

    await json(await patch(`/api/admin/catalog/products/${productId}`, { maxQuantity: 8 }), 200);
    expect(await priceOf(productId)).toBe(price(1));
    await json(await patch(`/api/admin/catalog/products/${productId}`, { maxQuantity: 5 }), 200);
    expect(await priceOf(productId)).toBe(price(0.5));
  });

  it('a rule change waiting on a repricing that holds its pack does not deadlock (F8-3)', async () => {
    await reauthenticate();
    const { gameId, productId } = await pricedGame('deadlock');
    await json(
      await put('/api/admin/pricing/rules', { scope: 'game', targetId: gameId, ...margin(0.5) }),
      200,
    );
    let saved: Promise<Response> | undefined;
    // A sync's repricing: the pack locked, then a price row naming the rule it read.
    await test.db.transaction(async (tx) => {
      await lockProductsForPricing(tx, [productId]);
      saved = put('/api/admin/pricing/rules', { scope: 'game', targetId: gameId, ...margin(0.7) });
      await pause(1000);
      const states = await productRoutingStates(tx, [productId], {
        now: new Date(),
        fakeEnabled: true,
      });
      await appendProductPrice(tx, states.get(productId) as ProductRoutingState, 'cost_sync');
    });
    await json(await (saved as Promise<Response>), 200);
    expect(await priceOf(productId)).toBe(usd(1.7));
  });

  it("a game's first rule reprices a pack imported into it at the same time (F8-4)", async () => {
    await reauthenticate();
    const { gameId } = await pricedGame('importing');
    const [manual] = await test.db.select().from(suppliers).where(eq(suppliers.code, 'manual'));
    const productId = newId();
    let saved: Promise<Response> | undefined;
    // An import: the game locked, a pack and its route added and priced on the rule it reads.
    await test.db.transaction(async (tx) => {
      await tx.select().from(catalogGames).where(eq(catalogGames.id, gameId)).for('no key update');
      await tx.insert(catalogProducts).values({
        id: productId,
        gameId,
        kind: 'code',
        nameAr: 'باقة مستوردة',
        maxQuantity: 1,
        status: 'paused',
        sortOrder: 99,
      });
      const offerId = newId();
      const now = new Date();
      await tx.insert(supplierOffers).values({
        id: offerId,
        supplierId: (manual as { id: string }).id,
        offerId,
        name: 'باقة مستوردة',
        kind: 'code',
        requiredFields: [],
        costUsdUnits: usd(1),
        inStock: true,
        costConfirmedAt: now,
        lastSeenAt: now,
      });
      await tx.insert(productRoutes).values({
        id: newId(),
        productId,
        supplierId: (manual as { id: string }).id,
        offerId,
      });
      await repriceProducts(tx, {
        productIds: [productId],
        cause: 'route_change',
        context: { now, fakeEnabled: true },
      });
      saved = put('/api/admin/pricing/rules', { scope: 'game', targetId: gameId, ...margin(0.5) });
      await pause(1000);
    });
    await json(await (saved as Promise<Response>), 200);
    expect(await priceOf(productId)).toBe(usd(1.5));
  });
});

describe('S18 panel reads: the connection test, calls, a category, link candidates, discounts', () => {
  it('tests the connection once per 10 seconds, recorded outside health and audited', async () => {
    const tested = await json<{ ok: boolean; balance: { currency: string } | null }>(
      await post('/api/admin/suppliers/fake/test'),
      200,
    );
    expect(tested).toMatchObject({ ok: true, failureKind: null, balance: { currency: 'USD' } });
    expect(await body(await post('/api/admin/suppliers/fake/test'))).toMatchObject({
      code: 'RATE_LIMITED',
    });
    const calls = await json<{ items: { operation: string; result: string }[] }>(
      await get('/api/admin/suppliers/fake/calls?pageSize=5'),
      200,
    );
    expect(calls.items[0]).toMatchObject({ operation: 'test_connection', result: 'ok' });
    const audit = await auditOf(test.db, ids.fake);
    expect(audit.at(-1)).toMatchObject({
      action: 'supplier.connection_tested',
      details: { supplier: 'fake', ok: true, failureKind: null },
    });
    expect((await client.post('/api/admin/suppliers/fake/test', {})).status).toBe(401);
    expect(
      (await client.post('/api/admin/suppliers/fake/test', { cookie: customerCookie })).status,
    ).toBe(401);
  });

  it('lists the calls that failed, with why', async () => {
    const id = newId();
    await test.db.insert(supplierCalls).values({
      id,
      supplierId: ids.fake,
      operation: 'get_balance',
      result: 'error',
      latencyMs: 15_000,
      failureKind: 'timeout',
    });
    const page = await json<{ items: { id: string }[] }>(
      await get('/api/admin/suppliers/fake/calls?result=error&pageSize=100'),
      200,
    );
    expect(page.items.find((call) => call.id === id)).toMatchObject({
      result: 'error',
      failureKind: 'timeout',
      httpStatus: null,
    });
    expect((await client.get('/api/admin/suppliers/fake/calls', {})).status).toBe(401);
  });

  it('reads one category with its path, and 404 for one never listed', async () => {
    const now = new Date();
    await test.db.insert(supplierCategories).values([
      { supplierId: ids.fake, categoryId: `root-${run}`, name: 'PUBG Mobile', lastSeenAt: now },
      {
        supplierId: ids.fake,
        categoryId: `leaf-${run}`,
        parentCategoryId: `root-${run}`,
        name: 'Global',
        kind: 'direct',
        lastSeenAt: now,
        gameId: ids.gameId,
        linkedAt: now,
      },
    ]);
    expect(
      await json(await get(`/api/admin/suppliers/fake/categories/leaf-${run}`), 200),
    ).toMatchObject({
      categoryId: `leaf-${run}`,
      name: 'Global',
      path: ['PUBG Mobile'],
      game: { id: ids.gameId },
      linkedHere: true,
    });
    expect((await get(`/api/admin/suppliers/fake/categories/none-${run}`)).status).toBe(404);
    const path = `/api/admin/suppliers/fake/categories/leaf-${run}`;
    expect((await client.get(path, {})).status).toBe(401);
    expect((await client.get(path, { cookie: customerCookie })).status).toBe(401);
    expect((await get('/api/admin/suppliers/fake/categories/bad%20id')).status).toBe(404);
  });

  it('proposes the packs of the category game, its amount first, then a search', async () => {
    const sixty = await json<{ id: string }>(
      await post(`/api/admin/catalog/games/${ids.gameId}/products`, {
        kind: 'direct',
        nameAr: `60 شدة ${run}`,
        gameAmount: 60,
      }),
      201,
    );
    const searchGame = await json<{ id: string }>(
      await post('/api/admin/catalog/games', {
        categoryId: ids.categoryId,
        slug: `search-${run}`,
        nameAr: `لعبة بحث ${run}`,
        nameEn: 'Game',
      }),
      201,
    );
    const other = await json<{ id: string }>(
      await post(`/api/admin/catalog/games/${searchGame.id}/products`, {
        kind: 'direct',
        nameAr: `بحث ${run}`,
      }),
      201,
    );
    const [offer] = await test.db
      .insert(supplierOffers)
      .values({
        supplierId: ids.fake,
        offerId: `link-${run}`,
        name: 'Global · 60 UC',
        kind: 'direct',
        costUsdUnits: usd(0.88),
        inStock: true,
        costConfirmedAt: new Date(),
        lastSeenAt: new Date(),
        categoryId: `leaf-${run}`,
      })
      .returning({ id: supplierOffers.id });
    const candidates = await json<{ productId: string; reason: string }[]>(
      await get(
        `/api/admin/suppliers/offers/${offer?.id}/link-candidates?q=${encodeURIComponent(`بحث ${run}`)}`,
      ),
      200,
    );
    expect(candidates[0]).toMatchObject({
      productId: sixty.id,
      reason: 'amount',
      routedBySupplier: false,
    });
    expect(candidates.find((item) => item.productId === other.id)?.reason).toBe('search');
    expect((await get(`/api/admin/suppliers/offers/${newId()}/link-candidates`)).status).toBe(404);
    const path = `/api/admin/suppliers/offers/${offer?.id}/link-candidates`;
    expect((await client.get(path, {})).status).toBe(401);
    expect((await client.get(path, { cookie: customerCookie })).status).toBe(401);
  });

  it('filters and shows the supplier discount (DC1)', async () => {
    const [offer] = await test.db
      .insert(supplierOffers)
      .values({
        supplierId: ids.fake,
        offerId: `vip-${run}`,
        name: `VIP ${run}`,
        kind: 'direct',
        costUsdUnits: usd(0.875),
        originalCostUsdUnits: usd(0.887),
        discountBp: 200,
        inStock: true,
        costConfirmedAt: new Date(),
        lastSeenAt: new Date(),
      })
      .returning({ id: supplierOffers.id });
    const page = await json<{ items: { id: string; discountBp: number | null }[] }>(
      await get(
        `/api/admin/suppliers/fake/offers?discounted=true&q=${encodeURIComponent(`VIP ${run}`)}`,
      ),
      200,
    );
    expect(page.items).toMatchObject([{ id: offer?.id, discountBp: 200, discountPercent: 1 }]);
    const none = await json<{ items: unknown[] }>(
      await get(
        `/api/admin/suppliers/fake/offers?discounted=false&q=${encodeURIComponent(`VIP ${run}`)}`,
      ),
      200,
    );
    expect(none.items).toEqual([]);
  });
});
