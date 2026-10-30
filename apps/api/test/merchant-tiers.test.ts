import { randomBytes, randomUUID } from 'node:crypto';
import {
  DEPOSIT_SETTINGS_DEFAULTS,
  QUEUES,
  ROOT_PRICE_LIST_IDS,
  TIER_LIST_NAMES,
  TIER_SETTINGS_DEFAULTS,
} from '@vertex-digital/contracts';
import {
  catalogCategories,
  customerRateLimits,
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
import { FakeSupplierAdapter } from '@vertex-digital/suppliers';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SupplierAdaptersService } from '../src/modules/suppliers/supplier-adapters.service.js';
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
      // No session, and a customer's session: unauthorized like none.
      expect((await client.request(method, route, { body })).status, route).toBe(401);
      expect(
        (await client.request(method, route, { cookie: shop.cookie, body })).status,
        route,
      ).toBe(401);
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
    const list = await json<{ items: Tier[]; minDepositUsdUnits: number }>(
      await adminGet('/api/admin/merchant-tiers'),
      200,
    );
    expect(list.items[0]?.settings).toMatchObject(TIER_SETTINGS_DEFAULTS.bronze);
    // The panel's dialog reads the minimum both limits must reach.
    expect(list.minDepositUsdUnits).toBeGreaterThan(usd(0.01));
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

describe('privileges at purchase and a tier archived (S23 TS3, TS4, TS5, MG7, edge case 9)', () => {
  /** A code pack of a game without account fields, routed to a fake code offer at $1. */
  async function codePack() {
    const game = await json<{ id: string; slug: string }>(
      await adminSend('POST', '/api/admin/catalog/games', {
        categoryId: ids.categoryId,
        slug: `tiers-codes-${randomBytes(3).toString('hex')}`,
        nameAr: `بطاقات ${randomBytes(3).toString('hex')}`,
        nameEn: 'Cards',
      }),
      201,
    );
    const created = await json<{ id: string }>(
      await adminSend('POST', `/api/admin/catalog/games/${game.id}/products`, {
        kind: 'code',
        nameAr: 'بطاقة $1',
        redemptionAr: 'افتح المتجر والصق الكود.',
      }),
      201,
    );
    const now = new Date();
    const [offer] = await test.db
      .insert(supplierOffers)
      .values({
        supplierId: ids.fake,
        offerId: `o-${randomBytes(4).toString('hex')}`,
        name: 'Fake card',
        kind: 'code',
        requiredFields: [],
        costUsdUnits: usd(1),
        inStock: true,
        costConfirmedAt: now,
        lastSeenAt: now,
      })
      .returning({ id: supplierOffers.id });
    await json(
      await adminSend('POST', `/api/admin/catalog/products/${created.id}/routes`, {
        offerId: offer?.id,
        fieldMap: {},
      }),
      201,
    );
    await test.db.execute(sql`update catalog_games set status = 'active' where id = ${game.id}`);
    return { id: created.id, slug: game.slug };
  }

  it('gives each tier its code quantity, check quota and deposit limits, and ends grants on an archive', async () => {
    await archiveLevels();
    const silverList = await customList(wholesale);
    const goldList = await customList(silverList.id);
    await json(
      await setLevel('silver', {
        monthlyThresholdUsdUnits: usd(100_000),
        priceListId: silverList.id,
      }),
      200,
    );
    await json(
      await setLevel('gold', { monthlyThresholdUsdUnits: usd(200_000), priceListId: goldList.id }),
      200,
    );
    // The deposit settings in force (both methods off), so the options carry the limits.
    await json(
      await adminSend('PUT', '/api/admin/deposit-settings', {
        ...DEPOSIT_SETTINGS_DEFAULTS,
        shamCashAccountName: 'Vertex Digital',
        shamCashAccountNumber: '0933000000',
      }),
      200,
    );
    const pack = await codePack();
    const shop = await merchant(usd(300));
    const unitPrice = async () =>
      (
        await json<{ products: { id: string; priceUsdUnits: number | null }[] }>(
          await client.get(`/api/catalog/games/${pack.slug}/prices`, { cookie: shop.cookie }),
          200,
        )
      ).products.find((row) => row.id === pack.id)?.priceUsdUnits as number;
    const buy = async (quantity: number) =>
      client.post('/api/orders', {
        cookie: shop.cookie,
        headers: { 'idempotency-key': randomUUID() },
        body: {
          productId: pack.id,
          quantity,
          fields: {},
          expectedUnitPriceUsdUnits: await unitPrice(),
        },
      });
    const check = () =>
      client.post('/api/player-checks', {
        cookie: shop.cookie,
        body: { productId: item.id, fields: { player_id: '7300000001' } },
      });
    const perDeposit = async () =>
      (
        await json<{ limits: { perDepositUnits: number } | null }>(
          await client.get('/api/deposits/sham-cash/options', { cookie: shop.cookie }),
          200,
        )
      ).limits?.perDepositUnits;
    const lines = (count: number, unit: number) =>
      Array.from({ length: count }, () => ({
        productId: pack.id,
        quantity: 1,
        fields: {},
        expectedUnitPriceUsdUnits: unit,
      }));
    const checkout = async (count: number) =>
      client.post('/api/checkouts', {
        cookie: shop.cookie,
        headers: { 'idempotency-key': randomUUID() },
        body: { lines: lines(count, await unitPrice()) },
      });

    // Bronze: 50 code units an order (TS5), the Bronze hourly checks used up (TS4), its limits (TS3).
    expect(await json(await buy(51), 400)).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { fields: { quantity: 'too_big' } },
    });
    await test.db.insert(customerRateLimits).values({
      id: newId(),
      key: `player-check:customer:${shop.id}`,
      count: TIER_SETTINGS_DEFAULTS.bronze.playerChecksPerHour,
      lastRequest: Date.now(),
    });
    expect(await json(await check(), 429)).toMatchObject({ code: 'PLAYER_CHECK_QUOTA_EXCEEDED' });
    expect(await perDeposit()).toBe(TIER_SETTINGS_DEFAULTS.bronze.perDepositUsdUnits);

    const grantPath = `/api/admin/customers/${shop.id}/merchant/tier-grant`;
    const endsOn = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const granted = await json<{ id: string }>(
      await adminSend('POST', grantPath, { tier: 'gold', endsOn, reason: 'شريك جديد في المدينة' }),
      200,
    );

    // Gold: 80 code units in one order, the same used checks are below Gold's hourly limit.
    const order = await json<{ quantity: number }>(await buy(80), 201);
    expect(order.quantity).toBe(80);
    vi.spyOn(SupplierAdaptersService.prototype, 'recordCall').mockImplementation(async () => {});
    const validate = vi
      .spyOn(FakeSupplierAdapter.prototype, 'validatePlayer')
      .mockResolvedValue({ valid: true, playerName: 'Nour' });
    expect((await check()).status).toBe(200);
    expect(validate).toHaveBeenCalledTimes(1);
    expect(await perDeposit()).toBe(TIER_SETTINGS_DEFAULTS.gold.perDepositUsdUnits);
    expect((await (await checkout(60)).json()) as { details?: unknown }).not.toMatchObject({
      details: { lines: { max: 50 } },
    });

    // MG7: archiving Gold's level ends its open grant and moves the merchant back to Bronze; a
    // list of 60 lines checked as Gold is then refused naming the 50-line limit (edge case 9).
    await json(await setLevel('gold', null), 200);
    const ended = await test.db.execute<{ end_reason: string | null }>(
      sql`select end_reason from merchant_tier_grants where id = ${granted.id}`,
    );
    expect(ended.rows).toEqual([{ end_reason: 'tier_archived' }]);
    const profile = await json<{ merchant: { tier: { tier: string; openGrant: unknown } } }>(
      await adminGet(`/api/admin/customers/${shop.id}`),
      200,
    );
    expect(profile.merchant.tier).toMatchObject({ tier: 'bronze', openGrant: null });
    expect(await json(await checkout(60), 400)).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { lines: { max: 50 } },
    });
    expect(await json(await buy(51), 400)).toMatchObject({ code: 'VALIDATION_FAILED' });
    await archiveLevels();
  });
});

describe('the setup command (S23 PX1)', () => {
  const setupContext = {
    jobs: { send: async () => newId() },
    routing: { now: new Date(), fakeEnabled: true },
  };

  it('creates no level on a same-named list off the tier chain', async () => {
    await archiveLevels();
    const [before] = await test.db
      .select({ name: priceLists.name })
      .from(priceLists)
      .where(eq(priceLists.id, wholesale));
    const offChain = newId();
    await test.db.insert(priceLists).values({
      id: offChain,
      kind: 'custom',
      name: TIER_LIST_NAMES.silver,
      parentListId: retail,
    });
    try {
      const report = await setupMerchantTiers(test.db, setupContext);
      expect(report.lines).toEqual(
        expect.arrayContaining([
          `Warning: the list "${TIER_LIST_NAMES.silver}" exists off the tier chain: left as it is.`,
          expect.stringMatching(/^Warning: no silver level or above created/),
        ]),
      );
      expect((await tiers()).map((tier) => tier.level)).toEqual([null, null, null, null]);
    } finally {
      await test.db
        .update(priceLists)
        .set({ archivedAt: new Date() })
        .where(eq(priceLists.id, offChain));
      await test.db
        .update(priceLists)
        .set({ name: before?.name as string })
        .where(eq(priceLists.id, wholesale));
    }
  });

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

describe('operations (S23 PR 3: OP4, OP5, PX5, AD4)', () => {
  const day = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const grant = async (customerId: string, tier: 'gold' | 'diamond') =>
    json(
      await adminSend('POST', `/api/admin/customers/${customerId}/merchant/tier-grant`, {
        tier,
        endsOn: day(3),
        reason: 'شريك جديد في المدينة',
      }),
      200,
    );
  /** The levels, then the custom lists they named: a run holds at most so many lists. */
  const archiveTiers = async () => {
    await archiveLevels();
    await test.db
      .update(priceLists)
      .set({ archivedAt: new Date() })
      .where(and(eq(priceLists.kind, 'custom'), isNull(priceLists.archivedAt)));
  };
  /** Silver, Gold and Diamond on chained lists, out of reach so grants decide. */
  async function threeTiers() {
    await archiveLevels();
    const silverList = await customList(wholesale);
    const goldList = await customList(silverList.id);
    const diamondList = await customList(goldList.id);
    await json(
      await setLevel('silver', {
        monthlyThresholdUsdUnits: usd(100_000),
        priceListId: silverList.id,
      }),
      200,
    );
    await json(
      await setLevel('gold', { monthlyThresholdUsdUnits: usd(200_000), priceListId: goldList.id }),
      200,
    );
    await json(
      await setLevel('diamond', {
        monthlyThresholdUsdUnits: usd(300_000),
        priceListId: diamondList.id,
      }),
      200,
    );
    return { diamondList };
  }
  const lastAudit = async (action: string) =>
    (
      await test.db.execute<{ entity_id: string; details: unknown }>(
        sql`select entity_id, details from audit_entries where action = ${action}
          order by occurred_at desc, id desc limit 1`,
      )
    ).rows[0];
  const settingsBody = {
    ordersPerTenMinutes: 60,
    reapplyWaitDays: 7,
    infoExpiryDays: 7,
  };

  it('serves the Diamond contact to Diamond merchants only (OP4)', async () => {
    await reauthenticate();
    await threeTiers();
    expect(
      (
        await adminSend('PUT', '/api/admin/merchant-settings', {
          ...settingsBody,
          directContactWhatsapp: null,
          directContactTelegram: 'bad name',
        })
      ).status,
    ).toBe(400);
    const saved = await json<{ id?: string; directContactWhatsapp: string | null }>(
      await adminSend('PUT', '/api/admin/merchant-settings', {
        ...settingsBody,
        directContactWhatsapp: '0933 123 456',
        directContactTelegram: 'vertex_shop',
      }),
      200,
    );
    expect(saved.directContactWhatsapp).toBe('+963933123456');
    const diamond = await merchant();
    const gold = await merchant();
    try {
      await grant(diamond.id, 'diamond');
      await grant(gold.id, 'gold');
      const contactOf = async (cookie: string) =>
        (
          await json<{ contact: unknown; privileges: { supportReplyMinutes: number | null } }>(
            await client.get('/api/merchant/tier', { cookie }),
            200,
          )
        ).contact;
      expect(await contactOf(diamond.cookie)).toEqual({
        whatsappUrl: 'https://wa.me/963933123456',
        telegramUrl: 'https://t.me/vertex_shop',
      });
      expect(await contactOf(gold.cookie)).toBeNull();
      expect((await lastAudit('merchant_settings.changed'))?.details).toMatchObject({
        after: { directContactWhatsapp: '+963933123456', directContactTelegram: 'vertex_shop' },
      });
    } finally {
      await json(
        await adminSend('PUT', '/api/admin/merchant-settings', {
          ...settingsBody,
          directContactWhatsapp: null,
          directContactTelegram: null,
        }),
        200,
      );
      await archiveTiers();
    }
  });

  it('opens a pack and a game early to early-access tiers only, then to everyone (OP5)', async () => {
    await reauthenticate();
    await threeTiers();
    const pack = await product(1);
    const [game] = await test.db
      .execute<{ slug: string }>(sql`select slug from catalog_games where id = ${ids.gameId}`)
      .then((result) => result.rows);
    const slug = game?.slug as string;
    const bronze = await merchant(usd(20));
    const gold = await merchant(usd(20));
    await grant(gold.id, 'gold');
    // Gold follows the game: told once when it opens early.
    await test.db.execute(
      sql`insert into merchant_watches (id, customer_id, game_id) values (${newId()}, ${gold.id}, ${ids.gameId})`,
    );
    const earlyPath = `/api/admin/catalog/products/${pack.id}/early-access`;
    expect((await adminSend('PUT', earlyPath, { on: true }, plainAdmin)).status).toBe(403);
    expect((await client.request('PUT', earlyPath, { body: { on: true } })).status).toBe(401);
    try {
      const opened = await json<{ earlyAccessUntil: string | null }>(
        await adminSend('PUT', earlyPath, { on: true }),
        200,
      );
      expect(opened.earlyAccessUntil).not.toBeNull();
      expect((await lastAudit('catalog_product.early_access_set'))?.entity_id).toBe(pack.id);
      // The public page and a Bronze merchant do not see it.
      const publicPage = await json<{ products: { id: string }[] }>(
        await client.get(`/api/catalog/games/${slug}`),
        200,
      );
      expect(publicPage.products.map((row) => row.id)).not.toContain(pack.id);
      type Prices = {
        products: { id: string; earlyAccess: boolean; priceUsdUnits: number | null }[];
        earlyProducts: { id: string; earlyAccess: boolean; nameAr: string }[];
      };
      const pricesOf = async (cookie: string) =>
        json<Prices>(await client.get(`/api/catalog/games/${slug}/prices`, { cookie }), 200);
      const bronzePrices = await pricesOf(bronze.cookie);
      expect(bronzePrices.products.map((row) => row.id)).not.toContain(pack.id);
      expect(bronzePrices.earlyProducts).toEqual([]);
      const buy = (cookie: string, price: number) =>
        client.post('/api/orders', {
          cookie,
          headers: { 'idempotency-key': randomUUID() },
          body: {
            productId: pack.id,
            quantity: 1,
            fields: { player_id: '5123456789' },
            expectedUnitPriceUsdUnits: price,
            confirmPlayer: true,
          },
        });
      const goldPrices = await pricesOf(gold.cookie);
      const own = goldPrices.products.find((row) => row.id === pack.id);
      expect(own?.earlyAccess).toBe(true);
      expect(goldPrices.earlyProducts.map((row) => row.id)).toEqual([pack.id]);
      expect(await json(await buy(bronze.cookie, own?.priceUsdUnits as number), 409)).toMatchObject(
        { code: 'PRODUCT_UNAVAILABLE', details: { availability: 'hidden' } },
      );
      expect((await buy(gold.cookie, own?.priceUsdUnits as number)).status).toBe(201);
      // Told once, whatever the windows set again.
      await json(await adminSend('PUT', earlyPath, { on: true }), 200);
      const told = await test.db.execute<{ count: number }>(
        sql`select count(*)::int as count from customer_notifications
          where customer_id = ${gold.id} and event = 'merchant_early_access'`,
      );
      expect(told.rows[0]?.count).toBe(1);
      // Ended early: everyone sees it at once.
      const ended = await json<{ earlyAccessUntil: string | null }>(
        await adminSend('PUT', earlyPath, { on: false }),
        200,
      );
      expect(ended.earlyAccessUntil).toBeNull();
      expect(
        (
          await json<{ products: { id: string }[] }>(
            await client.get(`/api/catalog/games/${slug}`),
            200,
          )
        ).products.map((row) => row.id),
      ).toContain(pack.id);

      // A whole game early: not found publicly and for Bronze, served to Gold.
      const gamePath = `/api/admin/catalog/games/${ids.gameId}/early-access`;
      await json(await adminSend('PUT', gamePath, { on: true }), 200);
      expect((await client.get(`/api/catalog/games/${slug}`)).status).toBe(404);
      const earlyGame = `/api/catalog/games/${slug}/early-access`;
      expect((await client.get(earlyGame, { cookie: bronze.cookie })).status).toBe(404);
      expect((await client.get(earlyGame)).status).toBe(401);
      const served = await json<{ products: { id: string; earlyAccess: boolean }[] }>(
        await client.get(earlyGame, { cookie: gold.cookie }),
        200,
      );
      expect(served.products.every((row) => row.earlyAccess)).toBe(true);
      expect(
        (await client.get(`/api/catalog/games/${slug}/prices`, { cookie: bronze.cookie })).status,
      ).toBe(404);
      await json(await adminSend('PUT', gamePath, { on: false }), 200);
      expect((await client.get(`/api/catalog/games/${slug}`)).status).toBe(200);
      expect((await client.get(earlyGame, { cookie: gold.cookie })).status).toBe(404);
    } finally {
      await test.db.execute(
        sql`update catalog_games set early_access_until = null where id = ${ids.gameId}`,
      );
      await test.db.execute(
        sql`update catalog_products set early_access_until = null where id = ${pack.id}`,
      );
      await archiveTiers();
    }
  });

  it('hides an early pack on every other path, for Bronze, customers and the admin (OP5)', async () => {
    await reauthenticate();
    await threeTiers();
    const pack = await product(1);
    await test.db.execute(
      sql`update catalog_products set game_amount = 8100 where id = ${pack.id}`,
    );
    const bronze = await merchant(usd(20));
    const gold = await merchant(usd(20));
    await grant(gold.id, 'gold');
    const buyer = await seedCustomer(test.db);
    seeded.push(buyer.id);
    const shopper = { cookie: await client.signInCustomer(buyer.email) };
    const [{ price } = { price: 0 }] = await test.db
      .execute<{ price: number }>(
        sql`select price_usd_units::int as price from product_prices
          where product_id = ${pack.id} and price_list_id = ${wholesale}
          order by created_at desc limit 1`,
      )
      .then((result) => result.rows);
    const line = {
      productId: pack.id,
      quantity: 1,
      fields: { player_id: '5123456789' },
      expectedUnitPriceUsdUnits: price,
      confirmPlayer: true,
    };
    const hidden = { code: 'PRODUCT_UNAVAILABLE' };
    const adminOrder = (overrides: Record<string, unknown>) =>
      client.post('/api/admin/orders', {
        cookie: admin.cookie,
        headers: { 'idempotency-key': randomUUID() },
        body: {
          purpose: 'walk_in',
          productId: pack.id,
          quantity: 1,
          fields: { player_id: '5123456789' },
          expectedUnitPriceUsdUnits: price,
          reason: 'Bought at the counter',
          ...overrides,
        },
      });
    await json(
      await adminSend('PUT', `/api/admin/catalog/products/${pack.id}/early-access`, { on: true }),
      200,
    );
    try {
      // The public reads.
      const index = await json<{ products: { id: string }[] }>(
        await client.get('/api/catalog/search-index'),
        200,
      );
      expect(index.products.map((row) => row.id)).not.toContain(pack.id);

      for (const who of [bronze.cookie, shopper.cookie]) {
        // A reservation, the checkout and the player check.
        expect(
          await json(
            await client.post('/api/orders', {
              cookie: who,
              headers: { 'idempotency-key': randomUUID() },
              body: { ...line, whenBalanceShort: 'reserve' },
            }),
            409,
          ),
        ).toMatchObject(hidden);
        const paid = await client.post('/api/checkouts', {
          cookie: who,
          headers: { 'idempotency-key': randomUUID() },
          body: { lines: [line] },
        });
        expect(paid.status).toBe(409);
        expect(await paid.text()).toContain('PRODUCT_UNAVAILABLE');
        const check = await client.post('/api/player-checks', {
          cookie: who,
          body: { productId: pack.id, fields: { player_id: '5123456789' } },
        });
        expect(check.status).toBeGreaterThanOrEqual(400);
      }

      // The panel: walk-in and owner-funded never reach it; on behalf follows the merchant.
      expect(await json(await adminOrder({}), 409)).toMatchObject(hidden);
      expect(
        await json(await adminOrder({ purpose: 'on_behalf', customerId: bronze.id }), 409),
      ).toMatchObject(hidden);
      expect(
        await json(await adminOrder({ purpose: 'on_behalf', customerId: buyer.id }), 409),
      ).toMatchObject(hidden);

      // A quick link to it opens nothing; the bulk check does not name it to Bronze.
      const [code] = await test.db
        .execute<{ quick_code: string }>(
          sql`select quick_code from catalog_products where id = ${pack.id}`,
        )
        .then((result) => result.rows);
      const link = await client.get(`/api/q/${code?.quick_code}`, {
        headers: { 'x-forwarded-for': `203.0.113.${Math.floor(Math.random() * 250)}` },
      });
      expect(await json(link, 200)).toEqual({ target: 'game', gameSlug: expect.any(String) });
      type Bulk = { lines: { product: { id: string } | null }[] };
      const bulk = (cookie: string) =>
        client.post('/api/merchant/bulk/check', {
          cookie,
          body: { gameId: ids.gameId, text: '5123456789,8100' },
        });
      const bronzeBulk = await json<Bulk>(await bulk(bronze.cookie), 200);
      expect(bronzeBulk.lines[0]?.product).toBeNull();
      const goldBulk = await json<Bulk>(await bulk(gold.cookie), 200);
      expect(goldBulk.lines[0]?.product?.id).toBe(pack.id);
    } finally {
      await test.db.execute(
        sql`update catalog_products set early_access_until = null, game_amount = null where id = ${pack.id}`,
      );
      await archiveTiers();
    }
  });

  it('activates a paused pack or game with its window; no notice while the game is paused (OP5)', async () => {
    await reauthenticate();
    await threeTiers();
    const pack = await product(1);
    const gold = await merchant(usd(20));
    await grant(gold.id, 'gold');
    await test.db.execute(
      sql`insert into merchant_watches (id, customer_id, game_id) values (${newId()}, ${gold.id}, ${ids.gameId})`,
    );
    const told = async () =>
      (
        await test.db.execute<{ count: number }>(
          sql`select count(*)::int as count from customer_notifications
            where customer_id = ${gold.id} and event = 'merchant_early_access'`,
        )
      ).rows[0]?.count;
    const packPath = `/api/admin/catalog/products/${pack.id}/early-access`;
    const gamePath = `/api/admin/catalog/games/${ids.gameId}/early-access`;
    try {
      expect((await adminSend('PUT', gamePath, { on: true }, plainAdmin)).status).toBe(403);
      expect((await client.request('PUT', gamePath, { body: { on: true } })).status).toBe(401);
      expect(
        (await client.request('PUT', gamePath, { body: { on: true }, cookie: gold.cookie })).status,
      ).toBe(401);
      expect(
        (await client.request('PUT', packPath, { body: { on: true }, cookie: gold.cookie })).status,
      ).toBe(401);

      // The game is paused: the pack opens, its link could not, so nobody is told yet.
      await test.db.execute(
        sql`update catalog_products set status = 'paused' where id = ${pack.id}`,
      );
      await test.db.execute(
        sql`update catalog_games set status = 'paused' where id = ${ids.gameId}`,
      );
      const opened = await json<{ status: string; earlyAccessUntil: string | null }>(
        await adminSend('PUT', packPath, { on: true }),
        200,
      );
      expect(opened).toMatchObject({ status: 'active' });
      expect(opened.earlyAccessUntil).not.toBeNull();
      expect(await told()).toBe(0);

      // Rule CT3 still holds: a game that cannot be active stays paused, with no window.
      expect(await json(await adminSend('PUT', gamePath, { on: true }), 409)).toMatchObject({
        code: 'CATALOG_INCOMPLETE',
      });
      expect(await told()).toBe(0);
      const cover = new FormData();
      cover.set(
        'file',
        new File(
          [
            await sharp({ create: { width: 32, height: 32, channels: 3, background: '#123456' } })
              .png()
              .toBuffer(),
          ],
          'cover.png',
          { type: 'image/png' },
        ),
      );
      const uploaded = await json<{ id: string }>(
        await client.post('/api/admin/catalog/images', { cookie: admin.cookie, form: cover }),
        201,
      );
      await test.db.execute(
        sql`update catalog_games set cover_file_id = ${uploaded.id} where id = ${ids.gameId}`,
      );

      // The paused game opens with its window, and its followers are told.
      const game = await json<{ status: string; earlyAccessUntil: string | null }>(
        await adminSend('PUT', gamePath, { on: true }),
        200,
      );
      expect(game).toMatchObject({ status: 'active' });
      expect(game.earlyAccessUntil).not.toBeNull();
      expect(await told()).toBe(1);
      const refreshes = await test.db.execute<{ count: number }>(
        sql`select count(*)::int as count from pgboss.job where name = ${QUEUES.storeRevalidate}`,
      );
      expect(refreshes.rows[0]?.count).toBeGreaterThanOrEqual(1);

      // The admin reads it only as an admin: the store's own read is for merchants.
      const [row] = await test.db
        .execute<{ slug: string }>(sql`select slug from catalog_games where id = ${ids.gameId}`)
        .then((result) => result.rows);
      expect(
        (await client.get(`/api/catalog/games/${row?.slug}/early-access`, { cookie: admin.cookie }))
          .status,
      ).toBe(401);
    } finally {
      await test.db.execute(
        sql`update catalog_games set early_access_until = null, cover_file_id = null where id = ${ids.gameId}`,
      );
      await test.db.execute(
        sql`update catalog_products set early_access_until = null where id = ${pack.id}`,
      );
      await archiveTiers();
    }
  });

  it('lists the best sellers with each tier price for the Diamond list (PX5)', async () => {
    const { diamondList } = await threeTiers();
    try {
      expect((await client.get('/api/admin/merchant-tiers/best-sellers')).status).toBe(401);
      const shop = await merchant();
      expect(
        (await client.get('/api/admin/merchant-tiers/best-sellers', { cookie: shop.cookie }))
          .status,
      ).toBe(401);
      const page = await json<{
        diamondListId: string | null;
        items: { tiers: { tier: string }[] }[];
      }>(await adminGet('/api/admin/merchant-tiers/best-sellers'), 200);
      expect(page.diamondListId).toBe(diamondList.id);
      for (const item of page.items) {
        expect(item.tiers.map((row) => row.tier)).toEqual(['bronze', 'silver', 'gold', 'diamond']);
      }
    } finally {
      await archiveTiers();
    }
  });

  it('reads an ended month from its snapshot, without test merchants (AD4, edge case 21)', async () => {
    await threeTiers();
    const real = await merchant();
    const fake = await merchant();
    await test.db.execute(sql`update customers set is_test = true where id = ${fake.id}`);
    const month = '2024-03';
    const insert = (customerId: string) =>
      test.db.execute(sql`insert into merchant_tier_months
        (customer_id, month, net_purchases_usd_units, earned_tier, held_tier, held_source)
        values (${customerId}, ${`${month}-01`}, ${usd(5)}, 'bronze', 'gold', 'granted')`);
    type Report = {
      current: boolean;
      rows: { tier: string; merchants: number; netPurchasesUsdUnits: number }[];
    };
    const goldOf = async () => {
      const report = await json<Report>(
        await adminGet(`/api/admin/reports/merchant-tiers?month=${month}`),
        200,
      );
      expect(report.current).toBe(false);
      return report.rows.find((row) => row.tier === 'gold');
    };
    // The test database keeps the rows of earlier runs: the month is read before and after.
    const before = await goldOf();
    await insert(real.id);
    await insert(fake.id);
    try {
      expect(await goldOf()).toMatchObject({
        merchants: (before?.merchants ?? 0) + 1,
        netPurchasesUsdUnits: (before?.netPurchasesUsdUnits ?? 0) + usd(5),
      });
    } finally {
      await archiveTiers();
    }
  });

  it('reports a month by tier and exports it, audited (AD4)', async () => {
    await threeTiers();
    const shop = await merchant();
    try {
      await reauthenticate();
      await grant(shop.id, 'gold');
      const month = new Date().toISOString().slice(0, 7);
      expect((await client.get(`/api/admin/reports/merchant-tiers?month=${month}`)).status).toBe(
        401,
      );
      expect((await adminGet('/api/admin/reports/merchant-tiers?month=2026-13')).status).toBe(400);
      const report = await json<{
        current: boolean;
        rows: { tier: string; merchants: number; rises: number }[];
      }>(await adminGet(`/api/admin/reports/merchant-tiers?month=${month}`), 200);
      expect(report.current).toBe(true);
      expect(report.rows.map((row) => row.tier)).toEqual(['bronze', 'silver', 'gold', 'diamond']);
      const goldRow = report.rows.find((row) => row.tier === 'gold');
      expect(goldRow?.merchants).toBeGreaterThanOrEqual(1);
      expect(goldRow?.rises).toBeGreaterThanOrEqual(1);
      const exported = await adminGet(`/api/admin/reports/merchant-tiers/export?month=${month}`);
      expect(exported.status).toBe(200);
      expect(exported.headers.get('content-disposition')).toContain(
        `vertex-merchant-tiers-${month}.xlsx`,
      );
      expect((await lastAudit('report.merchant_tiers_exported'))?.details).toEqual({
        month,
        rows: 4,
      });
    } finally {
      await archiveTiers();
    }
  });
});
