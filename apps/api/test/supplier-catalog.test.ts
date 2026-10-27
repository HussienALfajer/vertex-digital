import { randomBytes } from 'node:crypto';
import {
  type CategoryImportResult,
  type FieldSpec,
  type ImportDraft,
  type ProductRouting,
  type SupplierCategoryNode,
  type SupplierCategoryPage,
  type SupplierOfferPage,
  type SupplierSummary,
  type SupplierWebhookSettings,
} from '@vertex-digital/contracts';
import {
  catalogCategories,
  fulfilmentAttempts,
  lockOrder,
  newId,
  supplierBalanceReads,
  supplierCategories,
  supplierHealthChanges,
  supplierOffers,
  supplierSyncRuns,
  suppliers,
  transitionOrder,
} from '@vertex-digital/db';
import {
  FakeSupplierAdapter,
  FazercardsAdapter,
  fakeSupplierStateSchema,
} from '@vertex-digital/suppliers';
import { type FakeHttpServer, startFakeHttpServer } from '@vertex-digital/suppliers/testing';
import { and, eq, inArray, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SupplierAdaptersService, SupplierLiveService } from '../src/modules/suppliers/index.js';
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
 * The supplier catalog (S16 SC4–SC14, IM1–IM3, SF1–SF5) over HTTP against the test database with
 * the `fake` supplier. The worker's sync is played by writing categories and offers as it does.
 * Supplier calls are not recorded (`recordCall` is spied on: `supplier_calls` is append-only and
 * the worker's tests read the fake's calls). Category rows cannot be deleted: this file's rows
 * are made missing and unlinked in `afterAll`, its offers missing, its store category archived.
 */

let test: TestApp;
let client: ReturnType<typeof api>;
let admin: Awaited<ReturnType<ReturnType<typeof api>['adminWithTotp']>>;
let customerCookie: string;
const seeded: string[] = [];
const run = randomBytes(4).toString('hex');
const usd = (dollars: number) => Math.round(dollars * 1_000_000);
const ids = { fake: '', storeCategory: '', game: '', product: '', route: '', price: 0 };
const offers: Record<string, string> = {};
const recorded: { operation: string }[] = [];
const node = (name: string) => `c${run}-${name}`;
const IMAGE = (name: string) => `https://fake-supplier.invalid/images/${name}.png`;

async function json<T = Record<string, unknown>>(response: Response, status: number): Promise<T> {
  const payload = await response.json();
  expect(response.status, JSON.stringify(payload)).toBe(status);
  return payload as T;
}

const get = (path: string) => client.get(path, { cookie: admin.cookie });
const post = (path: string, payload?: unknown) =>
  client.post(path, { cookie: admin.cookie, body: payload });

async function reauthenticate() {
  const response = await client.post('/api/admin/me/reauthenticate', {
    cookie: admin.cookie,
    body: { password: PASSWORD, totpCode: totp(admin.secret) },
  });
  expect(response.status).toBe(200);
}

/** A category of the fake's tree, as the sync writes it. */
async function category(
  name: string,
  values: { parent?: string; kind?: 'direct' | 'code'; image?: string | null } = {},
) {
  await test.db.insert(supplierCategories).values({
    supplierId: ids.fake,
    categoryId: node(name),
    parentCategoryId: values.parent ? node(values.parent) : null,
    name: `${name} ${run}`,
    kind: values.kind ?? 'direct',
    productCount: 3,
    inStockCount: 2,
    imageUrl: values.image === undefined ? IMAGE('fake-pubg') : values.image,
    lastSeenAt: new Date(),
  });
}

/** An offer of the fake under a leaf, as the sync writes it. */
async function offer(
  key: string,
  leaf: string,
  values: {
    cost?: number;
    kind?: 'direct' | 'code';
    unsupported?: boolean;
    stock?: number | null;
    fields?: FieldSpec[];
    name?: string;
  } = {},
) {
  const fields = values.fields ?? [{ key: 'player_id', label: 'Player ID', type: 'text' as const }];
  const now = new Date();
  const [row] = await test.db
    .insert(supplierOffers)
    .values({
      supplierId: ids.fake,
      offerId: `${key}-${run}`,
      name: values.name ?? `${key} ${run}`,
      groupName: `Group ${run}`,
      kind: values.kind ?? 'direct',
      requiredFields: fields.map((field) => field.key),
      fieldSpecs: fields,
      costUsdUnits: usd(values.cost ?? 1),
      originalCostUsdUnits: usd((values.cost ?? 1) * 1.25),
      inStock: true,
      stock: values.stock === undefined ? 50 : values.stock,
      costConfirmedAt: now,
      lastSeenAt: now,
      categoryId: node(leaf),
      unsupportedReason: values.unsupported ? 'fields_unsupported' : null,
    })
    .returning({ id: supplierOffers.id });
  offers[key] = (row as { id: string }).id;
  return offers[key] as string;
}

const tree = (query = '') =>
  get(`/api/admin/suppliers/fake/categories${query}`).then((response) =>
    json<SupplierCategoryPage>(response, 200),
  );
const nodeOf = async (name: string) =>
  (await tree(`?q=${encodeURIComponent(`${name} ${run}`)}`)).items.find(
    (item) => item.categoryId === node(name),
  ) as SupplierCategoryNode;

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
  vi.spyOn(SupplierAdaptersService.prototype, 'recordCall').mockImplementation(
    async (_tx, call) => {
      recorded.push(call);
    },
  );
  const [fake] = await test.db.select().from(suppliers).where(eq(suppliers.code, 'fake'));
  ids.fake = fake?.id as string;
  await json(
    await client.put('/api/admin/suppliers/fake/credentials', {
      cookie: admin.cookie,
      body: { values: { webhookSecret: `whsec-${run}-a1b2` } },
    }),
    200,
  );
  await test.db
    .insert(supplierBalanceReads)
    .values({ supplierId: ids.fake, currency: 'USD', amountUnits: usd(1_000_000) });
  // Six hours old: the worker's health tests put the fake's states an hour back and less, and a
  // newer row committed here would outrank theirs (the newest row is the state).
  await test.db.insert(supplierHealthChanges).values({
    supplierId: ids.fake,
    state: 'healthy',
    reason: 'supplier catalog test',
    createdAt: new Date(Date.now() - 6 * 3_600_000),
  });
  const store = await json<{ id: string }>(
    await post('/api/admin/catalog/categories', { slug: `cat-${run}`, nameAr: `فئة ${run}` }),
    201,
  );
  ids.storeCategory = store.id;
  // The tree: PUBG (Global, MENA), Free Fire (Auto), and a node without an image.
  await category('pubg');
  await category('global', { parent: 'pubg' });
  await category('mena', { parent: 'pubg' });
  await category('ff', { image: IMAGE('fake-ff') });
  await category('ff-auto', { parent: 'ff' });
  await category('bare', { image: null });
  await offer('uc60', 'global', { cost: 0.88 });
  await offer('uc325', 'global', { cost: 4.4 });
  await offer('uc660', 'mena', { cost: 8.7, stock: 4 });
  await offer('two', 'mena', {
    unsupported: true,
    fields: [
      { key: 'user_id', label: 'User ID', type: 'text' },
      { key: 'server_id', label: 'Server ID', type: 'text' },
    ],
  });
  await offer('ff100', 'ff-auto', { cost: 0.95 });
  await offer('ff310', 'ff-auto', { cost: 2.9 });
});

afterAll(async () => {
  await test.db
    .update(supplierCategories)
    .set({ missingSince: new Date(), gameId: null, linkedAt: null })
    .where(like(supplierCategories.categoryId, `c${run}-%`));
  await test.db
    .update(supplierOffers)
    .set({ missingSince: new Date() })
    .where(inArray(supplierOffers.id, Object.values(offers)));
  await test.db
    .update(catalogCategories)
    .set({ archivedAt: new Date() })
    .where(eq(catalogCategories.id, ids.storeCategory));
  await test.db
    .update(supplierSyncRuns)
    .set({ status: 'failed', finishedAt: new Date(), errorCode: 'TEST' })
    .where(and(eq(supplierSyncRuns.supplierId, ids.fake), eq(supplierSyncRuns.status, 'running')));
  vi.restoreAllMocks();
  await removeAccounts(test.db, seeded);
  await test.app.close();
});

describe('access', () => {
  const id = '0199a000-0000-7000-8000-000000000001';
  const routes: [string, string][] = [
    ['GET', '/api/admin/suppliers/fake/categories'],
    ['GET', '/api/admin/suppliers/fake/categories/x/image'],
    ['GET', '/api/admin/suppliers/fake/categories/x/import-draft'],
    ['POST', '/api/admin/suppliers/fake/categories/x/import'],
    ['POST', '/api/admin/suppliers/fake/categories/x/link'],
    ['POST', '/api/admin/suppliers/fake/categories/x/unlink'],
    ['POST', '/api/admin/suppliers/fake/categories/x/ignore'],
    ['POST', '/api/admin/suppliers/fake/categories/x/unignore'],
    ['POST', `/api/admin/suppliers/offers/${id}/ignore`],
    ['POST', `/api/admin/suppliers/offers/${id}/unignore`],
    ['POST', `/api/admin/catalog/games/${id}/activate-all`],
    ['POST', `/api/admin/catalog/games/${id}/cover/from-supplier`],
    ['GET', `/api/admin/catalog/games/${id}/supplier-categories`],
    ['GET', '/api/admin/suppliers/fake/statement/transactions'],
    ['GET', '/api/admin/suppliers/fake/statement/orders'],
    ['GET', '/api/admin/suppliers/fake/platform-status'],
    ['GET', `/api/admin/orders/${id}/attempts/${id}/supplier-orders`],
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

  it('answers 404 for an unknown supplier or one without the capability', async () => {
    expect((await get('/api/admin/suppliers/nope/categories')).status).toBe(404);
    const refused = await json<{ code: string }>(
      await get('/api/admin/suppliers/manual/statement/orders'),
      409,
    );
    expect(refused.code).toBe('CAPABILITY_UNSUPPORTED');
  });
});

describe('the tree (rules SC4, SC5)', () => {
  it('lists a level, children on request, and any depth by name with the path', async () => {
    const roots = await tree(`?pageSize=200&q=${encodeURIComponent(run)}`);
    expect(roots.items.map((item) => item.categoryId)).toEqual(
      expect.arrayContaining([node('pubg'), node('global'), node('ff')]),
    );
    const children = await tree(`?parentId=${node('pubg')}`);
    expect(children.items.map((item) => item.categoryId)).toEqual([node('global'), node('mena')]);
    const global = children.items[0] as SupplierCategoryNode;
    expect(global).toMatchObject({
      parentCategoryId: node('pubg'),
      path: [`pubg ${run}`],
      kind: 'direct',
      productCount: 3,
      hasImage: true,
      childCount: 0,
      counts: { mapped: 0, unmapped: 2, ignored: 0, unsupported: 0, newPacks: 0 },
      state: 'not_imported',
      game: null,
      linkedHere: false,
    });
    const pubg = await nodeOf('pubg');
    expect(pubg).toMatchObject({ childCount: 2, counts: { unmapped: 4, unsupported: 1 } });
    expect(
      (await tree(`?state=ignored&q=${run}`)).items.filter((item) =>
        item.categoryId.startsWith(`c${run}`),
      ),
    ).toEqual([]);
  });

  it('serves category images as WebP thumbnails through the API only (rule IM1)', async () => {
    const response = await get(`/api/admin/suppliers/fake/categories/${node('pubg')}/image`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('image/webp');
    expect(response.headers.get('cache-control')).toBe('private, max-age=86400');
    const missing = await get(`/api/admin/suppliers/fake/categories/${node('bare')}/image`);
    expect(missing.status).toBe(404);
    expect((await get('/api/admin/suppliers/fake/categories/no%20such/image')).status).toBe(404);
  });
});

describe('import and link (rules SC7–SC14, IM2)', () => {
  let imported: CategoryImportResult;

  it('drafts the game, fields and packs with refusals and prices', async () => {
    const draft = await json<ImportDraft>(
      await get(`/api/admin/suppliers/fake/categories/${node('pubg')}/import-draft`),
      200,
    );
    expect(draft.kind).toBe('direct');
    expect(draft.game).toMatchObject({ nameAr: `pubg ${run}`, nameEn: `pubg ${run}` });
    expect(draft.game.slug).toMatch(/^pubg-/);
    expect(draft.fields).toEqual([
      expect.objectContaining({
        supplierKey: 'player_id',
        supplierLabel: 'Player ID',
        key: 'player_id',
        labelAr: 'معرّف اللاعب',
        type: 'digits',
      }),
    ]);
    expect(draft.fieldMap).toEqual({ player_id: 'player_id' });
    const byName = new Map(draft.packs.map((pack) => [pack.supplierOfferId, pack]));
    expect(byName.get(`uc60-${run}`)).toMatchObject({
      leafName: `global ${run}`,
      costUsdUnits: usd(0.88),
      discountPercent: 20,
      stockLevel: 'ok',
      refusal: null,
      suggestedNameAr: `uc60 ${run} · global ${run}`,
      suggestedGameAmount: 60,
    });
    expect(byName.get(`uc60-${run}`)?.pricePreviewUsdUnits).toBeGreaterThan(usd(0.88));
    expect(byName.get(`two-${run}`)?.refusal).toBe('OFFER_UNSUPPORTED');
    expect(byName.get(`uc660-${run}`)?.stockLevel).toBe('low');
  });

  it('refuses unsupported rows and a missing node, writing nothing', async () => {
    const payload = {
      game: {
        slug: `pubg-${run}`,
        categoryId: ids.storeCategory,
        nameAr: `ببجي ${run}`,
        nameEn: `PUBG ${run}`,
      },
      cover: { supplierImage: true },
      fields: [
        {
          key: 'player_id',
          labelAr: 'المعرف',
          type: 'digits',
          required: true,
          minLength: 1,
          maxLength: 32,
        },
      ],
      fieldMap: { player_id: 'player_id' },
      rows: [
        { offerId: offers.uc60, nameAr: '60 UC' },
        { offerId: offers.two, nameAr: 'Two fields' },
      ],
    };
    const refused = await json<{ code: string; details: { rows: unknown[] } }>(
      await post(`/api/admin/suppliers/fake/categories/${node('pubg')}/import`, payload),
      409,
    );
    expect(refused.code).toBe('OFFER_UNSUPPORTED');
    expect(refused.details.rows).toEqual([{ index: 1, code: 'OFFER_UNSUPPORTED' }]);
    expect((await nodeOf('pubg')).state).toBe('not_imported');
    await category('gone', { image: null });
    await test.db
      .update(supplierCategories)
      .set({ missingSince: new Date() })
      .where(eq(supplierCategories.categoryId, node('gone')));
    const missing = await json<{ code: string }>(
      await post(`/api/admin/suppliers/fake/categories/${node('gone')}/import`, payload),
      409,
    );
    expect(missing.code).toBe('CATEGORY_MISSING');
  });

  it('imports a node as a paused game with the supplier image, fields, packs and prices', async () => {
    imported = await json<CategoryImportResult>(
      await post(`/api/admin/suppliers/fake/categories/${node('pubg')}/import`, {
        game: {
          slug: `pubg-${run}`,
          categoryId: ids.storeCategory,
          nameAr: `ببجي ${run}`,
          nameEn: `PUBG ${run}`,
        },
        cover: { supplierImage: true },
        fields: [
          {
            key: 'player_id',
            labelAr: 'معرّف اللاعب',
            type: 'digits',
            required: true,
            minLength: 1,
            maxLength: 32,
          },
        ],
        fieldMap: { player_id: 'player_id' },
        rows: [
          { offerId: offers.uc60, nameAr: `UC 60 ${run}`, gameAmount: 60 },
          { offerId: offers.uc660, nameAr: `UC 660 ${run}` },
        ],
      }),
      201,
    );
    ids.game = imported.gameId;
    ids.product = imported.products[0]?.id as string;
    ids.route = imported.products[0]?.routeId as string;
    ids.price = imported.products[0]?.priceUsdUnits as number;
    expect(imported.products).toHaveLength(2);
    expect(imported.products.every((product) => !product.existing)).toBe(true);
    expect(imported.products.every((product) => (product.priceUsdUnits ?? 0) > 0)).toBe(true);
    const game = await json<{
      status: string;
      cover: unknown;
      fields: { key: string }[];
      products: { status: string; gameAmount: number | null }[];
    }>(await get(`/api/admin/catalog/games/${ids.game}`), 200);
    expect(game.status).toBe('paused');
    expect(game.cover).not.toBeNull();
    expect(game.fields.map((field) => field.key)).toEqual(['player_id']);
    expect(game.products.map((product) => [product.status, product.gameAmount])).toEqual([
      ['paused', 60],
      ['paused', null],
    ]);
    const pubg = await nodeOf('pubg');
    expect(pubg).toMatchObject({
      state: 'new_packs',
      linkedHere: true,
      game: { id: ids.game, nameAr: `ببجي ${run}` },
      counts: { mapped: 2, newPacks: 1 },
    });
    expect((await nodeOf('global')).game?.id).toBe(ids.game);
    const [row] = await test.db
      .select({ id: supplierCategories.id })
      .from(supplierCategories)
      .where(eq(supplierCategories.categoryId, node('pubg')));
    const audit = await auditOf(test.db, row?.id as string);
    expect(audit.map((entry) => entry.action)).toEqual(['supplier.category_imported']);
    expect(audit[0]?.details).toEqual({
      supplier: 'fake',
      categoryId: node('pubg'),
      gameId: ids.game,
      count: 2,
    });
  });

  it('refuses another import in the linked tree (CATEGORY_LINKED)', async () => {
    const refused = await json<{ code: string; details: { gameId: string } }>(
      await post(`/api/admin/suppliers/fake/categories/${node('mena')}/import`, {
        game: { slug: `mena-${run}`, categoryId: ids.storeCategory, nameAr: 'م', nameEn: 'M' },
        cover: { supplierImage: true },
        fields: [],
        rows: [{ offerId: offers.uc325, nameAr: 'x' }],
      }),
      409,
    );
    expect(refused).toMatchObject({ code: 'CATEGORY_LINKED', details: { gameId: ids.game } });
  });

  it('links a node to the game, routing an existing pack and creating a new one', async () => {
    const draft = await json<ImportDraft>(
      await get(
        `/api/admin/suppliers/fake/categories/${node('global')}/import-draft?gameId=${ids.game}`,
      ),
      200,
    );
    expect(draft.linkGame?.fields).toEqual([
      { key: 'player_id', labelAr: 'معرّف اللاعب', type: 'digits', options: null },
    ]);
    expect(draft.fieldMap).toEqual({ player_id: 'player_id' });
    // S17 WR1: a pack with a fake route already takes a second one, here not counting for its
    // price (WR7); a new pack is created beside it, its only route counting.
    const existing = imported.products[1]?.id as string;
    const before = await json<{ basisRouteId: string; currentPrice: { priceUsdUnits: number } }>(
      await get(`/api/admin/catalog/products/${existing}/routes`),
      200,
    );
    const linked = await json<CategoryImportResult>(
      await post(`/api/admin/suppliers/fake/categories/${node('ff')}/link`, {
        gameId: ids.game,
        fieldMap: { player_id: 'player_id' },
        rows: [
          { offerId: offers.ff100, productId: existing, priceBasis: false },
          { offerId: offers.ff310, nameAr: `FF 310 ${run}` },
        ],
      }),
      201,
    );
    expect(linked.products.map((row) => row.existing)).toEqual([true, false]);
    expect(linked.products[0]?.id).toBe(existing);
    const after = await json<{
      basisRouteId: string;
      currentPrice: { priceUsdUnits: number };
      routes: { id: string; priceBasis: boolean }[];
    }>(await get(`/api/admin/catalog/products/${existing}/routes`), 200);
    expect(after.basisRouteId).toBe(before.basisRouteId);
    expect(after.currentPrice.priceUsdUnits).toBe(before.currentPrice.priceUsdUnits);
    expect(after.routes.find((route) => route.id === linked.products[0]?.routeId)).toMatchObject({
      priceBasis: false,
    });
    const fresh = await json<{ routes: { priceBasis: boolean }[] }>(
      await get(`/api/admin/catalog/products/${linked.products[1]?.id}/routes`),
      200,
    );
    expect(fresh.routes.map((route) => route.priceBasis)).toEqual([true]);
    expect((await nodeOf('ff')).state).toBe('linked');
  });

  it('matches a pack by its amount only in the unit the product delivers (A05-3)', async () => {
    // The game's "UC 60" pack is routed to the offer named `uc60 <run>`.
    await category('wow');
    await category('ucx');
    await offer('wow60', 'wow', { name: `wow60 ${run}` });
    await offer('uc60x', 'ucx', { name: `uc60 ${run}` });
    const draftOf = async (name: string) =>
      (
        await json<ImportDraft>(
          await get(
            `/api/admin/suppliers/fake/categories/${node(name)}/import-draft?gameId=${ids.game}`,
          ),
          200,
        )
      ).packs[0];
    expect(await draftOf('wow')).toMatchObject({ suggestedGameAmount: 60, match: null });
    expect((await draftOf('ucx'))?.match).toMatchObject({ productId: ids.product });
  });

  it('unlinks a node, keeping the game and its routes (rule SC9)', async () => {
    const unlinked = await json<SupplierCategoryNode>(
      await post(`/api/admin/suppliers/fake/categories/${node('ff')}/unlink`),
      200,
    );
    expect(unlinked).toMatchObject({ linkedHere: false, state: 'not_imported' });
    const again = await json<SupplierCategoryNode>(
      await post(`/api/admin/suppliers/fake/categories/${node('ff')}/unlink`),
      200,
    );
    expect(again.linkedHere).toBe(false);
  });

  it('ignores and unignores categories and offers (rule SC6)', async () => {
    const ignored = await json<SupplierCategoryNode>(
      await post(`/api/admin/suppliers/fake/categories/${node('bare')}/ignore`),
      200,
    );
    expect(ignored.state).toBe('ignored');
    expect(
      (
        await json<SupplierCategoryNode>(
          await post(`/api/admin/suppliers/fake/categories/${node('bare')}/unignore`),
          200,
        )
      ).state,
    ).toBe('not_imported');
    const mapped = await json<{ code: string }>(
      await post(`/api/admin/suppliers/offers/${offers.uc60}/ignore`),
      409,
    );
    expect(mapped.code).toBe('OFFER_ALREADY_MAPPED');
    const offer = await json<{ ignoredAt: string | null }>(
      await post(`/api/admin/suppliers/offers/${offers.uc325}/ignore`),
      200,
    );
    expect(offer.ignoredAt).not.toBeNull();
    // An ignored offer no longer counts as new, and cannot be routed or imported.
    expect((await nodeOf('pubg')).counts.newPacks).toBe(0);
    const route = await json<{ code: string }>(
      await post(`/api/admin/catalog/products/${imported.products[0]?.id}/routes`, {
        offerId: offers.uc325,
      }),
      409,
    );
    expect(route.code).toBe('OFFER_IGNORED');
    const unignored = await json<{ ignoredAt: string | null }>(
      await post(`/api/admin/suppliers/offers/${offers.uc325}/unignore`),
      200,
    );
    expect(unignored.ignoredAt).toBeNull();
    expect((await post(`/api/admin/suppliers/offers/${newId()}/ignore`)).status).toBe(404);
  });

  it('refuses restoring a route whose offer was ignored meanwhile (SC6, A05-71)', async () => {
    await json(await post(`/api/admin/routes/${ids.route}/archive`), 200);
    await json(await post(`/api/admin/suppliers/offers/${offers.uc60}/ignore`), 200);
    expect(
      await json<{ code: string }>(await post(`/api/admin/routes/${ids.route}/restore`), 409),
    ).toMatchObject({ code: 'OFFER_IGNORED' });
    await json(await post(`/api/admin/suppliers/offers/${offers.uc60}/unignore`), 200);
    await json(await post(`/api/admin/routes/${ids.route}/restore`), 200);
  });

  it('links with existing packs only, or with none (rule SC8)', async () => {
    const product = await json<{ id: string }>(
      await post(`/api/admin/catalog/games/${ids.game}/products`, {
        kind: 'direct',
        nameAr: `باقة قائمة ${run}`,
      }),
      201,
    );
    const linked = await json<CategoryImportResult>(
      await post(`/api/admin/suppliers/fake/categories/${node('global')}/link`, {
        gameId: ids.game,
        fieldMap: { player_id: 'player_id' },
        rows: [{ offerId: offers.uc325, productId: product.id }],
      }),
      201,
    );
    expect(linked.products).toEqual([expect.objectContaining({ id: product.id, existing: true })]);
    const empty = await json<CategoryImportResult>(
      await post(`/api/admin/suppliers/fake/categories/${node('mena')}/link`, {
        gameId: ids.game,
        rows: [],
      }),
      201,
    );
    expect(empty).toEqual({ gameId: ids.game, products: [] });
    expect((await nodeOf('mena')).linkedHere).toBe(true);
  });

  it('refuses an import above a node linked to a game (CATEGORY_LINKED, descendants)', async () => {
    await category('outer', { image: null });
    await category('inner', { parent: 'outer', image: null });
    await offer('outer1', 'outer');
    await json(
      await post(`/api/admin/suppliers/fake/categories/${node('inner')}/link`, {
        gameId: ids.game,
        rows: [],
      }),
      201,
    );
    const refused = await json<{ code: string; details: { gameId: string } }>(
      await post(`/api/admin/suppliers/fake/categories/${node('outer')}/import`, {
        game: { slug: `outer-${run}`, categoryId: ids.storeCategory, nameAr: 'خ', nameEn: 'Outer' },
        cover: { supplierImage: true },
        fields: [],
        rows: [{ offerId: offers.outer1, nameAr: 'x' }],
      }),
      409,
    );
    expect(refused).toMatchObject({ code: 'CATEGORY_LINKED', details: { gameId: ids.game } });
  });

  it('lets one of two imports of overlapping nodes through (the tree lock)', async () => {
    await category('race');
    await category('race-leaf', { parent: 'race' });
    await offer('race1', 'race');
    await offer('race2', 'race-leaf');
    const attempt = (name: string, offerKey: string) =>
      post(`/api/admin/suppliers/fake/categories/${node(name)}/import`, {
        game: {
          slug: `${name}-${run}`,
          categoryId: ids.storeCategory,
          nameAr: `سباق ${name} ${run}`,
          nameEn: `Race ${name}`,
        },
        cover: { supplierImage: true },
        fields: [
          {
            key: 'player_id',
            labelAr: 'المعرف',
            type: 'digits',
            required: true,
            minLength: 1,
            maxLength: 32,
          },
        ],
        fieldMap: { player_id: 'player_id' },
        rows: [{ offerId: offers[offerKey], nameAr: `${offerKey} ${run}` }],
      });
    const answers = await Promise.all([attempt('race', 'race1'), attempt('race-leaf', 'race2')]);
    const statuses = answers.map((answer) => answer.status).sort();
    expect(statuses).toEqual([201, 409]);
    const refused = (await answers.find((answer) => answer.status === 409)?.json()) as {
      code: string;
    };
    expect(refused.code).toBe('CATEGORY_LINKED');
  });

  it('refuses routing an unsupported offer (rule SC3)', async () => {
    const refused = await json<{ code: string }>(
      await post(`/api/admin/catalog/products/${imported.products[0]?.id}/routes`, {
        offerId: offers.two,
        fieldMap: { user_id: 'player_id', server_id: 'player_id' },
      }),
      409,
    );
    expect(refused.code).toBe('OFFER_UNSUPPORTED');
  });

  it('activates the game and the packs that can serve, listing the others (rule SC10)', async () => {
    const result = await json<{
      gameActivated: boolean;
      activated: { productId: string }[];
      skipped: { productId: string; reason: string }[];
    }>(await post(`/api/admin/catalog/games/${ids.game}/activate-all`), 200);
    expect(result.gameActivated).toBe(true);
    expect(result.activated.map((row) => row.productId)).toEqual(
      expect.arrayContaining(imported.products.map((product) => product.id)),
    );
    const bare = await json<{ id: string }>(
      await post(`/api/admin/catalog/games/${ids.game}/products`, {
        kind: 'direct',
        nameAr: `بلا مسار ${run}`,
      }),
      201,
    );
    await json(
      await client.patch(`/api/admin/catalog/products/${bare.id}`, {
        cookie: admin.cookie,
        body: { status: 'paused' },
      }),
      200,
    );
    const again = await json<typeof result>(
      await post(`/api/admin/catalog/games/${ids.game}/activate-all`),
      200,
    );
    expect(again.gameActivated).toBe(false);
    expect(again.skipped).toEqual([
      expect.objectContaining({ productId: bare.id, reason: 'no_route' }),
    ]);
    const audit = await auditOf(test.db, ids.game);
    expect(audit.map((entry) => entry.action)).toContain('catalog_game.activated_all');
  });

  it('replaces the cover with the linked category image (rule IM3)', async () => {
    const before = await json<{ cover: { id: string } }>(
      await get(`/api/admin/catalog/games/${ids.game}`),
      200,
    );
    const after = await json<{ cover: { id: string } }>(
      await post(`/api/admin/catalog/games/${ids.game}/cover/from-supplier`, {
        supplier: 'fake',
        categoryId: node('pubg'),
      }),
      200,
    );
    expect(after.cover.id).not.toBe(before.cover.id);
    const unlinked = await post(`/api/admin/catalog/games/${ids.game}/cover/from-supplier`, {
      supplier: 'fake',
      categoryId: node('ff'),
    });
    expect(unlinked.status).toBe(404);
  });
});

describe('two fields and select fields (rules MF1–MF3)', () => {
  const region = (values: [string, string][]): FieldSpec => ({
    key: 'region',
    label: 'Region',
    type: 'select',
    options: values.map(([label, value]) => ({ label, value })),
  });
  const ALL: [string, string][] = [
    ['America', 'os_usa'],
    ['Europe', 'os_euro'],
    ['Asia', 'os_asia'],
  ];
  const player = { key: 'playerId', label: 'Player ID', type: 'text' as const };
  let selectGame = '';

  beforeAll(async () => {
    await category('ml');
    await category('gi');
    await category('gi2');
    await offer('ml86', 'ml', {
      cost: 1.4,
      fields: [player, { key: 'zoneId', label: 'Zone ID', type: 'text' }],
    });
    // The draft follows the first pack (the cheapest, gi60): gi330's list lacks Asia.
    await offer('gi60', 'gi', { cost: 0.85, fields: [player, region(ALL)] });
    await offer('gi330', 'gi', { cost: 4.2, fields: [player, region(ALL.slice(0, 2))] });
    await offer('gi2-60', 'gi2', { cost: 0.86, fields: [player, region(ALL)] });
  });

  const importBody = (fields: unknown[], rows: unknown[], extra: Record<string, unknown> = {}) => ({
    game: {
      slug: `gi-${run}`,
      categoryId: ids.storeCategory,
      nameAr: `جنشن ${run}`,
      nameEn: `Genshin ${run}`,
    },
    cover: { supplierImage: true },
    fields,
    rows,
    ...extra,
  });

  it('drafts two fields, and a select with the first pack’s options and its option map', async () => {
    const ml = await json<ImportDraft>(
      await get(`/api/admin/suppliers/fake/categories/${node('ml')}/import-draft`),
      200,
    );
    expect(ml.fields.map((field) => [field.key, field.type])).toEqual([
      ['playerid', 'text'],
      ['zoneid', 'text'],
    ]);
    expect(ml.packs[0]?.refusal).toBeNull();
    const gi = await json<ImportDraft>(
      await get(`/api/admin/suppliers/fake/categories/${node('gi')}/import-draft`),
      200,
    );
    expect(gi.fields[1]).toMatchObject({
      supplierKey: 'region',
      supplierType: 'select',
      supplierOptions: region(ALL).options,
      key: 'region',
      labelAr: 'المنطقة',
      type: 'select',
      options: [
        { value: 'os_usa', labelAr: 'America' },
        { value: 'os_euro', labelAr: 'Europe' },
        { value: 'os_asia', labelAr: 'Asia' },
      ],
    });
    expect(gi.optionMap).toEqual({
      region: { os_usa: 'os_usa', os_euro: 'os_euro', os_asia: 'os_asia' },
    });
    const refusals = Object.fromEntries(
      gi.packs.map((pack) => [pack.supplierOfferId, pack.refusal]),
    );
    expect(refusals).toEqual({
      [`gi60-${run}`]: null,
      // Its list lacks Asia, one of the suggested options.
      [`gi330-${run}`]: 'FIELD_OPTIONS_DIFFER',
    });
    expect(gi.packs.find((pack) => pack.refusal)?.fieldSpecs?.[1]?.options).toHaveLength(2);
  });

  it('refuses a pack whose options lack one of ours, then imports without that option', async () => {
    const fields = [
      { key: 'player_id', labelAr: 'المعرف', type: 'digits', required: true },
      {
        key: 'region',
        labelAr: 'المنطقة',
        type: 'select',
        required: true,
        options: [
          { value: 'us', labelAr: 'أمريكا' },
          { value: 'eu', labelAr: 'أوروبا' },
          { value: 'asia', labelAr: 'آسيا' },
        ],
      },
    ];
    const fieldMap = { playerId: 'player_id', region: 'region' };
    const optionMap = { region: { us: 'os_usa', eu: 'os_euro', asia: 'os_asia' } };
    const rows = [
      { offerId: offers.gi60, nameAr: `GI 60 ${run}` },
      { offerId: offers.gi330, nameAr: `GI 330 ${run}` },
    ];
    const refused = await json<{ code: string; details: { rows: unknown[] } }>(
      await post(
        `/api/admin/suppliers/fake/categories/${node('gi')}/import`,
        importBody(fields, rows, { fieldMap, optionMap }),
      ),
      409,
    );
    expect(refused).toMatchObject({
      code: 'FIELD_OPTIONS_DIFFER',
      details: { rows: [{ index: 1, code: 'FIELD_OPTIONS_DIFFER', fields: ['region'] }] },
    });
    // No option map: every row is refused.
    expect(
      (
        await json<{ details: { rows: unknown[] } }>(
          await post(
            `/api/admin/suppliers/fake/categories/${node('gi')}/import`,
            importBody(fields, rows.slice(0, 1), { fieldMap }),
          ),
          409,
        )
      ).details.rows,
    ).toEqual([{ index: 0, code: 'FIELD_OPTIONS_DIFFER', fields: ['region'] }]);
    const [, select] = fields as [unknown, { options: unknown[] }];
    select.options = select.options.slice(0, 2);
    const done = await json<CategoryImportResult>(
      await post(
        `/api/admin/suppliers/fake/categories/${node('gi')}/import`,
        importBody(fields, rows, { fieldMap, optionMap }),
      ),
      201,
    );
    selectGame = done.gameId;
    const routing = await json<ProductRouting>(
      await get(`/api/admin/catalog/products/${done.products[1]?.id}/routes`),
      200,
    );
    expect(routing.routes[0]).toMatchObject({
      fieldMap,
      // Kept whole: an option the game no longer has is never sent.
      optionMap,
      unusableReason: null,
    });
    expect(routing.routes[0]?.offer.fieldSpecs?.[1]?.key).toBe('region');
    const audit = await auditOf(test.db, routing.routes[0]?.id as string);
    expect(audit[0]?.details).toMatchObject({ fieldMap, optionMap });
  });

  it('links onto a game’s select by value or label, refusing an option the supplier lacks', async () => {
    const draft = await json<ImportDraft>(
      await get(
        `/api/admin/suppliers/fake/categories/${node('gi2')}/import-draft?gameId=${selectGame}`,
      ),
      200,
    );
    expect(draft.linkGame?.fields[1]).toMatchObject({ key: 'region', type: 'select' });
    expect(draft.fieldMap).toEqual({ playerId: 'player_id', region: 'region' });
    // Proposed by label: أمريكا and أوروبا are no supplier label or value.
    expect(draft.optionMap).toEqual({ region: {} });
    const body = (optionMap: Record<string, Record<string, string>>) => ({
      gameId: selectGame,
      fieldMap: { playerId: 'player_id', region: 'region' },
      optionMap,
      rows: [{ offerId: offers['gi2-60'], nameAr: `GI2 60 ${run}` }],
    });
    const refused = await json<{ code: string; details: { rows: unknown[] } }>(
      await post(
        `/api/admin/suppliers/fake/categories/${node('gi2')}/link`,
        body({ region: { us: 'os_usa', eu: 'Mars' } }),
      ),
      409,
    );
    expect(refused.details.rows).toEqual([
      { index: 0, code: 'FIELD_OPTIONS_DIFFER', fields: ['region'] },
    ]);
    const linked = await json<CategoryImportResult>(
      await post(
        `/api/admin/suppliers/fake/categories/${node('gi2')}/link`,
        body({ region: { us: 'os_usa', eu: 'os_euro' } }),
      ),
      201,
    );
    expect(linked.products).toHaveLength(1);
  });

  it('creates and updates a route with its option map (RT3 extended)', async () => {
    const product = await json<{ id: string }>(
      await post(`/api/admin/catalog/games/${selectGame}/products`, {
        kind: 'direct',
        nameAr: `مسار ${run}`,
      }),
      201,
    );
    const another = await offer('gi-route', 'gi', { cost: 0.9, fields: [player, region(ALL)] });
    const route = {
      offerId: another,
      fieldMap: { playerId: 'player_id', region: 'region' },
    };
    const refused = await json<{ code: string; details: unknown }>(
      await post(`/api/admin/catalog/products/${product.id}/routes`, {
        ...route,
        optionMap: { region: { us: 'os_usa' } },
      }),
      409,
    );
    expect(refused).toEqual(
      expect.objectContaining({ code: 'FIELD_OPTIONS_DIFFER', details: { fields: ['region'] } }),
    );
    const created = await json<ProductRouting>(
      await post(`/api/admin/catalog/products/${product.id}/routes`, {
        ...route,
        optionMap: { region: { us: 'os_usa', eu: 'os_euro' } },
      }),
      201,
    );
    const routeId = created.routes.find((item) => item.offer.id === another)?.id as string;
    const patch = (optionMap: unknown) =>
      client.request('PATCH', `/api/admin/routes/${routeId}`, {
        cookie: admin.cookie,
        body: { optionMap },
      });
    expect(
      (await json<{ code: string }>(await patch({ region: { us: 'os_asia' } }), 409)).code,
    ).toBe('FIELD_OPTIONS_DIFFER');
    const updated = await json<ProductRouting>(
      await patch({ region: { us: 'os_asia', eu: 'os_euro' } }),
      200,
    );
    expect(updated.routes.find((item) => item.id === routeId)?.optionMap).toEqual({
      region: { us: 'os_asia', eu: 'os_euro' },
    });
    const audit = await auditOf(test.db, routeId);
    expect(audit.map((entry) => entry.action)).toEqual([
      'product_route.created',
      'product_route.updated',
    ]);
    expect(audit[1]?.details).toEqual({
      productId: product.id,
      before: { optionMap: { region: { us: 'os_usa', eu: 'os_euro' } } },
      after: { optionMap: { region: { us: 'os_asia', eu: 'os_euro' } } },
    });
  });

  it('a new select option the route cannot map moves the price off it at once (audit A2)', async () => {
    await reauthenticate();
    const product = await json<{ id: string }>(
      await post(`/api/admin/catalog/games/${selectGame}/products`, {
        kind: 'direct',
        nameAr: `خيارات ${run}`,
      }),
      201,
    );
    const mapped = await offer('gi-options', 'gi', { cost: 0.9, fields: [player, region(ALL)] });
    const created = await json<ProductRouting>(
      await post(`/api/admin/catalog/products/${product.id}/routes`, {
        offerId: mapped,
        fieldMap: { playerId: 'player_id', region: 'region' },
        optionMap: { region: { us: 'os_usa', eu: 'os_euro' } },
      }),
      201,
    );
    const routeId = created.routes.find((item) => item.offer.id === mapped)?.id as string;
    const manual = await json<ProductRouting>(
      await post(`/api/admin/catalog/products/${product.id}/routes/manual`, { costUsdUnits: 5e6 }),
      201,
    );
    expect(manual.currentPrice?.routeId).toBe(routeId);
    const game = await json<{
      fields: { id: string; key: string; options: { value: string; labelAr: string }[] | null }[];
    }>(await get(`/api/admin/catalog/games/${selectGame}`), 200);
    const field = game.fields.find((item) => item.key === 'region');
    const options = field?.options ?? [];
    const editOptions = (next: unknown) =>
      client.request('PATCH', `/api/admin/catalog/fields/${field?.id}`, {
        cookie: admin.cookie,
        body: { options: next },
      });
    try {
      await json(
        await editOptions([...options, { value: `new-${run}`, labelAr: 'منطقة جديدة' }]),
        200,
      );
      const after = await json<ProductRouting>(
        await get(`/api/admin/catalog/products/${product.id}/routes`),
        200,
      );
      expect(after.routes.find((item) => item.id === routeId)?.unusableReason).not.toBeNull();
      expect(after.basisRouteId).not.toBe(routeId);
      expect(after.currentPrice?.routeId).toBe(after.basisRouteId);
    } finally {
      await json(await editOptions(options), 200);
    }
  });
});

describe('the game page reads (rules SC9, IM3, SF2)', () => {
  it('lists the categories linked to the game itself', async () => {
    const linked = await json<SupplierCategoryNode[]>(
      await get(`/api/admin/catalog/games/${ids.game}/supplier-categories`),
      200,
    );
    // Earlier tests linked more nodes to this game; every one is linked here, by name.
    expect(linked.map((item) => item.categoryId)).toContain(node('pubg'));
    expect(linked.every((item) => item.linkedHere && item.game?.id === ids.game)).toBe(true);
    const unknown = await get(
      '/api/admin/catalog/games/0199a000-0000-7000-8000-000000000001/supplier-categories',
    );
    expect(unknown.status).toBe(404);
  });

  it('shows the basis offer stock level on packs and routes', async () => {
    const level = async () => {
      const game = await json<{ products: { id: string; basisStockLevel: string | null }[] }>(
        await get(`/api/admin/catalog/games/${ids.game}`),
        200,
      );
      const routing = await json<{
        routes: { id: string; offer: { stock: number | null; stockLevel: string } }[];
      }>(await get(`/api/admin/catalog/products/${ids.product}/routes`), 200);
      return {
        product: game.products.find((item) => item.id === ids.product)?.basisStockLevel,
        route: routing.routes.find((route) => route.id === ids.route)?.offer,
      };
    };
    expect(await level()).toMatchObject({ product: 'ok', route: { stock: 50, stockLevel: 'ok' } });
    await test.db
      .update(supplierOffers)
      .set({ stock: 5 })
      .where(eq(supplierOffers.id, offers.uc60 as string));
    expect(await level()).toMatchObject({ product: 'low', route: { stock: 5, stockLevel: 'low' } });
    await test.db
      .update(supplierOffers)
      .set({ stock: 50 })
      .where(eq(supplierOffers.id, offers.uc60 as string));
  });
});

describe('offers and supplier cards (rules SF1, SF2, SC11)', () => {
  it('shows the new offer fields and filters by subtree, support, ignore and low stock', async () => {
    const page = await json<SupplierOfferPage>(
      await get(`/api/admin/suppliers/fake/offers?categoryId=${node('pubg')}&pageSize=100`),
      200,
    );
    expect(page.items.map((item) => item.offerId).sort()).toEqual(
      [`two-${run}`, `uc325-${run}`, `uc60-${run}`, `uc660-${run}`].sort(),
    );
    const uc60 = page.items.find((item) => item.offerId === `uc60-${run}`);
    expect(uc60).toMatchObject({
      categoryId: node('global'),
      categoryPath: [`pubg ${run}`, `global ${run}`],
      stock: 50,
      stockLevel: 'ok',
      originalCostUsdUnits: usd(1.1),
      discountPercent: 20,
      fieldSpecs: [{ key: 'player_id', label: 'Player ID', type: 'text' }],
      unsupportedReason: null,
      ignoredAt: null,
    });
    const unsupported = await json<SupplierOfferPage>(
      await get(`/api/admin/suppliers/fake/offers?categoryId=${node('pubg')}&supported=false`),
      200,
    );
    expect(unsupported.items.map((item) => item.offerId)).toEqual([`two-${run}`]);
    const low = await json<SupplierOfferPage>(
      await get(`/api/admin/suppliers/fake/offers?categoryId=${node('pubg')}&lowStock=true`),
      200,
    );
    // UC 660 has 4 left and its product is active since "activate all".
    expect(low.items.map((item) => item.offerId)).toEqual([`uc660-${run}`]);
    const ignored = await json<SupplierOfferPage>(
      await get(`/api/admin/suppliers/fake/offers?categoryId=${node('pubg')}&ignored=true`),
      200,
    );
    expect(ignored.items).toEqual([]);
    // No low offer under Free Fire: `lowStock=false` keeps every row, `true` none.
    const ffAll = await json<SupplierOfferPage>(
      await get(`/api/admin/suppliers/fake/offers?categoryId=${node('ff')}&lowStock=false`),
      200,
    );
    expect(ffAll.items).toHaveLength(2);
    const ffLow = await json<SupplierOfferPage>(
      await get(`/api/admin/suppliers/fake/offers?categoryId=${node('ff')}&lowStock=true`),
      200,
    );
    expect(ffLow.items).toEqual([]);
  });

  it('adds capabilities, new packs, low stock and the cached status to the cards', async () => {
    // A pack the supplier added under the imported tree counts as new (rule SC11).
    await offer('fresh', 'global');
    const cards = await json<SupplierSummary[]>(await get('/api/admin/suppliers'), 200);
    const fake = cards.find((card) => card.code === 'fake') as SupplierSummary;
    expect(fake.capabilities).toEqual({
      categories: true,
      statement: true,
      platformStatus: true,
      account: false,
    });
    expect(fake.newOfferCount).toBeGreaterThanOrEqual(1);
    expect(fake.lowStockCount).toBeGreaterThanOrEqual(1);
    expect(fake.platformStatus).toBeNull();
    const status = await json<{ status: string }>(
      await get('/api/admin/suppliers/fake/platform-status'),
      200,
    );
    expect(status.status).toBe('operational');
    const after = await json<SupplierSummary[]>(await get('/api/admin/suppliers'), 200);
    expect(after.find((card) => card.code === 'fake')?.platformStatus?.status).toBe('operational');
    expect(recorded.map((call) => call.operation)).toContain('platform_status');
  });
});

describe('the statement (rules SF3, SF4)', () => {
  it('reads orders and transactions live, page by page, one read per 5 seconds', async () => {
    const fake = new FakeSupplierAdapter({
      webhookSecret: 'x',
      state: fakeSupplierStateSchema.parse({}),
    });
    await fake.placeOrder({
      idempotencyKey: newId(),
      offerId: 'fake-uc-60',
      quantity: 1,
      fields: { playerId: '5000' },
    });
    const connect = vi.spyOn(SupplierAdaptersService.prototype, 'connect').mockResolvedValue(fake);
    try {
      const orders = await json<{ items: { match: unknown; offerId: string }[]; hasMore: boolean }>(
        await get('/api/admin/suppliers/fake/statement/orders?page=1'),
        200,
      );
      expect(orders.hasMore).toBe(false);
      // The fake bought it for nobody here: not matched to an order of ours.
      expect(orders.items).toEqual([
        expect.objectContaining({ offerId: 'fake-uc-60', match: null }),
      ]);
      const limited = await json<{ code: string }>(
        await get('/api/admin/suppliers/fake/statement/orders?page=1'),
        429,
      );
      expect(limited.code).toBe('RATE_LIMITED');
      const transactions = await json<{ items: { type: string; amountUsdUnits: number }[] }>(
        await get('/api/admin/suppliers/fake/statement/transactions'),
        200,
      );
      expect(transactions.items).toEqual([
        expect.objectContaining({ type: 'purchase', amountUsdUnits: -880_000, match: null }),
      ]);
      const unknown = await get(`/api/admin/orders/${newId()}/attempts/${newId()}/supplier-orders`);
      expect(unknown.status).toBe(404);
    } finally {
      connect.mockRestore();
    }
  });
});

describe('statement rows and nearby orders matched to an attempt (rules SF3, SF4, RS3)', () => {
  it('links a supplier order to our attempt, and lists it beside the attempt', async () => {
    const fake = new FakeSupplierAdapter({
      webhookSecret: 'x',
      state: fakeSupplierStateSchema.parse({}),
    });
    const placed = await fake.placeOrder({
      idempotencyKey: newId(),
      offerId: 'fake-uc-60',
      quantity: 1,
      fields: { playerId: '5000' },
    });
    const supplierOrderId = (placed as { supplierOrderId: string }).supplierOrderId;
    // A walk-in order of the imported pack, sent to the fake as `orders.fulfil` would. The owner
    // cap is shared by every test file of the day: raised for it, then put back.
    await reauthenticate();
    const policy = await json<Record<string, unknown>>(await get('/api/admin/orders/policy'), 200);
    await json(
      await client.put('/api/admin/orders/policy', {
        cookie: admin.cookie,
        body: { ...policy, ownerDailyCapUsdUnits: usd(10_000) },
      }),
      200,
    );
    const placing = client.post('/api/admin/orders', {
      cookie: admin.cookie,
      headers: { 'idempotency-key': newId() },
      body: {
        purpose: 'walk_in',
        productId: ids.product,
        quantity: 1,
        fields: { player_id: '5123456789' },
        expectedUnitPriceUsdUnits: ids.price,
        reason: 'Statement match test',
        confirmPlayer: true,
      },
    });
    const order = await json<{ id: string }>(await placing, 201);
    await json(
      await client.put('/api/admin/orders/policy', { cookie: admin.cookie, body: policy }),
      200,
    );
    const attemptId = newId();
    await test.db.transaction(async (tx) => {
      const locked = (await lockOrder(tx, order.id)) as NonNullable<
        Awaited<ReturnType<typeof lockOrder>>
      >;
      await tx.insert(fulfilmentAttempts).values({
        id: attemptId,
        orderId: order.id,
        routeId: ids.route,
        supplierId: ids.fake,
        offerId: offers.uc60 as string,
        supplierOfferId: 'fake-uc-60',
        quantity: 1,
        unitCostUsdUnits: usd(0.88),
        status: 'pending',
        supplierOrderId,
        candidates: [],
        sentAt: new Date(),
      });
      await transitionOrder(tx, locked, 'sent_to_supplier', { actor: 'system', attemptId });
    });
    const connect = vi.spyOn(SupplierAdaptersService.prototype, 'connect').mockResolvedValue(fake);
    try {
      // The statement test above read the orders list less than 5 seconds ago.
      await new Promise((resolve) => setTimeout(resolve, 5_100));
      const orders = await json<{ items: { supplierOrderId: string; match: unknown }[] }>(
        await get('/api/admin/suppliers/fake/statement/orders'),
        200,
      );
      const match = {
        orderId: order.id,
        orderStatus: 'sent_to_supplier',
        attemptId,
        attemptStatus: 'pending',
      };
      expect(orders.items).toEqual([
        expect.objectContaining({ supplierOrderId, match: expect.objectContaining(match) }),
      ]);
      const nearby = await json<{ items: { match: unknown }[]; complete: boolean }>(
        await get(`/api/admin/orders/${order.id}/attempts/${attemptId}/supplier-orders`),
        200,
      );
      expect(nearby.complete).toBe(true);
      expect(nearby.items).toEqual([
        expect.objectContaining({ supplierOrderId, match: expect.objectContaining(match) }),
      ]);
      expect(
        (await get(`/api/admin/orders/${order.id}/attempts/${attemptId}/supplier-orders`)).status,
      ).toBe(429);
    } finally {
      connect.mockRestore();
    }
    // Rows without a time stay listed, and the answer says the read is not conclusive.
    const timeless = {
      ...fake,
      capabilities: fake.capabilities,
      listOrders: async () => ({
        items: [{ supplierOrderId: `timeless-${run}`, offerId: 'fake-uc-60', quantity: 1 }],
        hasMore: false,
      }),
    } as unknown as FakeSupplierAdapter;
    const live = test.app.get(SupplierLiveService);
    await new Promise((resolve) => setTimeout(resolve, 5_100));
    const spied = vi
      .spyOn(SupplierAdaptersService.prototype, 'connect')
      .mockResolvedValue(timeless);
    try {
      const facts = {
        attemptId: newId(),
        supplierId: ids.fake,
        supplierCode: 'fake' as const,
        supplierOfferId: 'fake-uc-60',
        quantity: 1,
        sentAt: new Date(),
      };
      expect(await live.nearby(facts)).toEqual({
        items: [expect.objectContaining({ supplierOrderId: `timeless-${run}`, match: null })],
        complete: false,
      });
    } finally {
      spied.mockRestore();
    }
  });
});

describe('the FazerCards webhook card (S19 FC8)', () => {
  const STORE_HOOK = 'https://store.example/api/webhooks/suppliers/fazercards';
  let server: FakeHttpServer;
  let fazercardsId = '';
  const settings = (url: string | null, failures = 0) => ({
    body: {
      ok: true,
      webhook: {
        url,
        enabled: url !== null,
        consecutive_failures: failures,
        last_success_at: null,
        last_failure_at: failures > 0 ? '2026-10-19T21:34:34.806Z' : null,
        last_failure_reason: failures > 0 ? 'http_404' : null,
      },
    },
  });
  const deliveries = {
    body: {
      ok: true,
      deliveries: [
        { id: 7, event: 'webhook.test', attempt: 1, status: 'delivered', response_status: 204 },
      ],
    },
  };

  beforeAll(async () => {
    server = await startFakeHttpServer();
    const [row] = await test.db.select().from(suppliers).where(eq(suppliers.code, 'fazercards'));
    fazercardsId = row?.id as string;
  });

  afterAll(() => server.close());

  const scripted = () =>
    vi.spyOn(SupplierAdaptersService.prototype, 'connect').mockResolvedValue(
      new FazercardsAdapter({
        apiKey: 'k',
        webhookSecret: 's',
        baseUrl: `${server.url}/api/v2/`,
        timeoutMs: 5_000,
      }),
    );

  it('reads the settings and deliveries live, only for a supplier with an account', async () => {
    const connect = scripted();
    try {
      server.reply(settings('https://old.example/hook', 1), deliveries);
      const read = await json<SupplierWebhookSettings>(
        await get('/api/admin/suppliers/fazercards/webhook'),
        200,
      );
      expect(read).toEqual({
        url: 'https://old.example/hook',
        enabled: true,
        // The test store is plain HTTP: it has no URL to give the supplier.
        expectedUrl: null,
        consecutiveFailures: 1,
        lastSuccessAt: null,
        lastFailureAt: '2026-10-19T21:34:34.806Z',
        lastFailureReason: 'http_404',
        deliveries: [
          {
            id: '7',
            event: 'webhook.test',
            attempt: 1,
            status: 'delivered',
            responseStatus: 204,
            durationMs: null,
            createdAt: null,
          },
        ],
      });
      expect(recorded.at(-1)).toMatchObject({ operation: 'account', result: 'ok' });
      expect(
        (await json<{ code: string }>(await get('/api/admin/suppliers/fazercards/webhook'), 429))
          .code,
      ).toBe('RATE_LIMITED');
      expect(
        (await json<{ code: string }>(await get('/api/admin/suppliers/fake/webhook'), 409)).code,
      ).toBe('CAPABILITY_UNSUPPORTED');
    } finally {
      connect.mockRestore();
    }
    expect((await client.get('/api/admin/suppliers/fazercards/webhook')).status).toBe(401);
    expect(
      (await client.get('/api/admin/suppliers/fazercards/webhook', { cookie: customerCookie }))
        .status,
    ).toBe(401);
  });

  it('refuses to set the URL without a public store address, or without re-authentication', async () => {
    const connect = scripted();
    try {
      expect(
        (
          await json<{ code: string }>(
            await client.put('/api/admin/suppliers/fazercards/webhook', { cookie: admin.cookie }),
            409,
          )
        ).code,
      ).toBe('STORE_URL_NOT_PUBLIC');
    } finally {
      connect.mockRestore();
    }
    const stale = await client.adminWithTotp(test.db);
    seeded.push(stale.id);
    admin = stale;
    expect(
      (
        await json<{ code: string }>(
          await client.put('/api/admin/suppliers/fazercards/webhook', { cookie: admin.cookie }),
          403,
        )
      ).code,
    ).toBe('REAUTHENTICATION_REQUIRED');
    await reauthenticate();
    expect(
      (await client.put('/api/admin/suppliers/fazercards/webhook', { cookie: customerCookie }))
        .status,
    ).toBe(401);
  });

  it('points the webhook at the store, sends the test event, and audits both', async () => {
    const connect = scripted();
    const url = vi
      .spyOn(SupplierLiveService.prototype as unknown as { webhookUrl: () => string }, 'webhookUrl')
      .mockReturnValue(STORE_HOOK);
    try {
      const before = server.requests.length;
      server.reply(settings(STORE_HOOK), { body: { ok: true } }, settings(STORE_HOOK), deliveries);
      const set = await json<SupplierWebhookSettings>(
        await client.put('/api/admin/suppliers/fazercards/webhook', { cookie: admin.cookie }),
        200,
      );
      expect(set).toMatchObject({ url: STORE_HOOK, enabled: true, expectedUrl: STORE_HOOK });
      const sent = server.requests.slice(before);
      expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual([
        'PUT /api/v2/account/webhook',
        'POST /api/v2/account/webhook/test',
        'GET /api/v2/account/webhook',
        'GET /api/v2/account/webhook/deliveries',
      ]);
      expect(JSON.parse(sent[0]?.body ?? '')).toEqual({ url: STORE_HOOK, enabled: true });
      expect((await auditOf(test.db, fazercardsId)).at(-1)).toMatchObject({
        action: 'supplier.webhook_set',
        details: { supplier: 'fazercards', url: STORE_HOOK, set: true, ok: true },
      });

      server.reply({ status: 500, body: { ok: false } });
      expect(await json(await post('/api/admin/suppliers/fazercards/webhook/test'), 200)).toEqual({
        ok: false,
      });
      expect((await auditOf(test.db, fazercardsId)).at(-1)).toMatchObject({
        action: 'supplier.webhook_tested',
        details: { supplier: 'fazercards', ok: false },
      });
      expect(
        (
          await json<{ code: string }>(
            await post('/api/admin/suppliers/fazercards/webhook/test'),
            429,
          )
        ).code,
      ).toBe('RATE_LIMITED');
      // A failed set is audited before its refusal: it may have changed the supplier's settings.
      server.reply({ status: 502, body: 'bad gateway' });
      expect(
        (
          await json<{ code: string }>(
            await client.put('/api/admin/suppliers/fazercards/webhook', { cookie: admin.cookie }),
            409,
          )
        ).code,
      ).toBe('SUPPLIER_UNAVAILABLE');
      expect((await auditOf(test.db, fazercardsId)).at(-1)).toMatchObject({
        action: 'supplier.webhook_set',
        details: { supplier: 'fazercards', url: STORE_HOOK, set: false, ok: false },
      });
    } finally {
      url.mockRestore();
      connect.mockRestore();
    }
    expect((await client.post('/api/admin/suppliers/fazercards/webhook/test', {})).status).toBe(
      401,
    );
  });

  it('shows the plan on the supplier card once the worker read it (FC9)', async () => {
    await test.db
      .update(suppliers)
      .set({
        accountPlan: 'trial',
        accountActive: true,
        accountPlanExpiresAt: new Date('2026-10-24T21:33:21.869Z'),
        accountCheckedAt: new Date('2026-10-20T09:00:00Z'),
      })
      .where(eq(suppliers.id, fazercardsId));
    try {
      const cards = await json<SupplierSummary[]>(await get('/api/admin/suppliers'), 200);
      expect(cards.find((card) => card.code === 'fazercards')).toMatchObject({
        available: true,
        capabilities: { categories: true, statement: true, platformStatus: false, account: true },
        subscription: {
          plan: 'trial',
          active: true,
          autoRenew: null,
          expiresAt: '2026-10-24T21:33:21.869Z',
          checkedAt: '2026-10-20T09:00:00.000Z',
        },
      });
      expect(cards.find((card) => card.code === 'fake')?.subscription).toBeNull();
    } finally {
      await test.db
        .update(suppliers)
        .set({
          accountPlan: null,
          accountActive: null,
          accountPlanExpiresAt: null,
          accountCheckedAt: null,
        })
        .where(eq(suppliers.id, fazercardsId));
    }
  });
});
