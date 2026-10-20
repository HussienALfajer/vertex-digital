import { randomBytes, randomUUID } from 'node:crypto';
import { PRICE_LISTS_MAX_CUSTOM, ROOT_PRICE_LIST_IDS } from '@vertex-digital/contracts';
import {
  catalogCategories,
  customers,
  ensureCustomerWallet,
  ensureSystemAccount,
  newId,
  postJournal,
  priceLists,
  supplierBalanceReads,
  supplierOffers,
  supplierSyncRuns,
  suppliers,
} from '@vertex-digital/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  api,
  auditOf,
  notificationsOf,
  PASSWORD,
  removeAccounts,
  seedCustomer,
  setSwitches,
  totp,
} from './helpers.js';
import { startApp, type TestApp } from './start-app.js';

/*
 * Price lists in the panel and private prices in the store (S20 PR 2) over HTTP against the test
 * database with the `fake` supplier: lists (LS1–LS6), rules per list, fixed prices (LP1), the
 * matrix, an account's list (AT2, AT3) and the customer prices route (AT4). Custom lists and the
 * category are archived in `afterAll`, so later repricings in this worker skip them.
 */

let test: TestApp;
let client: ReturnType<typeof api>;
let admin: Awaited<ReturnType<ReturnType<typeof api>['adminWithTotp']>>;
let plainAdmin: string;
const seeded: string[] = [];
const run = randomBytes(4).toString('hex');
const usd = (dollars: number) => Math.round(dollars * 1_000_000);
const { retail, wholesale, cost } = ROOT_PRICE_LIST_IDS;
const ids = { fake: '', categoryId: '', gameId: '', slug: `pl-pubg-${run}` };
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

const adminGet = (path: string) => client.get(path, { cookie: admin.cookie });
const adminSend = (method: string, path: string, payload?: unknown, cookie = admin.cookie) =>
  client.request(method, path, { cookie, body: payload });

interface List {
  id: string;
  kind: string;
  name: string;
  parentListId: string | null;
  chain: string[];
  accounts: number;
  rules: number;
  fixedPrices: number;
  fallbackCells: number;
  ready: boolean;
  archivedAt: string | null;
}

const createList = async (name: string, parentListId: string = wholesale, status = 201) =>
  json<List & { code?: string; details?: unknown }>(
    await adminSend('POST', '/api/admin/pricing/lists', { name, parentListId }),
    status,
  );

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

async function buyer(funds = usd(100)) {
  const customer = await seedCustomer(test.db);
  seeded.push(customer.id);
  if (funds === 0) return { ...customer, cookie: await client.signInCustomer(customer.email) };
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

const assign = (customerId: string, priceListId: string | null, cookie = admin.cookie) =>
  adminSend(
    'PUT',
    `/api/admin/customers/${customerId}/price-list`,
    { priceListId, reason: 'حساب جملة مُعتمد' },
    cookie,
  );

interface Prices {
  priceKind: string;
  products: { id: string; available: boolean; priceUsdUnits: number | null }[];
  rateId: string | null;
}

const pricesOf = async (cookie: string) => {
  const response = await client.get(`/api/catalog/games/${ids.slug}/prices`, { cookie });
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  return json<Prices>(response, 200);
};

const priceOf = (prices: Prices, productId: string) =>
  prices.products.find((row) => row.id === productId)?.priceUsdUnits;

beforeAll(async () => {
  test = await startApp();
  client = api(test.url);
  admin = await client.adminWithTotp(test.db);
  seeded.push(admin.id);
  plainAdmin = await client.signInAdmin(admin.email, admin.secret);
  await reauthenticate();
  await setSwitches(test.db);
  const [fake] = await test.db.select().from(suppliers).where(eq(suppliers.code, 'fake'));
  ids.fake = fake?.id as string;
  // The fake supplier is usable: configured, with a balance (S07 RT4).
  await test.db
    .insert(supplierBalanceReads)
    .values({ supplierId: ids.fake, currency: 'USD', amountUnits: usd(1_000_000) });
  await json(
    await adminSend('PUT', '/api/admin/suppliers/fake/credentials', {
      values: { webhookSecret: `whsec-${run}-lists` },
    }),
    200,
  );
  // New keys start a sync (S07 SP2) that no worker runs here: end it (SY1's one-a-minute check).
  await test.db
    .update(supplierSyncRuns)
    .set({ status: 'failed', finishedAt: new Date(), errorCode: 'TEST' })
    .where(and(eq(supplierSyncRuns.supplierId, ids.fake), eq(supplierSyncRuns.status, 'running')));
  const category = await json<{ id: string }>(
    await adminSend('POST', '/api/admin/catalog/categories', {
      slug: `pl-${run}`,
      nameAr: `قوائم ${run}`,
    }),
    201,
  );
  ids.categoryId = category.id;
  // The category's own retail rule (10%, $0.10), so other files' global changes never move it.
  await json(
    await adminSend('PUT', '/api/admin/pricing/rules', {
      scope: 'category',
      targetId: category.id,
      percentBp: 1000,
      fixedUsdUnits: 0,
      minMarginUsdUnits: usd(0.1),
    }),
    200,
  );
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
    .update(customers)
    .set({ priceListId: null })
    .where(inArray(customers.id, seeded.length > 0 ? seeded : [newId()]));
  await test.db
    .update(catalogCategories)
    .set({ archivedAt: new Date() })
    .where(eq(catalogCategories.id, ids.categoryId));
  await setSwitches(test.db);
  await removeAccounts(test.db, seeded);
  await test.app.close();
});

describe('access (S20 "Access")', () => {
  it('admits only the admin; every change needs a re-authentication', async () => {
    const someone = await buyer(0);
    const list = newId();
    const reads: [string, string][] = [
      ['GET', '/api/admin/pricing/lists'],
      ['GET', `/api/admin/pricing/lists/${list}`],
      ['GET', `/api/admin/pricing/matrix?gameId=${ids.gameId}`],
    ];
    const changes: [string, string, unknown][] = [
      ['POST', '/api/admin/pricing/lists', { name: 'VIP', parentListId: wholesale }],
      ['PATCH', `/api/admin/pricing/lists/${list}`, { name: 'VIP' }],
      ['POST', `/api/admin/pricing/lists/${list}/archive`, undefined],
      [
        'PUT',
        `/api/admin/pricing/lists/${list}/fixed-prices/${item.id}`,
        { priceUsdUnits: usd(1) },
      ],
      ['DELETE', `/api/admin/pricing/lists/${list}/fixed-prices/${item.id}`, undefined],
      [
        'PUT',
        `/api/admin/customers/${someone.id}/price-list`,
        { priceListId: null, reason: 'سبب ما' },
      ],
    ];
    for (const [method, path, payload] of [
      ...reads.map(([m, p]) => [m, p, undefined]),
      ...changes,
    ]) {
      const anonymous = await client.request(method as string, path as string, { body: payload });
      expect(anonymous.status, path as string).toBe(401);
      const asCustomer = await client.request(method as string, path as string, {
        cookie: someone.cookie,
        body: payload,
      });
      expect(asCustomer.status, path as string).toBe(401);
    }
    for (const [method, path, payload] of changes) {
      const refused = await json<{ code: string }>(
        await adminSend(method, path, payload, plainAdmin),
        403,
      );
      expect(refused.code, path).toBe('REAUTHENTICATION_REQUIRED');
    }
    // The customer prices route needs a customer session; an admin's is not one.
    expect((await client.get(`/api/catalog/games/${ids.slug}/prices`)).status).toBe(401);
    expect(
      (await client.get(`/api/catalog/games/${ids.slug}/prices`, { cookie: admin.cookie })).status,
    ).toBe(401);
  });
});

describe('lists (S20 LS1–LS6)', () => {
  it('lists the roots first, priced, with their counts', async () => {
    const lists = await json<List[]>(await adminGet('/api/admin/pricing/lists'), 200);
    expect(lists.slice(0, 3).map((list) => [list.id, list.kind, list.ready, list.chain])).toEqual([
      [retail, 'retail', true, [retail]],
      [wholesale, 'wholesale', true, [wholesale]],
      [cost, 'cost', true, [cost]],
    ]);
    expect(lists[1]?.rules).toBeGreaterThanOrEqual(1);
  });

  it('creates a custom list priced at once, renames and archives it, all audited', async () => {
    const name = `VIP ${run}`;
    const created = await createList(`  ${name}  `);
    expect(created).toMatchObject({
      kind: 'custom',
      name,
      parentListId: wholesale,
      chain: [created.id, wholesale],
      ready: true,
      archivedAt: null,
    });
    // RP3: with no rule of its own it prices as its parent, from its creation.
    const matrix = await json<{
      rows: { cells: { priceListId: string; priceUsdUnits: number }[] }[];
    }>(await adminGet(`/api/admin/pricing/matrix?gameId=${ids.gameId}&listIds=${created.id}`), 200);
    expect(matrix.rows[0]?.cells.map((cell) => [cell.priceListId, cell.priceUsdUnits])).toEqual([
      [retail, usd(1.1)],
      [created.id, usd(1.05)],
    ]);
    // Names are unique among unarchived lists, whatever their case.
    expect((await createList(name.toUpperCase(), cost, 409)).code).toBe('PRICE_LIST_NAME_TAKEN');
    const renamed = await json<List>(
      await adminSend('PATCH', `/api/admin/pricing/lists/${created.id}`, { name: `${name} ب` }),
      200,
    );
    expect(renamed.name).toBe(`${name} ب`);
    const archived = await json<List>(
      await adminSend('POST', `/api/admin/pricing/lists/${created.id}/archive`),
      200,
    );
    expect(archived.archivedAt).not.toBeNull();
    expect(
      (
        await json<{ code: string }>(
          await adminSend('PATCH', `/api/admin/pricing/lists/${created.id}`, { name: 'آخر' }),
          409,
        )
      ).code,
    ).toBe('PRICE_LIST_ARCHIVED');
    // The name is free again once the list is archived.
    await createList(name);
    const actions = (await auditOf(test.db, created.id)).map((entry) => entry.action);
    expect(actions).toEqual(['price_list.created', 'price_list.renamed', 'price_list.archived']);
  });

  it('refuses an archived parent, a chain deeper than 5 and a root list’s archive', async () => {
    const parent = await createList(`أب ${run}`);
    await adminSend('POST', `/api/admin/pricing/lists/${parent.id}/archive`);
    expect((await createList(`ابن ${run}`, parent.id, 409)).code).toBe('PRICE_LIST_ARCHIVED');
    let chainTop: string = wholesale;
    for (let depth = 2; depth <= 5; depth += 1) {
      chainTop = (await createList(`عمق ${depth} ${run}`, chainTop)).id;
    }
    expect((await createList(`عمق 6 ${run}`, chainTop, 400)).code).toBe('VALIDATION_FAILED');
    const root = await json<{ code: string }>(
      await adminSend('POST', `/api/admin/pricing/lists/${cost}/archive`),
      400,
    );
    expect(root.code).toBe('VALIDATION_FAILED');
    // A list with live children is in use (LS5).
    const [middle] = (await json<List[]>(await adminGet('/api/admin/pricing/lists'), 200)).filter(
      (list) => list.name === `عمق 2 ${run}`,
    );
    const inUse = await json<{ code: string; details: unknown }>(
      await adminSend('POST', `/api/admin/pricing/lists/${middle?.id}/archive`),
      409,
    );
    expect(inUse).toMatchObject({
      code: 'PRICE_LIST_IN_USE',
      details: { accounts: 0, children: 1 },
    });
  });

  it('refuses a 21st unarchived custom list (LS1)', async () => {
    const [live] = await test.db
      .select({ count: sql<number>`count(*)::int` })
      .from(priceLists)
      .where(and(eq(priceLists.kind, 'custom'), isNull(priceLists.archivedAt)));
    const filler = Array.from({ length: PRICE_LISTS_MAX_CUSTOM - (live?.count ?? 0) }, () => ({
      id: newId(),
      kind: 'custom' as const,
      name: `ملء ${randomBytes(4).toString('hex')}`,
      parentListId: retail,
    }));
    if (filler.length > 0) await test.db.insert(priceLists).values(filler);
    try {
      expect((await createList(`زائدة ${run}`, retail, 409)).code).toBe(
        'PRICE_LISTS_LIMIT_REACHED',
      );
    } finally {
      if (filler.length > 0) {
        await test.db
          .update(priceLists)
          .set({ archivedAt: new Date() })
          .where(
            inArray(
              priceLists.id,
              filler.map((row) => row.id),
            ),
          );
      }
    }
  });
});

describe('rules and fixed prices per list (S20 LS2, LS4, LP1)', () => {
  it('sets a list’s rules, archives a custom list’s global rule, never a root’s', async () => {
    const list = await createList(`قواعد ${run}`);
    const rule = await json<{ id: string; priceListId: string; productCount: number }>(
      await adminSend('PUT', '/api/admin/pricing/rules', {
        priceListId: list.id,
        scope: 'global',
        percentBp: 300,
        fixedUsdUnits: 0,
        minMarginUsdUnits: usd(0.02),
      }),
      200,
    );
    expect(rule.priceListId).toBe(list.id);
    expect(rule.productCount).toBeGreaterThan(0);
    const own = await json<{ id: string }[]>(
      await adminGet(`/api/admin/pricing/rules?priceListId=${list.id}`),
      200,
    );
    expect(own.map((row) => row.id)).toEqual([rule.id]);
    const preview = await json<{ priceUsdUnits: number; ruleId: string }>(
      await adminSend('POST', '/api/admin/pricing/preview', {
        target: { scope: 'product', targetId: item.id },
        costUsdUnits: usd(1),
        priceListId: list.id,
      }),
      200,
    );
    expect(preview).toMatchObject({ priceUsdUnits: usd(1.03), ruleId: rule.id });
    const [audit] = await auditOf(test.db, rule.id);
    expect(audit?.details).toMatchObject({ priceListId: list.id, scope: 'global' });
    expect((await adminSend('POST', `/api/admin/pricing/rules/${rule.id}/archive`)).status).toBe(
      204,
    );
    const [wholesaleGlobal] = (
      await json<{ id: string; scope: string }[]>(
        await adminGet(`/api/admin/pricing/rules?priceListId=${wholesale}`),
        200,
      )
    ).filter((row) => row.scope === 'global');
    const refused = await json<{ code: string }>(
      await adminSend('POST', `/api/admin/pricing/rules/${wholesaleGlobal?.id}/archive`),
      409,
    );
    expect(refused.code).toBe('GLOBAL_RULE_REQUIRED');
  });

  it('sets a fixed price, falls back below the minimum margin, and archives it', async () => {
    const list = await createList(`ثابت ${run}`);
    const path = `/api/admin/pricing/lists/${list.id}/fixed-prices/${item.id}`;
    const fixed = await json<{
      priceUsdUnits: number;
      result: { priceUsdUnits: number; source: string };
    }>(await adminSend('PUT', path, { priceUsdUnits: usd(1.07) }), 200);
    // $1.07 covers the $1 cost plus wholesale's $0.05: it stands.
    expect(fixed).toMatchObject({
      priceUsdUnits: usd(1.07),
      result: { priceUsdUnits: usd(1.07), source: 'fixed' },
    });
    const fallback = await json<{ result: { priceUsdUnits: number; source: string } }>(
      await adminSend('PUT', path, { priceUsdUnits: usd(1.02) }),
      200,
    );
    expect(fallback.result).toEqual({
      priceUsdUnits: usd(1.05),
      source: 'fixed_fallback',
      marginUsdUnits: usd(0.05),
      marginBp: 476,
    });
    const detail = await json<{ list: List; fixedPrices: { productId: string }[] }>(
      await adminGet(`/api/admin/pricing/lists/${list.id}`),
      200,
    );
    expect(detail.list).toMatchObject({ fixedPrices: 1, fallbackCells: 1 });
    expect(detail.fixedPrices.map((row) => row.productId)).toEqual([item.id]);
    expect(
      (
        await json<{ code: string }>(
          await adminSend('PUT', `/api/admin/pricing/lists/${list.id}/fixed-prices/${newId()}`, {
            priceUsdUnits: usd(1),
          }),
          404,
        )
      ).code,
    ).toBe('NOT_FOUND');
    expect((await adminSend('DELETE', path)).status).toBe(204);
    expect((await adminSend('DELETE', path)).status).toBe(404);
    const actions = (await auditOf(test.db, list.id)).map((entry) => entry.action);
    expect(actions).toEqual([
      'price_list.created',
      'price_list.fixed_price_set',
      'price_list.fixed_price_set',
      'price_list.fixed_price_archived',
    ]);
  });
});

describe('an account’s list and its private prices (S20 AT2–AT4, PO2)', () => {
  it('assigns a list, tells the customer, and serves its prices privately', async () => {
    const shopper = await buyer();
    const before = await pricesOf(shopper.cookie);
    expect(before).toMatchObject({ priceKind: 'retail' });
    expect(priceOf(before, item.id)).toBe(usd(1.1));
    const profile = await json<{ pricing: Record<string, unknown> }>(
      await assign(shopper.id, cost),
      200,
    );
    expect(profile.pricing).toEqual({
      accountType: 'customer',
      assignedListId: cost,
      effectiveList: { id: cost, kind: 'cost', name: 'سعر التكلفة' },
      priceKind: 'special',
    });
    const after = await pricesOf(shopper.cookie);
    expect(after.priceKind).toBe('special');
    expect(priceOf(after, item.id)).toBe(usd(1.01));
    const account = await json<{ priceKind: string }>(
      await client.get('/api/account', { cookie: shopper.cookie }),
      200,
    );
    expect(account.priceKind).toBe('special');
    const notices = await notificationsOf(test.db, shopper.id);
    expect(notices.map((row) => [row.event, row.params])).toContainEqual([
      'price_list_changed',
      { priceKind: 'special' },
    ]);
    const [audit] = await auditOf(test.db, shopper.id);
    expect(audit).toMatchObject({ action: 'customer.price_list_changed' });

    // The public game page is the same for everyone (AT4).
    const anonymous = await (await client.get(`/api/catalog/games/${ids.slug}`)).json();
    const signedIn = await (
      await client.get(`/api/catalog/games/${ids.slug}`, { cookie: shopper.cookie })
    ).json();
    expect(signedIn).toEqual(anonymous);

    // A purchase at the retail figure is refused with the account's price (PO2).
    const refused = await json<{ code: string; details: { unitPriceUsdUnits: number } }>(
      await client.post('/api/orders', {
        cookie: shopper.cookie,
        headers: { 'idempotency-key': randomUUID() },
        body: {
          productId: item.id,
          quantity: 1,
          fields: { player_id: '5123456789' },
          expectedUnitPriceUsdUnits: usd(1.1),
          confirmPlayer: true,
        },
      }),
      409,
    );
    expect(refused).toMatchObject({
      code: 'PRICE_CHANGED',
      details: { unitPriceUsdUnits: usd(1.01) },
    });
  });

  it('refuses an archived list and an unknown game; an assigned list cannot be archived', async () => {
    const shopper = await buyer(0);
    const list = await createList(`مُسند ${run}`);
    await json(await assign(shopper.id, list.id), 200);
    const inUse = await json<{ code: string; details: unknown }>(
      await adminSend('POST', `/api/admin/pricing/lists/${list.id}/archive`),
      409,
    );
    expect(inUse).toMatchObject({
      code: 'PRICE_LIST_IN_USE',
      details: { accounts: 1, children: 0 },
    });
    await json(await assign(shopper.id, null), 200);
    await json(await adminSend('POST', `/api/admin/pricing/lists/${list.id}/archive`), 200);
    expect((await json<{ code: string }>(await assign(shopper.id, list.id), 409)).code).toBe(
      'PRICE_LIST_ARCHIVED',
    );
    expect(
      (await client.get('/api/catalog/games/no-such-game/prices', { cookie: shopper.cookie }))
        .status,
    ).toBe(404);
  });
});
