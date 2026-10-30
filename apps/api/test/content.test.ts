import { randomBytes, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  ACTIVITY_MINIMUM,
  ANNOUNCEMENTS_MAX,
  FAQ_ITEMS_PER_SECTION_MAX,
  priceFromCost,
  QUEUES,
} from '@vertex-digital/contracts';
import {
  announcements,
  applyOutcome,
  banners,
  catalogCategories,
  contentPageVersions,
  customers,
  ensureCustomerWallet,
  ensureSystemAccount,
  faqItems,
  faqSections,
  fulfilmentAttempts,
  lockOrder,
  newId,
  orderCodesKey,
  postJournal,
  supplierBalanceReads,
  supplierOffers,
  suppliers,
  transitionOrder,
} from '@vertex-digital/db';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseEnv } from '../src/core/config/env.js';
import { ContentActivityService } from '../src/modules/content/content-activity.service.js';
import {
  api,
  auditOf,
  lastCode,
  PASSWORD,
  removeAccounts,
  seedCustomer,
  setSwitches,
  totp,
  uniqueEmail,
} from './helpers.js';
import { startApp, type TestApp } from './start-app.js';

/*
 * Store content and live activity (S14) over HTTP against the test database. Pages, the FAQ,
 * banners and announcements are global and never deleted: tests use the `refund` page for
 * publishing (`about` stays unpublished), and archive every FAQ row, banner and announcement they
 * create. Live activity is checked on this file's own game, whose orders are bought through the
 * API and delivered as the worker does (as `reports.test.ts`), then read at a later `now`.
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
  gameSlug: `content-game-${run}`,
  productId: '',
  routeId: '',
  offerId: '',
  price: 0,
  cost: 0,
};

async function json<T = Record<string, unknown>>(response: Response, status: number): Promise<T> {
  const payload = await response.json();
  expect(response.status, JSON.stringify(payload)).toBe(status);
  return payload as T;
}

const adminGet = (path: string) => client.get(path, { cookie: admin.cookie });
const adminPost = (path: string, body: unknown = {}) =>
  client.post(path, { cookie: admin.cookie, body });
const adminPut = (path: string, body: unknown) => client.put(path, { cookie: admin.cookie, body });
const adminPatch = (path: string, body: unknown) =>
  client.request('PATCH', path, { cookie: admin.cookie, body });

async function code(response: Response, status: number): Promise<string> {
  return (await json<{ code: string }>(response, status)).code;
}

const png = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 10, g: 80, b: 60 } } })
    .png()
    .toBuffer();

async function upload(width: number, height: number) {
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(await png(width, height))]), 'banner.png');
  return client.post('/api/admin/content/banners/image', { cookie: admin.cookie, form });
}

interface Draft {
  revision: number;
  title: string;
  body: string;
  unpublishedChanges: boolean;
  latestVersion: { version: number } | null;
  versions: { version: number }[];
}

const draftOf = async (page: string) =>
  json<Draft>(await adminGet(`/api/admin/content/pages/${page}`), 200);

async function saveDraft(page: string, body: string, title = 'سياسة الاسترداد') {
  const draft = await draftOf(page);
  return json<Draft>(
    await adminPut(`/api/admin/content/pages/${page}/draft`, {
      title,
      body,
      revision: draft.revision,
    }),
    200,
  );
}

async function publish(page: string, body: string) {
  const draft = await saveDraft(page, body, (await draftOf(page)).title);
  return json<{ version: number }>(
    await adminPost(`/api/admin/content/pages/${page}/publish`, { revision: draft.revision }),
    201,
  );
}

async function buyer(options: { isTest?: boolean } = {}) {
  const customer = await seedCustomer(test.db, options.isTest ? { isTest: true } : {});
  seeded.push(customer.id);
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

async function bought(who: Buyer, quantity = 1) {
  const { id } = await json<{ id: string }>(
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
  return id;
}

/** Buys, sends to the fake supplier and applies its delivery, as the worker does. */
async function delivered(who: Buyer, quantity = 1) {
  const orderId = await bought(who, quantity);
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
      values: { webhookSecret: `whsec-${run}-content` },
    }),
    200,
  );
  await test.db.execute(
    sql`update supplier_sync_runs set status = 'failed', finished_at = now(), error_code = 'TEST'
        where supplier_id = ${state.fake} and status = 'running'`,
  );
  const category = await json<{ id: string }>(
    await adminPost('/api/admin/catalog/categories', {
      slug: `content-${run}`,
      nameAr: `محتوى ${run}`,
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
  // Archive what this file created, so the limits hold for the next run.
  await test.db
    .update(faqItems)
    .set({ archivedAt: new Date() })
    .where(and(isNull(faqItems.archivedAt), sql`${faqItems.question} like ${`%${run}%`}`));
  await test.db
    .update(faqSections)
    .set({ archivedAt: new Date() })
    .where(and(isNull(faqSections.archivedAt), sql`${faqSections.title} like ${`%${run}%`}`));
  await test.db
    .update(banners)
    .set({ archivedAt: new Date(), enabled: false })
    .where(and(isNull(banners.archivedAt), sql`${banners.altText} like ${`%${run}%`}`));
  await test.db
    .update(announcements)
    .set({ archivedAt: new Date(), enabled: false })
    .where(and(isNull(announcements.archivedAt), sql`${announcements.text} like ${`%${run}%`}`));
  await test.db
    .update(catalogCategories)
    .set({ archivedAt: new Date() })
    .where(inArray(catalogCategories.id, categories));
  await removeAccounts(test.db, seeded);
  await test.app.close();
});

describe('access (S14 "Access")', () => {
  it('keeps admin routes to the admin and public routes cacheable', async () => {
    const someone = await seedCustomer(test.db);
    seeded.push(someone.id);
    const customerCookie = await client.signInCustomer(someone.email);
    const id = randomUUID();
    const adminRoutes: [string, string][] = [
      ['GET', '/api/admin/content/pages'],
      ['GET', '/api/admin/content/pages/terms'],
      ['GET', '/api/admin/content/pages/terms/versions/1'],
      ['PUT', '/api/admin/content/pages/terms/draft'],
      ['POST', '/api/admin/content/pages/terms/publish'],
      ['POST', '/api/admin/content/pages/terms/versions/1/restore'],
      ['GET', '/api/admin/content/faq'],
      ['POST', '/api/admin/content/faq/sections'],
      ['PATCH', `/api/admin/content/faq/sections/${id}`],
      ['POST', `/api/admin/content/faq/sections/${id}/archive`],
      ['POST', `/api/admin/content/faq/sections/${id}/restore`],
      ['POST', '/api/admin/content/faq/items'],
      ['PATCH', `/api/admin/content/faq/items/${id}`],
      ['POST', `/api/admin/content/faq/items/${id}/archive`],
      ['POST', `/api/admin/content/faq/items/${id}/restore`],
      ['PUT', '/api/admin/content/faq/order'],
      ['POST', '/api/admin/content/faq/publish'],
      ['POST', '/api/admin/content/banners/image'],
      ['GET', '/api/admin/content/banners'],
      ['POST', '/api/admin/content/banners'],
      ['PUT', '/api/admin/content/banners/order'],
      ['PATCH', `/api/admin/content/banners/${id}`],
      ['POST', `/api/admin/content/banners/${id}/enable`],
      ['POST', `/api/admin/content/banners/${id}/disable`],
      ['POST', `/api/admin/content/banners/${id}/archive`],
      ['POST', `/api/admin/content/banners/${id}/restore`],
      ['GET', '/api/admin/content/announcements'],
      ['POST', '/api/admin/content/announcements'],
      ['PATCH', `/api/admin/content/announcements/${id}`],
      ['POST', `/api/admin/content/announcements/${id}/enable`],
      ['POST', `/api/admin/content/announcements/${id}/disable`],
      ['POST', `/api/admin/content/announcements/${id}/archive`],
      ['POST', `/api/admin/content/announcements/${id}/restore`],
      ['GET', '/api/admin/content/settings'],
      ['PUT', '/api/admin/content/settings'],
      ['GET', '/api/admin/content/activity'],
    ];
    // 403 without TOTP is the access guard's, for every `@AdminRoute()` (access.test.ts).
    for (const [method, path] of adminRoutes) {
      expect((await client.request(method, path)).status, path).toBe(401);
      expect((await client.request(method, path, { cookie: customerCookie })).status, path).toBe(
        401,
      );
    }
    for (const path of ['/api/content/site', '/api/content/activity']) {
      const response = await client.get(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('cache-control'), path).toBe('public, max-age=60');
    }
  });
});

describe('pages (PG1–PG6)', () => {
  it('lists the five pages and keeps an unpublished page off the store', async () => {
    const pages = await json<{ page: string }[]>(await adminGet('/api/admin/content/pages'), 200);
    expect(pages.map((page) => page.page)).toEqual([
      'terms',
      'privacy',
      'refund',
      'about',
      'merchant_terms',
    ]);
    expect(await code(await client.get('/api/content/pages/about'), 404)).toBe('NOT_FOUND');
    expect(await code(await client.get('/api/content/pages/nope'), 404)).toBe('NOT_FOUND');
    expect(await code(await adminGet('/api/admin/content/pages/nope'), 404)).toBe('NOT_FOUND');
    const site = await json<{ pages: { page: string }[] }>(
      await client.get('/api/content/site'),
      200,
    );
    expect(site.pages.map((page) => page.page)).not.toContain('about');
  });

  it('refuses Markdown problems by line and a stale revision (MD2, PG3)', async () => {
    const draft = await draftOf('refund');
    const refused = await json<{ code: string; details: { path: unknown[]; message: string }[] }>(
      await adminPut('/api/admin/content/pages/refund/draft', {
        title: 'سياسة الاسترداد',
        body: '## عنوان\n<b>x</b>\n[x](https://example.com)',
        revision: draft.revision,
      }),
      400,
    );
    expect(refused.code).toBe('VALIDATION_FAILED');
    expect(refused.details).toEqual([
      { path: ['body', 2], message: 'html' },
      { path: ['body', 3], message: 'link' },
    ]);
    const saved = await saveDraft('refund', `## الاسترداد ${run}\nإلى المحفظة.`);
    expect(saved.revision).toBe(draft.revision + 1);
    expect(saved.unpublishedChanges).toBe(true);
    expect(
      await code(
        await adminPut('/api/admin/content/pages/refund/draft', {
          title: 'سياسة الاسترداد',
          body: 'نص آخر',
          revision: draft.revision,
        }),
        409,
      ),
    ).toBe('CONTENT_STALE');
    const entries = await auditOf(test.db, '00000000-0000-7000-8000-0000000c0003');
    expect(entries.at(-1)).toMatchObject({
      action: 'content_page.draft_saved',
      details: { page: 'refund', revision: saved.revision, bodyLength: saved.body.length },
    });
    expect(JSON.stringify(entries.at(-1)?.details)).not.toContain('الاسترداد ');
  });

  it('publishes a version with its audit entry and the store refresh (PG5, CP1)', async () => {
    const before = await draftOf('refund');
    const body = `## الاسترداد ${run}\n**إلى المحفظة** فقط.`;
    const saved = await saveDraft('refund', body);
    expect(
      await code(
        await adminPost('/api/admin/content/pages/refund/publish', { revision: before.revision }),
        409,
      ),
    ).toBe('CONTENT_STALE');
    const version = await json<{ version: number; body: string; draftRevision: number }>(
      await adminPost('/api/admin/content/pages/refund/publish', { revision: saved.revision }),
      201,
    );
    expect(version).toMatchObject({ body, draftRevision: saved.revision });
    expect(version.version).toBe((before.latestVersion?.version ?? 0) + 1);
    const entry = (await auditOf(test.db, '00000000-0000-7000-8000-0000000c0003')).at(-1);
    expect(entry).toMatchObject({
      action: 'content_page.published',
      details: { page: 'refund', version: version.version, bodyLength: body.length },
    });
    expect((entry?.details as { bodySha256?: string } | undefined)?.bodySha256).toMatch(
      /^[0-9a-f]{64}$/,
    );
    const jobs = await test.db.execute<{ count: number }>(
      sql`select count(*)::int as count from pgboss.job
          where name = ${QUEUES.storeRevalidate} and created_on > now() - interval '1 minute'
            and data ->> 'tag' = 'content'`,
    );
    // Audit A10-16: a content change expires the content tag only.
    expect(jobs.rows[0]?.count).toBeGreaterThan(0);
    // Edge case 2: the same revision again has nothing new.
    expect(
      await code(
        await adminPost('/api/admin/content/pages/refund/publish', { revision: saved.revision }),
        409,
      ),
    ).toBe('CONTENT_UNCHANGED');
    const published = await client.get('/api/content/pages/refund');
    expect(published.headers.get('cache-control')).toBe('public, max-age=60');
    expect(await json(published, 200)).toEqual({
      page: 'refund',
      title: 'سياسة الاسترداد',
      body,
      version: version.version,
      updatedAt: expect.any(String),
    });
    const site = await json<{ pages: { page: string }[] }>(
      await client.get('/api/content/site'),
      200,
    );
    expect(site.pages.map((page) => page.page)).toContain('refund');
    // A draft saved after publishing never reaches the store (CP3).
    await saveDraft('refund', `مسودة ${run}`);
    expect(
      (await json<{ body: string }>(await client.get('/api/content/pages/refund'), 200)).body,
    ).toBe(body);
  });

  it('tells the store whether registration is open, for its cached header', async () => {
    const site = async () =>
      json<{ registrationOpen: boolean }>(await client.get('/api/content/site'), 200);
    await setSwitches(test.db, { registration_open: true });
    expect((await site()).registrationOpen).toBe(true);
    await setSwitches(test.db, { registration_open: false });
    expect((await site()).registrationOpen).toBe(false);
    await setSwitches(test.db, { registration_open: true });
  });

  it('refuses an empty body and restores a version into the draft (PG6, edge cases 1, 4)', async () => {
    const empty = await saveDraft('refund', '');
    expect(
      await code(
        await adminPost('/api/admin/content/pages/refund/publish', { revision: empty.revision }),
        400,
      ),
    ).toBe('VALIDATION_FAILED');
    const newest = empty.versions[0]?.version as number;
    expect(
      await code(
        await adminPost(`/api/admin/content/pages/refund/versions/999999/restore`, {
          revision: empty.revision,
        }),
        404,
      ),
    ).toBe('NOT_FOUND');
    const restored = await json<Draft>(
      await adminPost(`/api/admin/content/pages/refund/versions/${newest}/restore`, {
        revision: empty.revision,
      }),
      200,
    );
    expect(restored.revision).toBe(empty.revision + 1);
    expect(restored.unpublishedChanges).toBe(false);
    const version = await json<{ body: string }>(
      await adminGet(`/api/admin/content/pages/refund/versions/${newest}`),
      200,
    );
    expect(restored.body).toBe(version.body);
    expect(
      await code(
        await adminPost('/api/admin/content/pages/refund/publish', { revision: restored.revision }),
        409,
      ),
    ).toBe('CONTENT_UNCHANGED');
    expect(await code(await adminGet('/api/admin/content/pages/refund/versions/0'), 404)).toBe(
      'NOT_FOUND',
    );
  });
});

describe('terms acceptance (TA2, TA3)', () => {
  const signUp = async () => {
    const email = uniqueEmail('content-sign-up');
    await setSwitches(test.db, { registration_open: true });
    const response = await client.post('/api/auth/sign-up/email', {
      body: { name: 'سارة الأحمد', email, password: PASSWORD, phone: '0944 123 456' },
      headers: await client.altcha(),
    });
    expect(response.status).toBe(200);
    await setSwitches(test.db);
    const [row] = await test.db.select().from(customers).where(eq(customers.email, email));
    seeded.push(row?.id as string);
    expect(await lastCode(test.db, email)).toMatch(/^\d+$/);
    return row as typeof customers.$inferSelect;
  };

  const newest = async (page: 'terms' | 'privacy') => {
    const [row] = await test.db
      .select()
      .from(contentPageVersions)
      .where(eq(contentPageVersions.page, page))
      .orderBy(desc(contentPageVersions.version))
      .limit(1);
    return row ?? null;
  };

  it('stores the versions in force at sign-up, and keeps them after a new version', async () => {
    const before = await signUp();
    expect(before.termsVersionId).toBe((await newest('terms'))?.id ?? null);
    expect(before.privacyVersionId).toBe((await newest('privacy'))?.id ?? null);
    const first = await publish('terms', `## الشروط ${run}\nنص.`);
    await publish('privacy', `## الخصوصية ${run}\nنص.`);
    const customer = await signUp();
    expect(customer.termsVersionId).toBe((await newest('terms'))?.id);
    expect(customer.privacyVersionId).toBe((await newest('privacy'))?.id);
    await publish('terms', `## الشروط ${run}\nنص ثانٍ.`);
    const profile = await json<{
      termsVersion: { version: number; publishedAt: string } | null;
      privacyVersion: { version: number } | null;
    }>(await adminGet(`/api/admin/customers/${customer.id}`), 200);
    expect(profile.termsVersion).toEqual({
      version: first.version,
      publishedAt: expect.any(String),
    });
    expect(profile.privacyVersion).not.toBeNull();
    const plain = await seedCustomer(test.db);
    seeded.push(plain.id);
    const unpublished = await json<{ termsVersion: unknown; privacyVersion: unknown }>(
      await adminGet(`/api/admin/customers/${plain.id}`),
      200,
    );
    expect(unpublished).toMatchObject({ termsVersion: null, privacyVersion: null });
  });
});

describe('FAQ (FQ1–FQ7)', () => {
  interface WorkingCopy {
    revision: number;
    sections: { id: string; title: string; items: { id: string }[] }[];
    publication: { revision: number } | null;
  }
  const working = async (archived = false) =>
    json<WorkingCopy>(
      await adminGet(`/api/admin/content/faq${archived ? '?archived=true' : ''}`),
      200,
    );
  const section = async (title: string) =>
    json<{ id: string }>(await adminPost('/api/admin/content/faq/sections', { title }), 201);
  const item = async (sectionId: string, question: string, answer = 'الجواب **هنا**.') =>
    json<{ id: string; position: number }>(
      await adminPost('/api/admin/content/faq/items', { sectionId, question, answer }),
      201,
    );

  it('edits a working copy, publishes it as a snapshot, then hides an empty one', async () => {
    const first = await section(`الدفع ${run}`);
    const second = await section(`الطلبات ${run}`);
    const a = await item(first.id, `كيف أشحن؟ ${run}`);
    const b = await item(first.id, `كم يستغرق؟ ${run}`);
    const c = await item(second.id, `أين طلبي؟ ${run}`);
    const refused = await json<{ details: { path: unknown[] }[] }>(
      await adminPost('/api/admin/content/faq/items', {
        sectionId: first.id,
        question: `سؤال مع صورة ${run}`,
        answer: 'نص\n![x](/a.png)',
      }),
      400,
    );
    expect(refused.details).toEqual([{ path: ['answer', 2], message: 'image' }]);
    const before = await working();
    // FQ4: a list missing a question is refused, the full list is applied.
    const order = before.sections.map((row) => ({
      id: row.id,
      itemIds: row.items.map((i) => i.id),
    }));
    const mine = order.filter((row) => row.id === first.id || row.id === second.id);
    expect(mine).toHaveLength(2);
    expect(
      await code(
        await adminPut('/api/admin/content/faq/order', {
          sections: order.map((row) => (row.id === first.id ? { ...row, itemIds: [a.id] } : row)),
        }),
        400,
      ),
    ).toBe('VALIDATION_FAILED');
    const reordered = await json<WorkingCopy>(
      await adminPut('/api/admin/content/faq/order', {
        sections: order.map((row) =>
          row.id === first.id ? { ...row, itemIds: [b.id, a.id] } : row,
        ),
      }),
      200,
    );
    expect(reordered.sections.find((row) => row.id === first.id)?.items.map((i) => i.id)).toEqual([
      b.id,
      a.id,
    ]);
    expect(reordered.revision).toBeGreaterThan(before.revision);
    // FQ6: a stale revision, then the current one.
    expect(
      await code(
        await adminPost('/api/admin/content/faq/publish', { revision: before.revision }),
        409,
      ),
    ).toBe('CONTENT_STALE');
    // FQ3: a question moves to another section, last there; an archived section hides its own.
    await json(
      await adminPatch(`/api/admin/content/faq/items/${c.id}`, {
        sectionId: first.id,
        question: `أين طلبي؟ ${run}`,
        answer: 'في [طلباتي](/orders).',
      }),
      200,
    );
    await json(await adminPost(`/api/admin/content/faq/sections/${second.id}/archive`), 200);
    expect(
      await code(
        await adminPost('/api/admin/content/faq/items', {
          sectionId: second.id,
          question: `سؤال ${run}`,
          answer: 'جواب',
        }),
        409,
      ),
    ).toBe('PARENT_ARCHIVED');
    const current = await working();
    const publication = await json<{ revision: number; sections: number; items: number }>(
      await adminPost('/api/admin/content/faq/publish', { revision: current.revision }),
      201,
    );
    expect(publication.revision).toBe(current.revision);
    expect(
      await code(
        await adminPost('/api/admin/content/faq/publish', { revision: current.revision }),
        409,
      ),
    ).toBe('CONTENT_UNCHANGED');
    const faq = await client.get('/api/content/faq');
    expect(faq.headers.get('cache-control')).toBe('public, max-age=60');
    const published = await json<{ sections: { id: string; items: { id: string }[] }[] }>(faq, 200);
    const shown = published.sections.find((row) => row.id === first.id);
    expect(shown?.items.map((row) => row.id)).toEqual([b.id, a.id, c.id]);
    expect(published.sections.map((row) => row.id)).not.toContain(second.id);
    expect(JSON.stringify(published)).not.toMatch(/archivedAt|adminId|position/);
    expect(
      (await json<{ faqPublished: boolean }>(await client.get('/api/content/site'), 200))
        .faqPublished,
    ).toBe(true);
    // Restoring a question under an archived section is refused; the section comes back first.
    await json(await adminPost(`/api/admin/content/faq/items/${c.id}/archive`), 200);
    expect((await working(true)).sections.some((row) => row.id === second.id)).toBe(true);
    await json(await adminPost(`/api/admin/content/faq/sections/${second.id}/restore`), 200);
    const audit = await auditOf(test.db, first.id);
    expect(audit.map((entry) => entry.action)).toContain('faq_section.created');
  });

  it('refuses a restored question under an archived section and the section limit (FQ2, FQ3)', async () => {
    const parent = await section(`قسم مؤرشف ${run}`);
    const question = await item(parent.id, `سؤال مؤرشف ${run}`);
    await json(await adminPost(`/api/admin/content/faq/items/${question.id}/archive`), 200);
    await json(await adminPost(`/api/admin/content/faq/sections/${parent.id}/archive`), 200);
    expect(
      await code(await adminPost(`/api/admin/content/faq/items/${question.id}/restore`), 409),
    ).toBe('PARENT_ARCHIVED');
    const live = (await working()).sections.length;
    for (let index = live; index < 12; index += 1) await section(`قسم ${index} ${run}`);
    expect(
      await code(await adminPost('/api/admin/content/faq/sections', { title: `زائد ${run}` }), 409),
    ).toBe('CONTENT_LIMIT_REACHED');
    expect(
      await code(await adminPost(`/api/admin/content/faq/sections/${parent.id}/restore`), 409),
    ).toBe('CONTENT_LIMIT_REACHED');
    expect(
      await code(await adminPost(`/api/admin/content/faq/sections/${randomUUID()}/archive`), 404),
    ).toBe('NOT_FOUND');
  });

  it('answers 404 once a publication holds no question (FQ5, edge case 6)', async () => {
    const all = await working();
    for (const row of all.sections) {
      await json(await adminPost(`/api/admin/content/faq/sections/${row.id}/archive`), 200);
    }
    const current = await working();
    await json(
      await adminPost('/api/admin/content/faq/publish', { revision: current.revision }),
      201,
    );
    expect(await code(await client.get('/api/content/faq'), 404)).toBe('NOT_FOUND');
    expect(
      (await json<{ faqPublished: boolean }>(await client.get('/api/content/site'), 200))
        .faqPublished,
    ).toBe(false);
    // The sections other runs left are restored for nothing: they were this run's or archived.
  });

  it('leaves the revision alone when an archive or restore changes nothing (A08-1)', async () => {
    const parent = await section(`قسم ثابت ${run}`);
    const question = await item(parent.id, `سؤال ثابت ${run}`);
    const before = (await working()).revision;
    // Restoring what is live and archiving twice change nothing after the first archive.
    await json(await adminPost(`/api/admin/content/faq/items/${question.id}/restore`), 200);
    await json(await adminPost(`/api/admin/content/faq/sections/${parent.id}/restore`), 200);
    expect((await working()).revision).toBe(before);
    await json(await adminPost(`/api/admin/content/faq/items/${question.id}/archive`), 200);
    const archived = (await working()).revision;
    expect(archived).toBe(before + 1);
    await json(await adminPost(`/api/admin/content/faq/items/${question.id}/archive`), 200);
    await json(await adminPost(`/api/admin/content/faq/sections/${parent.id}/archive`), 200);
    await json(await adminPost(`/api/admin/content/faq/sections/${parent.id}/archive`), 200);
    expect((await working()).revision).toBe(archived + 1);
    expect(
      (await auditOf(test.db, parent.id)).filter(
        (entry) => entry.action === 'faq_section.archived',
      ),
    ).toHaveLength(1);
  });

  it('refuses a 31st question in a section (FQ2, A08-4)', async () => {
    const parent = await section(`قسم ممتلئ ${run}`);
    for (let index = 0; index < FAQ_ITEMS_PER_SECTION_MAX; index += 1) {
      await item(parent.id, `سؤال رقم ${index} ${run}`);
    }
    expect(
      await code(
        await adminPost('/api/admin/content/faq/items', {
          sectionId: parent.id,
          question: `سؤال زائد ${run}`,
          answer: 'جواب',
        }),
        409,
      ),
    ).toBe('CONTENT_LIMIT_REACHED');
    await json(await adminPost(`/api/admin/content/faq/sections/${parent.id}/archive`), 200);
  });
});

describe('banners (BN1–BN6)', () => {
  const create = async (fileId: string, values: Record<string, unknown> = {}) =>
    json<{ id: string; state: string; position: number }>(
      await adminPost('/api/admin/content/banners', {
        imageFileId: fileId,
        altText: `بانر ${run}`,
        linkPath: '/games/pubg-mobile',
        ...values,
      }),
      201,
    );

  it('refuses small or non 2:1 images and keeps live banners on the store', async () => {
    const small = await json<{ code: string; details: { reason: string } }>(
      await upload(1000, 500),
      400,
    );
    expect(small).toMatchObject({ code: 'IMAGE_INVALID', details: { reason: 'too_small' } });
    const square = await json<{ code: string; details: { reason: string } }>(
      await upload(1200, 1200),
      400,
    );
    expect(square).toMatchObject({ code: 'IMAGE_INVALID', details: { reason: 'ratio' } });
    const image = await json<{ fileId: string; width: number; height: number }>(
      await upload(2000, 1000),
      201,
    );
    expect(image).toMatchObject({ width: 1600, height: 800 });
    expect(
      await code(
        await adminPost('/api/admin/content/banners', {
          imageFileId: randomUUID(),
          altText: `بانر ${run}`,
        }),
        400,
      ),
    ).toBe('VALIDATION_FAILED');
    expect(
      await code(
        await adminPost('/api/admin/content/banners', {
          imageFileId: image.fileId,
          altText: `بانر ${run}`,
          linkPath: 'https://evil.example',
        }),
        400,
      ),
    ).toBe('VALIDATION_FAILED');
    expect(
      await code(
        await adminPost('/api/admin/content/banners', {
          imageFileId: image.fileId,
          altText: `بانر ${run}`,
          startsAt: new Date(Date.now() - 60_000).toISOString(),
        }),
        400,
      ),
    ).toBe('VALIDATION_FAILED');
    // Make room: this run's banners only count; disable every other enabled one for the test.
    await test.db.update(banners).set({ enabled: false }).where(eq(banners.enabled, true));
    const live = await create(image.fileId);
    expect(live.state).toBe('disabled');
    await json(await adminPost(`/api/admin/content/banners/${live.id}/enable`), 200);
    const scheduled = await create(image.fileId, {
      startsAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const enabled = await json<{ state: string }>(
      await adminPost(`/api/admin/content/banners/${scheduled.id}/enable`),
      200,
    );
    expect(enabled.state).toBe('scheduled');
    const site = await json<{ banners: { id: string; imageId: string; linkPath: string }[] }>(
      await client.get('/api/content/site'),
      200,
    );
    expect(site.banners).toEqual([
      {
        id: live.id,
        imageId: image.fileId,
        altText: `بانر ${run}`,
        linkPath: '/games/pubg-mobile',
      },
    ]);
    // BN5: archiving disables; restoring comes back disabled, last.
    const archived = await json<{ enabled: boolean; state: string }>(
      await adminPost(`/api/admin/content/banners/${live.id}/archive`),
      200,
    );
    expect(archived).toMatchObject({ enabled: false, state: 'archived' });
    const restored = await json<{ enabled: boolean; position: number }>(
      await adminPost(`/api/admin/content/banners/${live.id}/restore`),
      200,
    );
    expect(restored.enabled).toBe(false);
    const list = await json<{ id: string }[]>(await adminGet('/api/admin/content/banners'), 200);
    expect(list.at(-1)?.id).toBe(live.id);
    // BN6: the full list, reversed.
    const ids = list.map((row) => row.id).reverse();
    expect(
      await code(await adminPut('/api/admin/content/banners/order', { ids: ids.slice(1) }), 400),
    ).toBe('VALIDATION_FAILED');
    const reordered = await json<{ id: string }[]>(
      await adminPut('/api/admin/content/banners/order', { ids }),
      200,
    );
    expect(reordered.map((row) => row.id)).toEqual(ids);
    expect((await auditOf(test.db, live.id)).map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        'banner.created',
        'banner.enabled',
        'banner.archived',
        'banner.restored',
      ]),
    );
  });

  it('writes no file for a refused banner image (A08-2)', async () => {
    const files = () =>
      readdir(resolve(process.env.FILES_ROOT as string), { recursive: true }).catch(() => []);
    const before = (await files()).length;
    expect(await code(await upload(1000, 500), 400)).toBe('IMAGE_INVALID');
    expect(await code(await upload(1200, 1200), 400)).toBe('IMAGE_INVALID');
    expect((await files()).length).toBe(before);
  });

  it('keeps an unchanged past start on edit and refuses enabling an archived banner (BN4, A08-4)', async () => {
    const image = await json<{ fileId: string }>(await upload(1600, 800), 201);
    const banner = await create(image.fileId, {
      startsAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const startsAt = new Date(Date.now() - 60_000);
    await test.db.update(banners).set({ startsAt }).where(eq(banners.id, banner.id));
    const edited = await json<{ altText: string; startsAt: string }>(
      await adminPatch(`/api/admin/content/banners/${banner.id}`, {
        imageFileId: image.fileId,
        altText: `بانر معدّل ${run}`,
        startsAt: startsAt.toISOString(),
      }),
      200,
    );
    expect(edited).toMatchObject({ altText: `بانر معدّل ${run}`, startsAt: startsAt.toISOString() });
    expect(
      await code(
        await adminPatch(`/api/admin/content/banners/${banner.id}`, {
          imageFileId: image.fileId,
          altText: `بانر معدّل ${run}`,
          startsAt: new Date(Date.now() - 120_000).toISOString(),
        }),
        400,
      ),
    ).toBe('VALIDATION_FAILED');
    await json(await adminPost(`/api/admin/content/banners/${banner.id}/archive`), 200);
    expect(await code(await adminPost(`/api/admin/content/banners/${banner.id}/enable`), 400)).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('enables at most 5 (BN3)', async () => {
    const image = await json<{ fileId: string }>(await upload(1600, 800), 201);
    await test.db.update(banners).set({ enabled: false }).where(eq(banners.enabled, true));
    const created = [];
    for (let index = 0; index < 6; index += 1) created.push(await create(image.fileId));
    for (const banner of created.slice(0, 5)) {
      await json(await adminPost(`/api/admin/content/banners/${banner.id}/enable`), 200);
    }
    expect(
      await code(await adminPost(`/api/admin/content/banners/${created[5]?.id}/enable`), 409),
    ).toBe('CONTENT_LIMIT_REACHED');
    for (const banner of created) {
      await json(await adminPost(`/api/admin/content/banners/${banner.id}/archive`), 200);
    }
  });
});

describe('announcements (AN1–AN4)', () => {
  const create = async (text: string, values: Record<string, unknown> = {}) =>
    json<{ id: string; revision: number }>(
      await adminPost('/api/admin/content/announcements', { text, ...values }),
      201,
    );

  it('shows one live announcement, replaces the enabled one and counts text revisions', async () => {
    const first = await create(`عرض أول ${run}`, { linkPath: '/faq', tone: 'warning' });
    const second = await create(`عرض ثانٍ ${run}`);
    await json(await adminPost(`/api/admin/content/announcements/${first.id}/enable`), 200);
    const replaced = await json<{ enabled: boolean; replaced: { id: string } | null }>(
      await adminPost(`/api/admin/content/announcements/${second.id}/enable`),
      200,
    );
    expect(replaced).toMatchObject({ enabled: true, replaced: { id: first.id } });
    expect((await auditOf(test.db, first.id)).map((entry) => entry.action)).toContain(
      'announcement.disabled',
    );
    const site = await json<{ announcement: Record<string, unknown> | null }>(
      await client.get('/api/content/site'),
      200,
    );
    expect(site.announcement).toEqual({
      id: second.id,
      revision: 1,
      text: `عرض ثانٍ ${run}`,
      linkPath: null,
      tone: 'info',
    });
    // AN4: the schedule alone keeps the revision; the text changes it.
    const later = new Date(Date.now() + 3_600_000).toISOString();
    const scheduled = await json<{ revision: number; state: string }>(
      await adminPatch(`/api/admin/content/announcements/${second.id}`, {
        text: `عرض ثانٍ ${run}`,
        endsAt: later,
      }),
      200,
    );
    expect(scheduled).toMatchObject({ revision: 1, state: 'live' });
    const edited = await json<{ revision: number }>(
      await adminPatch(`/api/admin/content/announcements/${second.id}`, {
        text: `عرض معدّل ${run}`,
        endsAt: later,
      }),
      200,
    );
    expect(edited.revision).toBe(2);
    expect(
      await code(
        await adminPatch(`/api/admin/content/announcements/${randomUUID()}`, { text: `نص ${run}` }),
        404,
      ),
    ).toBe('NOT_FOUND');
  });

  it('refuses enabling an archived announcement and a 21st unarchived one (AN2, A08-4)', async () => {
    const archived = await create(`إعلان مؤرشف ${run}`);
    await json(await adminPost(`/api/admin/content/announcements/${archived.id}/archive`), 200);
    expect(
      await code(await adminPost(`/api/admin/content/announcements/${archived.id}/enable`), 400),
    ).toBe('VALIDATION_FAILED');
    const live = (await json<unknown[]>(await adminGet('/api/admin/content/announcements'), 200))
      .length;
    const made: string[] = [];
    for (let index = live; index < ANNOUNCEMENTS_MAX; index += 1) {
      made.push((await create(`إعلان رقم ${index} ${run}`)).id);
    }
    expect(
      await code(
        await adminPost('/api/admin/content/announcements', { text: `إعلان زائد ${run}` }),
        409,
      ),
    ).toBe('CONTENT_LIMIT_REACHED');
    expect(
      await code(await adminPost(`/api/admin/content/announcements/${archived.id}/restore`), 409),
    ).toBe('CONTENT_LIMIT_REACHED');
    for (const id of made) {
      await json(await adminPost(`/api/admin/content/announcements/${id}/archive`), 200);
    }
  });

  it('leaves one enabled after concurrent enables (AN2, edge case 11)', async () => {
    const rows = await Promise.all([1, 2, 3].map((n) => create(`إعلان ${n} ${run}`)));
    const answers = await Promise.all(
      rows.map((row) => adminPost(`/api/admin/content/announcements/${row.id}/enable`)),
    );
    expect(answers.every((answer) => [200, 409].includes(answer.status))).toBe(true);
    const enabled = await test.db
      .select({ id: announcements.id })
      .from(announcements)
      .where(and(eq(announcements.enabled, true), isNull(announcements.archivedAt)));
    expect(enabled).toHaveLength(1);
    const archived = await json<{ enabled: boolean }>(
      await adminPost(`/api/admin/content/announcements/${enabled[0]?.id}/archive`),
      200,
    );
    expect(archived.enabled).toBe(false);
    expect(
      (await json<{ announcement: unknown }>(await client.get('/api/content/site'), 200))
        .announcement,
    ).toBeNull();
  });
});

describe('live activity (LA1–LA6)', () => {
  const feed = (now: Date, game?: string) =>
    test.app.get(ContentActivityService).activity(game, now);

  it('shows real deliveries of a game from the minimum, floored, nothing personal', async () => {
    const real = await buyer();
    const testBuyer = await buyer({ isTest: true });
    expect(await code(await client.get('/api/content/activity?game=Not_A_Slug'), 400)).toBe(
      'VALIDATION_FAILED',
    );
    for (let index = 0; index < ACTIVITY_MINIMUM - 1; index += 1) await delivered(real);
    await delivered(testBuyer);
    await bought(real);
    const later = new Date(Date.now() + 6 * 60_000);
    // Below the minimum on the game: nothing (LA3); test and undelivered orders never count.
    expect((await feed(later, state.gameSlug)).items).toEqual([]);
    await delivered(real);
    // Under 5 minutes old: not yet (LA1).
    const now = await json<{ items: unknown[] }>(
      await client.get(`/api/content/activity?game=${state.gameSlug}`),
      200,
    );
    expect(now.items).toEqual([]);
    const shown = await feed(later, state.gameSlug);
    expect(shown.items).toHaveLength(ACTIVITY_MINIMUM);
    expect(shown.items[0]).toEqual({
      gameSlug: state.gameSlug,
      gameNameAr: `لعبة ${run}`,
      productNameAr: `باقة ${run}`,
      quantity: 1,
      durationSeconds: expect.any(Number),
      deliveredAt: expect.stringMatching(/:[0-5][05]:00\.000Z$/),
    });
    expect(Object.keys(shown.items[0] as object).sort()).toEqual([
      'deliveredAt',
      'durationSeconds',
      'gameNameAr',
      'gameSlug',
      'productNameAr',
      'quantity',
    ]);
    expect((await feed(later, `unknown-${run}`)).items).toEqual([]);
    // Over 24 hours: gone.
    expect((await feed(new Date(Date.now() + 25 * 3_600_000), state.gameSlug)).items).toEqual([]);
    // LA6: switched off, nothing anywhere; the admin preview ignores the switch.
    await json(await adminPut('/api/admin/content/settings', { liveActivityEnabled: false }), 200);
    expect((await feed(later, state.gameSlug)).items).toEqual([]);
    const preview = await json<{ enabled: boolean; minimum: number; qualifyingLast24h: number }>(
      await adminGet('/api/admin/content/activity'),
      200,
    );
    expect(preview).toMatchObject({ enabled: false, minimum: ACTIVITY_MINIMUM });
    await json(await adminPut('/api/admin/content/settings', { liveActivityEnabled: true }), 200);
    expect(
      (await auditOf(test.db, '00000000-0000-7000-8000-0000000c0020'))
        .slice(-2)
        .map((e) => e.action),
    ).toEqual(['content_settings.set', 'content_settings.set']);
    // A hidden game or an archived product drops out (LA1, edge case 15).
    await test.db.execute(
      sql`update catalog_games set status = 'paused' where id = ${state.gameId}`,
    );
    expect((await feed(later, state.gameSlug)).items).toEqual([]);
    await test.db.execute(
      sql`update catalog_games set status = 'active' where id = ${state.gameId}`,
    );
    await json(await adminPost(`/api/admin/catalog/products/${state.productId}/archive`), 200);
    expect((await feed(later, state.gameSlug)).items).toEqual([]);
  });
});
