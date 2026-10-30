import { randomBytes } from 'node:crypto';
import { ROOT_PRICE_LIST_IDS, TIER_SETTINGS_DEFAULTS } from '@vertex-digital/contracts';
import {
  catalogCategories,
  customers,
  ensureCustomerWallet,
  ensureSystemAccount,
  merchantLevels,
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
 * The merchant's tier and certificate (S23 PR 2) over HTTP against the test database with the
 * `fake` supplier: access, the tier card (ID3, PG1, TR7), the table (PG2), the history (PG5), the
 * celebration (ID4), the certificate and its public page (ID7), the welcome line (RC1). Levels,
 * lists and the category are archived in `afterAll`.
 */

let test: TestApp;
let client: ReturnType<typeof api>;
let admin: Awaited<ReturnType<ReturnType<typeof api>['adminWithTotp']>>;
const seeded: string[] = [];
const run = randomBytes(4).toString('hex');
const usd = (dollars: number) => Math.round(dollars * 1_000_000);
const { wholesale } = ROOT_PRICE_LIST_IDS;
const ids = { fake: '', categoryId: '', gameId: '' };

async function json<T = Record<string, unknown>>(response: Response, status: number): Promise<T> {
  const payload = await response.json();
  expect(response.status, JSON.stringify(payload)).toBe(status);
  return payload as T;
}

const adminSend = (method: string, path: string, payload?: unknown) =>
  client.request(method, path, { cookie: admin.cookie, body: payload });
const get = (path: string, cookie?: string) => client.get(path, cookie ? { cookie } : {});
const post = (path: string, cookie: string) => client.post(path, { cookie });
const grantPath = (id: string) => `/api/admin/customers/${id}/merchant/tier-grant`;
const day = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const grant = (customerId: string, tier: string) =>
  adminSend('POST', grantPath(customerId), {
    tier,
    endsOn: day(5),
    reason: 'شريك جديد في المدينة',
  });

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

const setLevel = (tier: string, level: unknown) =>
  adminSend('PUT', `/api/admin/merchant-tiers/${tier}/level`, { level });

async function customList(parentListId: string) {
  return json<{ id: string }>(
    await adminSend('POST', '/api/admin/pricing/lists', {
      name: `فئة ${randomBytes(3).toString('hex')}`,
      parentListId,
    }),
    201,
  );
}

/** Silver at $5 and Gold at $1,000 on chained lists. */
async function silverAndGold() {
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

beforeAll(async () => {
  test = await startApp();
  client = api(test.url);
  admin = await client.adminWithTotp(test.db);
  seeded.push(admin.id);
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
      values: { webhookSecret: `whsec-${run}-tier-card` },
    }),
    200,
  );
  await test.db
    .update(supplierSyncRuns)
    .set({ status: 'failed', finishedAt: new Date(), errorCode: 'TEST' })
    .where(and(eq(supplierSyncRuns.supplierId, ids.fake), eq(supplierSyncRuns.status, 'running')));
  const category = await json<{ id: string }>(
    await adminSend('POST', '/api/admin/catalog/categories', {
      slug: `tier-card-${run}`,
      nameAr: `بطاقة ${run}`,
    }),
    201,
  );
  ids.categoryId = category.id;
  const game = await json<{ id: string }>(
    await adminSend('POST', '/api/admin/catalog/games', {
      categoryId: category.id,
      slug: `tier-card-pubg-${run}`,
      nameAr: `ببجي بطاقة ${run}`,
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
  await product(1);
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
  it('keeps the tier routes to merchants, the certificate page to anyone with the code', async () => {
    const customer = await seedCustomer(test.db);
    seeded.push(customer.id);
    const cookie = await client.signInCustomer(customer.email);
    const routes = [
      ['GET', '/api/merchant/tier'],
      ['GET', '/api/merchant/tier/table'],
      ['GET', '/api/merchant/tier/history'],
      ['POST', '/api/merchant/tier/celebrated'],
      ['GET', '/api/merchant/certificate'],
      ['POST', '/api/merchant/certificate/reissue'],
    ] as const;
    for (const [method, path] of routes) {
      expect((await client.request(method, path)).status, path).toBe(401);
      expect((await client.request(method, path, { cookie: admin.cookie })).status, path).toBe(401);
      expect(await json(await client.request(method, path, { cookie }), 403)).toMatchObject({
        code: 'NOT_MERCHANT',
      });
    }
    // RC1: the admin's removal of a welcome line needs a fresh re-authentication.
    const plainAdmin = await client.signInAdmin(admin.email, admin.secret);
    expect(
      await json(
        await client.request(
          'DELETE',
          `/api/admin/customers/${customer.id}/merchant/welcome-text`,
          {
            cookie: plainAdmin,
            body: { reason: 'رقم تواصل مخالف' },
          },
        ),
        403,
      ),
    ).toMatchObject({ code: 'REAUTHENTICATION_REQUIRED' });
    for (const code of ['A'.repeat(22), 'short', 'x'.repeat(23)]) {
      expect(await json(await get(`/api/certificates/${code}`), 404)).toMatchObject({
        code: 'NOT_FOUND',
      });
    }
  });
});

describe('the tier card, table and history (S23 ID3, ID4, PG1, PG2, PG5, TR7)', () => {
  it('shows Bronze with the way to Silver, then a granted Gold without its source', async () => {
    await silverAndGold();
    const shop = await merchant();
    const bronze = await json(await get('/api/merchant/tier', shop.cookie), 200);
    expect(bronze).toMatchObject({
      tier: 'bronze',
      keptUntil: null,
      thisMonthUsdUnits: 0,
      progress: {
        next: { tier: 'silver', thresholdUsdUnits: usd(5), missingUsdUnits: usd(5) },
        reachedPermille: 0,
        keep: null,
      },
      forecast: null,
      savingsUsdUnits: null,
      privileges: { orderUnitsMax: 50, bulkLinesMax: 50, receiptWelcome: false },
      celebrate: false,
    });
    expect(JSON.stringify(bronze)).not.toMatch(/source|granted|priceList/);

    const table = await json<{
      current: string;
      packs: unknown[];
      tiers: {
        tier: string;
        available: boolean;
        thresholdUsdUnits: number | null;
        prices: unknown[];
      }[];
    }>(await get('/api/merchant/tier/table', shop.cookie), 200);
    expect(table.current).toBe('bronze');
    expect(table.tiers.map((tier) => [tier.tier, tier.available, tier.thresholdUsdUnits])).toEqual([
      ['bronze', true, null],
      ['silver', true, usd(5)],
      ['gold', true, usd(1000)],
      ['diamond', false, null],
    ]);
    for (const tier of table.tiers) expect(tier.prices).toHaveLength(table.packs.length);
    expect(JSON.stringify(table)).not.toMatch(/cost|rule|البرونزية|فئة /);

    const history = await json<{ items: { current: boolean; tier: string }[] }>(
      await get('/api/merchant/tier/history', shop.cookie),
      200,
    );
    expect(history.items).toEqual([expect.objectContaining({ current: true, tier: 'bronze' })]);

    // A grant: the merchant sees Gold like an earned tier, the celebration due (ID4, MG2).
    await json(await grant(shop.id, 'gold'), 200);
    expect(await json(await get('/api/merchant/tier', shop.cookie), 200)).toMatchObject({
      tier: 'gold',
      keptUntil: null,
      progress: { next: null, keep: { thresholdUsdUnits: usd(1000) } },
      savingsUsdUnits: 0,
      privileges: {
        orderUnitsMax: TIER_SETTINGS_DEFAULTS.gold.orderUnitsMax,
        receiptLargeLogo: true,
      },
      celebrate: true,
    });

    // ID4: seen once; a frozen merchant still reads but writes nothing.
    expect((await post('/api/merchant/tier/celebrated', shop.cookie)).status).toBe(204);
    expect(await json(await get('/api/merchant/tier', shop.cookie), 200)).toMatchObject({
      celebrate: false,
    });
    await test.db.update(customers).set({ frozenAt: new Date() }).where(eq(customers.id, shop.id));
    expect(await json(await post('/api/merchant/tier/celebrated', shop.cookie), 403)).toMatchObject(
      { code: 'ACCOUNT_FROZEN' },
    );
    expect((await get('/api/merchant/tier', shop.cookie)).status).toBe(200);
    await test.db.update(customers).set({ frozenAt: null }).where(eq(customers.id, shop.id));
    await archiveLevels();
  });
});

describe('the certificate (S23 ID7)', () => {
  it('serves the current tier by its code, reissues it 3 times a day, and shows a revocation', async () => {
    await silverAndGold();
    const shop = await merchant();
    const first = await json<{ code: string; tradeName: string }>(
      await get('/api/merchant/certificate', shop.cookie),
      200,
    );
    expect(first).toMatchObject({ tier: 'bronze', reissuedAt: null, governorate: 'aleppo' });
    expect(first.code).toMatch(/^[A-Za-z0-9_-]{22}$/);

    const page = await get(`/api/certificates/${first.code}`);
    expect(page.headers.get('cache-control')).toBe('public, max-age=30');
    expect(page.headers.get('x-robots-tag')).toBe('noindex');
    const shown = await json(page, 200);
    expect(shown).toEqual({
      status: 'active',
      tradeName: first.tradeName,
      city: 'اعزاز',
      governorate: 'aleppo',
      tier: 'bronze',
      since: expect.any(String),
    });
    expect(JSON.stringify(shown)).not.toContain(shop.email);

    // The live tier, not the one printed (ID5, ID7).
    await json(await grant(shop.id, 'gold'), 200);
    expect(await json(await get(`/api/certificates/${first.code}`), 200)).toMatchObject({
      tier: 'gold',
    });

    let code = first.code;
    for (let count = 0; count < 3; count += 1) {
      const next = await json<{ code: string; reissuedAt: string | null }>(
        await post('/api/merchant/certificate/reissue', shop.cookie),
        200,
      );
      expect(next.code).not.toBe(code);
      expect(next.reissuedAt).not.toBeNull();
      expect((await get(`/api/certificates/${code}`)).status).toBe(404);
      code = next.code;
    }
    expect(
      await json(await post('/api/merchant/certificate/reissue', shop.cookie), 429),
    ).toMatchObject({ code: 'CERTIFICATE_REISSUE_LIMIT' });
    expect(
      (await auditOf(test.db, shop.id)).filter(
        (entry) => entry.action === 'merchant.certificate_reissued',
      ),
    ).toHaveLength(3);

    // A revoked merchant shows only that (edge case 16 keeps a frozen one's tier).
    await json(
      await adminSend('POST', `/api/admin/customers/${shop.id}/merchant/revoke`, {
        reason: 'مخالفة شروط التاجر',
      }),
      200,
    );
    expect(await json(await get(`/api/certificates/${code}`), 200)).toEqual({ status: 'revoked' });

    // A re-grant writes a new code: prints from before the revocation never resolve again.
    await json(
      await adminSend('POST', `/api/admin/customers/${shop.id}/merchant`, {
        tradeName: first.tradeName,
        governorate: 'aleppo',
        city: 'اعزاز',
        reason: 'عاد التاجر بعد المراجعة',
      }),
      200,
    );
    expect((await get(`/api/certificates/${code}`)).status).toBe(404);
    const regranted = await json<{ code: string; reissuedAt: string | null }>(
      await get('/api/merchant/certificate', shop.cookie),
      200,
    );
    expect(regranted.code).not.toBe(code);
    expect(regranted.reissuedAt).toBeNull();
    expect(await json(await get(`/api/certificates/${regranted.code}`), 200)).toMatchObject({
      status: 'active',
    });

    // A closed (archived) account is no longer approved either.
    await test.db
      .update(customers)
      .set({ archivedAt: new Date() })
      .where(eq(customers.id, shop.id));
    expect(await json(await get(`/api/certificates/${regranted.code}`), 200)).toEqual({
      status: 'revoked',
    });
    await test.db.update(customers).set({ archivedAt: null }).where(eq(customers.id, shop.id));
    await archiveLevels();
  });
});

describe('the welcome line (S23 RC1)', () => {
  it('saves a new line only for a tier that prints it, and keeps it after a fall', async () => {
    await silverAndGold();
    const shop = await merchant();
    const settings = (welcomeText: string | null) =>
      client.request('PUT', '/api/merchant/receipt-settings', {
        cookie: shop.cookie,
        body: { showWhatsapp: false, whatsapp: null, logoFileId: null, welcomeText },
      });
    expect(await json(await get('/api/merchant/receipt-settings', shop.cookie), 200)).toMatchObject(
      { welcomeText: null, welcomeAllowed: false },
    );
    expect(await json(await settings('أهلاً بكم في محلنا'), 400)).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(await json(await settings('اتصل 0991234567'), 400)).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await json(await grant(shop.id, 'silver'), 200);
    expect(await json(await settings('  أهلاً بكم في محلنا  '), 200)).toMatchObject({
      welcomeText: 'أهلاً بكم في محلنا',
      welcomeAllowed: true,
    });
    // The admin sees the line on the profile and removes it, with a reason, audited.
    const removePath = `/api/admin/customers/${shop.id}/merchant/welcome-text`;
    expect(
      await json<{ merchant: { branding: { welcomeText: string | null } } }>(
        await client.get(`/api/admin/customers/${shop.id}`, { cookie: admin.cookie }),
        200,
      ),
    ).toMatchObject({ merchant: { branding: { welcomeText: 'أهلاً بكم في محلنا' } } });
    expect(
      (await client.request('DELETE', removePath, { cookie: shop.cookie, body: { reason: 'xyz' } }))
        .status,
    ).toBe(401);
    expect((await adminSend('DELETE', removePath, { reason: 'رقم تواصل مخالف' })).status).toBe(204);
    expect(await json(await get('/api/merchant/receipt-settings', shop.cookie), 200)).toMatchObject(
      { welcomeText: null },
    );
    expect(
      (await auditOf(test.db, shop.id)).filter(
        (entry) => entry.action === 'merchant.welcome_text_removed',
      ),
    ).toEqual([expect.objectContaining({ reason: 'رقم تواصل مخالف' })]);
    expect(
      await json(await adminSend('DELETE', removePath, { reason: 'مرة ثانية' }), 404),
    ).toMatchObject({ code: 'NOT_FOUND' });
    await json(await settings('أهلاً بكم في محلنا'), 200);
    await json(
      await adminSend('POST', `${grantPath(shop.id)}/end`, { reason: 'انتهت الشراكة' }),
      200,
    );
    // Kept, not printed: the same line saves again, a new one does not.
    expect(await json(await settings('أهلاً بكم في محلنا'), 200)).toMatchObject({
      welcomeText: 'أهلاً بكم في محلنا',
      welcomeAllowed: false,
    });
    expect(await json(await settings('مرحباً بكم'), 400)).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(await json(await settings(null), 200)).toMatchObject({ welcomeText: null });
    await archiveLevels();
  });
});
