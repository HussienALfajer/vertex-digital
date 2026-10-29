import { randomBytes, randomUUID } from 'node:crypto';
import {
  ROOT_PRICE_LIST_IDS,
  TIER_LIST_NAMES,
  TIER_SETTINGS_DEFAULTS,
} from '@vertex-digital/contracts';
import {
  catalogCategories,
  customers,
  ensureCustomerWallet,
  ensureSystemAccount,
  marginRules,
  merchantLevels,
  merchantProfiles,
  newId,
  postJournal,
  priceLists,
  productPrices,
  setupMerchantTiers,
  supplierBalanceReads,
  supplierOffers,
  supplierSyncRuns,
  suppliers,
} from '@vertex-digital/db';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
 * Merchant tiers in the panel (S23 PR 1) over HTTP against the test database with the `fake`
 * supplier: access, a tier's level and its rules (order, chain, archive), the parent cap after a
 * level change (PX2), the settings (TS1), the threshold preview (AD3), manual grants (MG1, MG3),
 * the merchants list and profile with the tier (AD1, AD5), and the privileges a grant gives:
 * deposit limits (TS3) and checkout lines (TS5). Levels, lists and the category are archived in
 * `afterAll`.
 */

let test: TestApp;
let client: ReturnType<typeof api>;
let admin: Awaited<ReturnType<ReturnType<typeof api>['adminWithTotp']>>;
let plainAdmin: string;
const seeded: string[] = [];
const run = randomBytes(4).toString('hex');
const usd = (dollars: number) => Math.round(dollars * 1_000_000);
const { retail, wholesale } = ROOT_PRICE_LIST_IDS;
const ids = { fake: '', categoryId: '', gameId: '' };
let item: { id: string };

interface Tier {
  tier: string;
  level: {
    id: string;
    monthlyThresholdUsdUnits: number;
    priceList: { id: string; parentListId: string | null };
    expectedParentListId: string;
  } | null;
  priceList: { id: string; name: string } | null;
  settings: Record<string, unknown>;
  merchants: { earned: number; granted: number };
}

async function json<T = Record<string, unknown>>(response: Response, status: number): Promise<T> {
  const payload = await response.json();
  expect(response.status, JSON.stringify(payload)).toBe(status);
  return payload as T;
}

const adminGet = (path: string) => client.get(path, { cookie: admin.cookie });
const adminSend = (method: string, path: string, payload?: unknown, cookie = admin.cookie) =>
  client.request(method, path, { cookie, body: payload });

async function reauthenticate() {
  const response = await client.post('/api/admin/me/reauthenticate', {
    cookie: admin.cookie,
    body: { password: PASSWORD, totpCode: totp(admin.secret) },
  });
  expect(response.status).toBe(200);
}

const archiveLevels = () =>
  test.db
    .update(merchantLevels)
    .set({ archivedAt: new Date() })
    .where(isNull(merchantLevels.archivedAt));

const tiers = async () =>
  (await json<{ items: Tier[] }>(await adminGet('/api/admin/merchant-tiers'), 200)).items;

const setLevel = (tier: string, level: unknown, cookie?: string) =>
  adminSend('PUT', `/api/admin/merchant-tiers/${tier}/level`, { level }, cookie);

async function customList(parentListId: string) {
  return json<{ id: string }>(
    await adminSend('POST', '/api/admin/pricing/lists', {
      name: `فئة ${randomBytes(3).toString('hex')}`,
      parentListId,
    }),
    201,
  );
}

/** A merchant who accepted the terms, with `funds` in the wallet. */
async function merchant(funds = 0) {
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
    tradeName: `محل ${randomBytes(2).toString('hex')}`,
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

const newestPrice = async (productId: string, priceListId: string) =>
  (
    await test.db
      .select()
      .from(productPrices)
      .where(
        and(eq(productPrices.productId, productId), eq(productPrices.priceListId, priceListId)),
      )
      .orderBy(desc(productPrices.createdAt), desc(productPrices.id))
      .limit(1)
  )[0];

beforeAll(async () => {
  test = await startApp();
  client = api(test.url);
  admin = await client.adminWithTotp(test.db);
  seeded.push(admin.id);
  plainAdmin = await client.signInAdmin(admin.email, admin.secret);
  await reauthenticate();
  await setSwitches(test.db);
  await archiveLevels();
  const [fake] = await test.db.select().from(suppliers).where(eq(suppliers.code, 'fake'));
  ids.fake = fake?.id as string;
  await test.db
    .insert(supplierBalanceReads)
    .values({ supplierId: ids.fake, currency: 'USD', amountUnits: usd(1_000_000) });
  await json(
    await adminSend('PUT', '/api/admin/suppliers/fake/credentials', {
      values: { webhookSecret: `whsec-${run}-tiers` },
    }),
    200,
  );
  await test.db
    .update(supplierSyncRuns)
    .set({ status: 'failed', finishedAt: new Date(), errorCode: 'TEST' })
    .where(and(eq(supplierSyncRuns.supplierId, ids.fake), eq(supplierSyncRuns.status, 'running')));
  const category = await json<{ id: string }>(
    await adminSend('POST', '/api/admin/catalog/categories', {
      slug: `tiers-${run}`,
      nameAr: `فئات ${run}`,
    }),
    201,
  );
  ids.categoryId = category.id;
  const game = await json<{ id: string }>(
    await adminSend('POST', '/api/admin/catalog/games', {
      categoryId: category.id,
      slug: `tiers-pubg-${run}`,
      nameAr: `ببجي فئات ${run}`,
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
  await archiveLevels();
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

describe('access (S23 Access)', () => {
  it('keeps the tiers to the admin and re-authenticates every change', async () => {
    const shop = await merchant();
    expect((await client.get('/api/admin/merchant-tiers')).status).toBe(401);
    expect((await client.get('/api/admin/merchant-tiers', { cookie: shop.cookie })).status).toBe(
      401,
    );
    expect(
      (await client.post('/api/admin/merchant-tiers/preview', { cookie: shop.cookie, body: {} }))
        .status,
    ).toBe(401);
    for (const [method, route, body] of [
      ['PUT', '/api/admin/merchant-tiers/silver/level', { level: null }],
      ['PUT', '/api/admin/merchant-tiers/bronze/settings', TIER_SETTINGS_DEFAULTS.bronze],
      [
        'POST',
        `/api/admin/customers/${shop.id}/merchant/tier-grant`,
        { tier: 'gold', endsOn: '2099-01-01', reason: 'شريك جديد' },
      ],
      ['POST', `/api/admin/customers/${shop.id}/merchant/tier-grant/end`, { reason: 'انتهت' }],
    ] as const) {
      expect(
        await json(await adminSend(method, route, body, plainAdmin), 403),
        route,
      ).toMatchObject({ code: 'REAUTHENTICATION_REQUIRED' });
    }
    expect(await json(await setLevel('bronze', null), 404)).toMatchObject({ code: 'NOT_FOUND' });
    expect(
      await json(
        await adminSend(
          'PUT',
          '/api/admin/merchant-tiers/platinum/settings',
          TIER_SETTINGS_DEFAULTS.bronze,
        ),
        404,
      ),
    ).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('levels per tier (S23 TS1, the levels rules, PX2, MG7)', () => {
  it('chains the tier lists, refuses what the rules refuse, caps a tier at its parent', async () => {
    let page = await tiers();
    expect(page.map((tier) => tier.tier)).toEqual(['bronze', 'silver', 'gold', 'diamond']);
    expect(page[0]).toMatchObject({ level: null, priceList: { id: wholesale } });
    expect(page.slice(1).every((tier) => tier.level === null)).toBe(true);

    const silverList = await customList(wholesale);
    const goldList = await customList(silverList.id);
    // The list must be a custom list under the next lower live tier's list.
    expect(
      await json(
        await setLevel('silver', { monthlyThresholdUsdUnits: usd(300), priceListId: goldList.id }),
        422,
      ),
    ).toMatchObject({
      code: 'MERCHANT_TIER_LIST_INVALID',
      details: { expectedParentListId: wholesale },
    });
    expect(
      await json(
        await setLevel('silver', { monthlyThresholdUsdUnits: usd(300), priceListId: retail }),
        422,
      ),
    ).toMatchObject({ code: 'MERCHANT_TIER_LIST_INVALID' });
    const silver = await json<Tier>(
      await setLevel('silver', { monthlyThresholdUsdUnits: usd(300), priceListId: silverList.id }),
      200,
    );
    expect(silver.level).toMatchObject({
      monthlyThresholdUsdUnits: usd(300),
      priceList: { id: silverList.id, parentListId: wholesale },
      expectedParentListId: wholesale,
    });
    // Thresholds rise with the tier.
    expect(
      await json(
        await setLevel('gold', { monthlyThresholdUsdUnits: usd(300), priceListId: goldList.id }),
        422,
      ),
    ).toMatchObject({ code: 'MERCHANT_TIER_ORDER_INVALID' });
    expect(
      await json(
        await setLevel('gold', { monthlyThresholdUsdUnits: usd(1000), priceListId: silverList.id }),
        422,
      ),
    ).toMatchObject({
      code: 'MERCHANT_TIER_LIST_INVALID',
      details: { expectedParentListId: silverList.id },
    });

    // A dearer rule on Gold's own list: the parent cap keeps it at Silver's price (PX2).
    await test.db.insert(marginRules).values({
      priceListId: goldList.id,
      scope: 'global',
      targetId: null,
      percentBp: 2000,
      fixedUsdUnits: 0,
      minMarginUsdUnits: usd(0.2),
    });
    const gold = await json<Tier>(
      await setLevel('gold', { monthlyThresholdUsdUnits: usd(1000), priceListId: goldList.id }),
      200,
    );
    expect(gold.level?.priceList.id).toBe(goldList.id);
    const silverPrice = await newestPrice(item.id, silverList.id);
    expect(await newestPrice(item.id, goldList.id)).toMatchObject({
      source: 'parent_cap',
      priceUsdUnits: silverPrice?.priceUsdUnits,
      ruleId: silverPrice?.ruleId,
    });
    // Its threshold changes without the chain check (edge case 3).
    await json(
      await setLevel('gold', { monthlyThresholdUsdUnits: usd(1200), priceListId: goldList.id }),
      200,
    );

    // A list named by a live level is not archived (S20 LS5).
    expect(
      await json(await adminSend('POST', `/api/admin/pricing/lists/${goldList.id}/archive`), 409),
    ).toMatchObject({ code: 'PRICE_LIST_IN_USE' });

    // Archiving Silver while Gold exists is allowed; Gold's expected parent becomes wholesale.
    await json(await setLevel('silver', null), 200);
    page = await tiers();
    expect(page[1]?.level).toBeNull();
    expect(page[2]?.level).toMatchObject({
      priceList: { parentListId: silverList.id },
      expectedParentListId: wholesale,
    });
    const audits = await auditOf(test.db, gold.level?.id as string);
    expect(audits.map((entry) => entry.action)).toEqual([
      'merchant_tier.level_changed',
      'merchant_tier.level_changed',
    ]);
    const [queued] = (
      await test.db.execute<{ count: number }>(
        sql`select count(*)::int as count from pgboss.job where name = 'merchants.level'
          and data->>'cause' = 'tiers_changed'`,
      )
    ).rows;
    expect(queued?.count ?? 0).toBeGreaterThan(0);
    await archiveLevels();
  });
});

describe('tier settings (S23 TS1, TS2)', () => {
  it('saves a new version with its audit, both limits at least the deposit minimums', async () => {
    const before = (await tiers())[0]?.settings;
    expect(before).toMatchObject(TIER_SETTINGS_DEFAULTS.bronze);
    const after = { ...TIER_SETTINGS_DEFAULTS.bronze, playerChecksPerHour: 120, bulkLinesMax: 60 };
    const saved = await json<Tier>(
      await adminSend('PUT', '/api/admin/merchant-tiers/bronze/settings', after),
      200,
    );
    expect(saved.settings).toMatchObject(after);
    expect(
      await json(
        await adminSend('PUT', '/api/admin/merchant-tiers/bronze/settings', {
          ...after,
          perDepositUsdUnits: usd(0.01),
        }),
        400,
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(
      await json(
        await adminSend('PUT', '/api/admin/merchant-tiers/bronze/settings', {
          ...after,
          bulkLinesMax: 101,
        }),
        400,
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
    const [entry] = (
      await test.db.execute<{ details: Record<string, unknown> }>(
        sql`select details from audit_entries where action = 'merchant_tier.settings_changed'
          order by occurred_at desc limit 1`,
      )
    ).rows;
    expect(entry?.details).toMatchObject({
      tier: 'bronze',
      before: { playerChecksPerHour: 100 },
      after: { playerChecksPerHour: 120 },
    });
    await json(
      await adminSend(
        'PUT',
        '/api/admin/merchant-tiers/bronze/settings',
        TIER_SETTINGS_DEFAULTS.bronze,
      ),
      200,
    );
  });
});

describe('grants, the merchants list and privileges (S23 MG1, MG3, AD1, AD3, AD5, TS3, TS5)', () => {
  it('grants a tier, shows it, widens the privileges, then ends it', async () => {
    const silverList = await customList(wholesale);
    const goldList = await customList(silverList.id);
    await json(
      await setLevel('silver', { monthlyThresholdUsdUnits: usd(5), priceListId: silverList.id }),
      200,
    );
    await json(
      await setLevel('gold', { monthlyThresholdUsdUnits: usd(1000), priceListId: goldList.id }),
      200,
    );
    const shop = await merchant(usd(50));
    const customer = await seedCustomer(test.db);
    seeded.push(customer.id);
    const grantPath = (id: string) => `/api/admin/customers/${id}/merchant/tier-grant`;
    const today = new Date();
    const day = (days: number) =>
      new Date(today.getTime() + days * 86_400_000).toISOString().slice(0, 10);
    const body = { tier: 'gold', endsOn: day(5), reason: 'شريك جديد في المدينة' };

    expect(await json(await adminSend('POST', grantPath(customer.id), body), 409)).toMatchObject({
      code: 'NOT_MERCHANT',
    });
    expect(await json(await adminSend('POST', grantPath(randomUUID()), body), 404)).toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(
      await json(await adminSend('POST', grantPath(shop.id), { ...body, endsOn: day(120) }), 400),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(
      await json(await adminSend('POST', grantPath(shop.id), { ...body, tier: 'diamond' }), 409),
    ).toMatchObject({ code: 'MERCHANT_TIER_UNAVAILABLE' });

    // A Bronze merchant: 50 checkout lines at most (TS5), the Bronze deposit limits (TS3).
    const lines = (count: number) =>
      Array.from({ length: count }, () => ({
        productId: item.id,
        quantity: 1,
        fields: { player_id: '5123456789' },
        expectedUnitPriceUsdUnits: usd(1),
        confirmPlayer: true,
      }));
    const checkout = (count: number) =>
      client.post('/api/checkouts', {
        cookie: shop.cookie,
        headers: { 'idempotency-key': randomUUID() },
        body: { lines: lines(count) },
      });
    expect(await json(await checkout(60), 400)).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { lines: { max: 50 } },
    });
    const limits = async () =>
      (
        await json<{ limits: { effective: { perDeposit: { units: number } } } }>(
          await adminGet(`/api/admin/customers/${shop.id}`),
          200,
        )
      ).limits.effective.perDeposit.units;
    expect(await limits()).toBe(TIER_SETTINGS_DEFAULTS.bronze.perDepositUsdUnits);

    const granted = await json<{ id: string; tier: string; endedAt: null }>(
      await adminSend('POST', grantPath(shop.id), body),
      200,
    );
    expect(granted).toMatchObject({ tier: 'gold', endedAt: null, reason: body.reason });
    expect(await json(await adminSend('POST', grantPath(shop.id), body), 409)).toMatchObject({
      code: 'MERCHANT_TIER_GRANT_OPEN',
    });
    expect(await auditOf(test.db, shop.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ action: 'merchant.tier_granted' })]),
    );

    // AD5: the profile; AD1: the list's column and filter.
    const profile = await json<{ merchant: { tier: Record<string, unknown> } }>(
      await adminGet(`/api/admin/customers/${shop.id}`),
      200,
    );
    expect(profile.merchant.tier).toMatchObject({
      tier: 'gold',
      earnedTier: 'bronze',
      source: 'granted',
      openGrant: { id: granted.id },
    });
    const listed = await json<{ items: { customerId: string; tier: string; priceKind: string }[] }>(
      await adminGet('/api/admin/merchants?tier=granted&limit=100'),
      200,
    );
    expect(listed.items).toEqual([
      expect.objectContaining({
        customerId: shop.id,
        tier: 'gold',
        tierGranted: true,
        priceKind: 'wholesale',
      }),
    ]);
    const bronze = await json<{ items: { customerId: string }[] }>(
      await adminGet('/api/admin/merchants?tier=bronze&limit=100'),
      200,
    );
    expect(bronze.items.some((row) => row.customerId === shop.id)).toBe(false);
    expect((await tiers())[2]?.merchants).toEqual({ earned: 0, granted: 1 });

    // Gold's privileges: 100 checkout lines get past the line limit, Gold's deposit limits.
    // Past the count: each line is then refused on its own (here its expected price).
    const wide = (await (await checkout(60)).json()) as { details?: { lines?: unknown } };
    expect(wide.details?.lines).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'PRICE_CHANGED' })]),
    );
    expect(await limits()).toBe(TIER_SETTINGS_DEFAULTS.gold.perDepositUsdUnits);

    // AD3: read only; the merchant bought nothing, so lower thresholds raise nobody here.
    const preview = await json<{
      tiers: { tier: string; now: number; proposed: number }[];
      rising: { customerId: string; to: string }[];
    }>(
      await adminSend('POST', '/api/admin/merchant-tiers/preview', {
        silver: usd(1),
        gold: usd(2),
        diamond: null,
      }),
      200,
    );
    expect(preview.tiers.map((tier) => tier.tier)).toEqual(['bronze', 'silver', 'gold', 'diamond']);
    expect(preview.rising.some((mover) => mover.customerId === shop.id)).toBe(false);
    expect(
      await json(
        await adminSend('POST', '/api/admin/merchant-tiers/preview', {
          silver: usd(5),
          gold: usd(2),
          diamond: null,
        }),
        400,
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });

    // MG3: ended, back to Bronze; a second end finds no open grant.
    const ended = await json<{ endReason: string }>(
      await adminSend('POST', `${grantPath(shop.id)}/end`, { reason: 'انتهت الشراكة' }),
      200,
    );
    expect(ended.endReason).toBe('ended_by_admin');
    expect(
      await json(
        await adminSend('POST', `${grantPath(shop.id)}/end`, { reason: 'مرة ثانية' }),
        404,
      ),
    ).toMatchObject({ code: 'NOT_FOUND' });
    expect(await limits()).toBe(TIER_SETTINGS_DEFAULTS.bronze.perDepositUsdUnits);
    await archiveLevels();
  });
});

describe('the setup command (S23 PX1)', () => {
  it('creates the chained lists, their rules and the levels once, then leaves them', async () => {
    await archiveLevels();
    const [before] = await test.db
      .select({ name: priceLists.name })
      .from(priceLists)
      .where(eq(priceLists.id, wholesale));
    const queued: string[] = [];
    const context = {
      jobs: {
        send: async (_tx: unknown, queue: string) => {
          queued.push(queue);
          return newId();
        },
      },
      routing: { now: new Date(), fakeEnabled: true },
    };
    try {
      const first = await setupMerchantTiers(test.db, context);
      expect(first.lines).toEqual(
        expect.arrayContaining([
          'Created the list "الفضية" with its rules.',
          'Created the silver level at 300 USD.',
          'Created the gold level at 1000 USD.',
          'Created the diamond level at 3000 USD.',
        ]),
      );
      const page = await tiers();
      expect(page[0]?.priceList?.name).toBe(TIER_LIST_NAMES.bronze);
      const [silver, gold, diamond] = page.slice(1).map((tier) => tier.level);
      expect(silver?.priceList.parentListId).toBe(wholesale);
      expect(gold?.priceList.parentListId).toBe(silver?.priceList.id);
      expect(diamond?.priceList.parentListId).toBe(gold?.priceList.id);
      expect(diamond?.monthlyThresholdUsdUnits).toBe(usd(3000));
      // The tier steps on the test pack: each tier at most its parent (PX2).
      const prices = await Promise.all(
        [wholesale, silver, gold, diamond].map(async (list) =>
          newestPrice(item.id, typeof list === 'string' ? list : (list?.priceList.id as string)),
        ),
      );
      const units = prices.map((row) => row?.priceUsdUnits as number);
      expect([...units].sort((a, b) => b - a)).toEqual(units);
      expect(queued).toContain('merchants.level');

      const again = await setupMerchantTiers(test.db, context);
      expect(again.lines).toEqual(
        expect.arrayContaining([
          'The wholesale list is named for Bronze already.',
          'The list "الماسية" exists: left as it is.',
          'The diamond level exists: left as it is.',
        ]),
      );
      expect(again.listRowsAppended).toBe(0);
    } finally {
      await archiveLevels();
      await test.db
        .update(priceLists)
        .set({ name: before?.name as string })
        .where(eq(priceLists.id, wholesale));
    }
  });
});
