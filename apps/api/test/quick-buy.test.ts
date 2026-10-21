import { randomBytes, randomUUID } from 'node:crypto';
import { priceFromCost } from '@vertex-digital/contracts';
import {
  catalogCategories,
  ensureCustomerWallet,
  ensureSystemAccount,
  newId,
  postJournal,
  quickLinkEvents,
  supplierBalanceReads,
  supplierOffers,
  supplierSyncRuns,
  suppliers,
} from '@vertex-digital/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
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
 * S22 PR 1 over HTTP against the test database with the `fake` supplier: the quick-buy cards,
 * the saved IDs' quick-buy switch, direct buy links (targets, counted opens, attribution and the
 * panel's counts), the reservations beside the balance, and the best-value badge with its switch.
 * Categories are archived and the switches put back in `afterAll`; orders and ledger rows stay.
 */

let test: TestApp;
let client: ReturnType<typeof api>;
let admin: Awaited<ReturnType<ReturnType<typeof api>['adminWithTotp']>>;
const seeded: string[] = [];
const categories: string[] = [];
const run = randomBytes(4).toString('hex');
const usd = (dollars: number) => Math.round(dollars * 1_000_000);
const RULE = { percentBp: 1000, fixedUsdUnits: 0, minMarginUsdUnits: usd(0.1) };
const ids = { fake: '', gameId: '', gameSlug: '', categoryId: '' };
const PLAYER = { player_id: '51234568' };

interface Item {
  id: string;
  price: number;
  quickCode: string;
}

async function json<T = Record<string, unknown>>(response: Response, status: number): Promise<T> {
  const payload = await response.json();
  expect(response.status, JSON.stringify(payload)).toBe(status);
  return payload as T;
}

const adminPost = (path: string, payload?: unknown) =>
  client.post(path, { cookie: admin.cookie, body: payload });

async function product(gameId: string, cost: number, gameAmount: number | null = null) {
  await test.db.execute(sql`update catalog_games set status = 'paused' where id = ${gameId}`);
  const created = await json<{ id: string; quickCode: string }>(
    await adminPost(`/api/admin/catalog/games/${gameId}/products`, {
      kind: 'direct',
      nameAr: `باقة ${randomBytes(3).toString('hex')}`,
      gameAmount,
      maxQuantity: 5,
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
      costUsdUnits: usd(cost),
      inStock: true,
      costConfirmedAt: now,
      lastSeenAt: now,
    })
    .returning({ id: supplierOffers.id });
  await json(
    await adminPost(`/api/admin/catalog/products/${created.id}/routes`, {
      offerId: offer?.id,
      fieldMap: { playerId: 'player_id' },
    }),
    201,
  );
  await test.db.execute(sql`update catalog_games set status = 'active' where id = ${gameId}`);
  return { id: created.id, price: priceFromCost(usd(cost), RULE), quickCode: created.quickCode };
}

async function game(label: string) {
  const slug = `s22-${label}-${run}`;
  const { id } = await json<{ id: string }>(
    await adminPost('/api/admin/catalog/games', {
      categoryId: ids.categoryId,
      slug,
      nameAr: `لعبة ${slug}`,
      nameEn: 'Game',
    }),
    201,
  );
  await json(
    await adminPost(`/api/admin/catalog/games/${id}/fields`, {
      key: 'player_id',
      labelAr: 'معرّف اللاعب',
      type: 'digits',
      required: true,
      minLength: 5,
    }),
    201,
  );
  return { id, slug };
}

async function buyer(funds = usd(100)) {
  const customer = await seedCustomer(test.db);
  seeded.push(customer.id);
  if (funds > 0) {
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
  }
  return { ...customer, cookie: await client.signInCustomer(customer.email) };
}

type Buyer = Awaited<ReturnType<typeof buyer>>;

const purchase = (who: Buyer, item: Item, overrides: Record<string, unknown> = {}) =>
  client.post('/api/orders', {
    cookie: who.cookie,
    headers: { 'idempotency-key': randomUUID() },
    body: {
      productId: item.id,
      quantity: 1,
      fields: PLAYER,
      expectedUnitPriceUsdUnits: item.price,
      confirmPlayer: true,
      ...overrides,
    },
  });

const openLink = (code: string, address: string, campaign?: string) =>
  client.get(
    `/api/q/${code}${campaign === undefined ? '' : `?c=${encodeURIComponent(campaign)}`}`,
    {
      headers: { 'x-forwarded-for': address },
    },
  );

const linkEvents = (productId: string) =>
  test.db
    .select({ kind: quickLinkEvents.kind, campaign: quickLinkEvents.campaign })
    .from(quickLinkEvents)
    .where(eq(quickLinkEvents.productId, productId))
    .orderBy(quickLinkEvents.createdAt);

beforeAll(async () => {
  test = await startApp();
  client = api(test.url);
  admin = await client.adminWithTotp(test.db);
  seeded.push(admin.id);
  await setSwitches(test.db);
  const [fake] = await test.db.select().from(suppliers).where(eq(suppliers.code, 'fake'));
  ids.fake = fake?.id as string;
  await test.db
    .insert(supplierBalanceReads)
    .values({ supplierId: ids.fake, currency: 'USD', amountUnits: usd(1_000_000) });
  const reauth = await client.post('/api/admin/me/reauthenticate', {
    cookie: admin.cookie,
    body: { password: PASSWORD, totpCode: totp(admin.secret) },
  });
  expect(reauth.status).toBe(200);
  await json(
    await client.put('/api/admin/suppliers/fake/credentials', {
      cookie: admin.cookie,
      body: { values: { webhookSecret: `whsec-${run}-s22` } },
    }),
    200,
  );
  await test.db
    .update(supplierSyncRuns)
    .set({ status: 'failed', finishedAt: new Date(), errorCode: 'TEST' })
    .where(and(eq(supplierSyncRuns.supplierId, ids.fake), eq(supplierSyncRuns.status, 'running')));
  const category = await json<{ id: string }>(
    await adminPost('/api/admin/catalog/categories', { slug: `s22-${run}`, nameAr: `سريع ${run}` }),
    201,
  );
  ids.categoryId = category.id;
  categories.push(category.id);
  await json(
    await client.put('/api/admin/pricing/rules', {
      cookie: admin.cookie,
      body: { scope: 'category', targetId: category.id, ...RULE },
    }),
    200,
  );
  const main = await game('main');
  ids.gameId = main.id;
  ids.gameSlug = main.slug;
});

afterAll(async () => {
  await test.db
    .update(catalogCategories)
    .set({ archivedAt: new Date() })
    .where(inArray(catalogCategories.id, categories));
  await setSwitches(test.db);
  await removeAccounts(test.db, seeded);
  await test.app.close();
});

describe('top up again (S22 QB1–QB5)', () => {
  it('lists the saved IDs with their last pack at today’s price, hides and shows them', async () => {
    const [first, second] = [await product(ids.gameId, 0.88), await product(ids.gameId, 1.5)];
    const customer = await buyer();
    await json(await purchase(customer, first, { savePlayer: { label: 'أخي' } }), 201);
    await json(
      await purchase(customer, second, {
        savePlayer: { label: 'أنا' },
        fields: { player_id: '59999999' },
      }),
      201,
    );
    const cards = await json<{ items: Record<string, unknown>[] }>(
      await client.get('/api/quick-buy', { cookie: customer.cookie }),
      200,
    );
    expect(
      cards.items.map((card) => [
        (card.savedPlayer as { label: string }).label,
        (card.product as { id: string }).id,
        card.unitPriceUsdUnits,
        card.state,
        card.priceKind,
      ]),
    ).toEqual([
      ['أنا', second.id, second.price, 'ready', 'retail'],
      ['أخي', first.id, first.price, 'ready', 'retail'],
    ]);
    expect(cards.items[0]).toMatchObject({ quantity: 1, game: { slug: ids.gameSlug } });

    const savedId = (cards.items[0] as { savedPlayer: { id: string } }).savedPlayer.id;
    const hidden = await json<{ quickBuyHidden: boolean; label: string }>(
      await client.patch(`/api/saved-players/${savedId}`, {
        cookie: customer.cookie,
        body: { quickBuyHidden: true },
      }),
      200,
    );
    expect(hidden).toMatchObject({ quickBuyHidden: true, label: 'أنا' });
    const after = await json<{ items: { savedPlayer: { id: string } }[] }>(
      await client.get('/api/quick-buy', { cookie: customer.cookie }),
      200,
    );
    expect(after.items.map((card) => card.savedPlayer.id)).not.toContain(savedId);

    // Another customer's saved ID is not found; an empty change is refused.
    const other = await buyer(0);
    expect(
      (
        await client.patch(`/api/saved-players/${savedId}`, {
          cookie: other.cookie,
          body: { quickBuyHidden: false },
        })
      ).status,
    ).toBe(404);
    expect(
      (await client.patch(`/api/saved-players/${savedId}`, { cookie: customer.cookie, body: {} }))
        .status,
    ).toBe(400);
    expect(await json(await client.get('/api/quick-buy', { cookie: other.cookie }), 200)).toEqual({
      items: [],
    });
  });

  it('marks an unavailable pack, never offering its price', async () => {
    const item = await product(ids.gameId, 0.7);
    const customer = await buyer();
    await json(await purchase(customer, item, { savePlayer: { label: 'غائب' } }), 201);
    await test.db.execute(sql`update catalog_products set status = 'paused' where id = ${item.id}`);
    const cards = await json<{ items: Record<string, unknown>[] }>(
      await client.get('/api/quick-buy', { cookie: customer.cookie }),
      200,
    );
    expect(cards.items[0]).toMatchObject({ state: 'unavailable', unitPriceUsdUnits: null });
  });

  it('answers only a signed-in customer', async () => {
    expect((await client.get('/api/quick-buy')).status).toBe(401);
    expect([401, 403]).toContain(
      (await client.get('/api/quick-buy', { cookie: admin.cookie })).status,
    );
  });
});

describe('direct buy links (S22 DL1–DL5)', () => {
  it('resolves a code to its pack, its game or the home page', async () => {
    const item = await product(ids.gameId, 0.9);
    expect(item.quickCode).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
    const address = `10.22.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
    expect(await json(await openLink(item.quickCode.toLowerCase(), address), 200)).toEqual({
      target: 'pack',
      gameSlug: ids.gameSlug,
      productId: item.id,
    });
    expect((await openLink('ZZZZZ', address)).status).toBe(404);
    expect(await json<{ code: string }>(await openLink('ZZZZZ2', address), 404)).toMatchObject({
      code: 'QUICK_LINK_NOT_FOUND',
    });
    await test.db.execute(sql`update catalog_products set status = 'paused' where id = ${item.id}`);
    expect(await json(await openLink(item.quickCode, address), 200)).toEqual({
      target: 'game',
      gameSlug: ids.gameSlug,
    });
    const hiddenGame = await game('hidden');
    const hidden = await product(hiddenGame.id, 0.9);
    await test.db.execute(
      sql`update catalog_games set status = 'paused' where id = ${hiddenGame.id}`,
    );
    expect(await json(await openLink(hidden.quickCode, address), 200)).toEqual({ target: 'home' });
    await expect.poll(() => linkEvents(item.id)).toHaveLength(1);
    expect(await linkEvents(hidden.id)).toEqual([]);
  });

  it('refuses more than 60 reads a minute from one address', async () => {
    const item = await product(ids.gameId, 0.97);
    const address = `10.25.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
    const statuses: number[] = [];
    for (let index = 0; index < 61; index += 1) {
      statuses.push((await openLink(item.quickCode, address)).status);
    }
    expect(statuses.slice(0, 60).every((status) => status === 200)).toBe(true);
    expect(
      await json<{ code: string }>(await openLink(item.quickCode, address), 429),
    ).toMatchObject({
      code: 'RATE_LIMITED',
    });
    // One open counted however often the address reads the link.
    await expect.poll(() => linkEvents(item.id)).toHaveLength(1);
  });

  it('counts one open per address and hour, keeps a valid campaign only', async () => {
    const item = await product(ids.gameId, 0.95);
    const address = `10.23.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
    await json(await openLink(item.quickCode, address, 'whatsapp'), 200);
    await expect.poll(() => linkEvents(item.id)).toHaveLength(1);
    await json(await openLink(item.quickCode, address, 'whatsapp'), 200);
    await json(await openLink(item.quickCode, `${address}1`, '<script>'), 200);
    await expect.poll(() => linkEvents(item.id)).toHaveLength(2);
    expect(await linkEvents(item.id)).toEqual([
      { kind: 'open', campaign: 'whatsapp' },
      { kind: 'open', campaign: null },
    ]);
  });

  it('attributes an order of the link and shows the counts in the panel', async () => {
    const item = await product(ids.gameId, 1.1);
    const other = await product(ids.gameId, 1.2);
    const customer = await buyer();
    const from = new Date(Date.now() - 60_000).toISOString();
    await json(await openLink(item.quickCode, `10.24.0.${randomBytes(1)[0]}`, 'shop'), 200);
    await json(
      await purchase(customer, item, { quickLink: { code: item.quickCode, campaign: 'shop' } }),
      201,
    );
    // A code that is not the order's product's is ignored.
    await json(await purchase(customer, other, { quickLink: { code: item.quickCode } }), 201);
    expect((await purchase(customer, item, { quickLink: { code: 'bad' } })).status).toBe(400);
    await expect.poll(() => linkEvents(item.id)).toHaveLength(2);
    expect(await linkEvents(other.id)).toEqual([]);

    const to = new Date(Date.now() + 60_000).toISOString();
    const query = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&productId=${item.id}`;
    const stats = await json<{ items: Record<string, unknown>[] }>(
      await client.get(`/api/admin/quick-links?${query}`, { cookie: admin.cookie }),
      200,
    );
    expect(stats.items).toEqual([
      expect.objectContaining({
        productId: item.id,
        quickCode: item.quickCode,
        campaign: 'shop',
        opens: 1,
        orders: 1,
        revenueUsdUnits: item.price,
      }),
    ]);
    const tooLong = `from=2026-01-01T00:00:00.000Z&to=${encodeURIComponent(to)}`;
    expect(
      (await client.get(`/api/admin/quick-links?${tooLong}`, { cookie: admin.cookie })).status,
    ).toBe(400);
    expect((await client.get(`/api/admin/quick-links?${query}`)).status).toBe(401);
    expect([401, 403]).toContain(
      (await client.get(`/api/admin/quick-links?${query}`, { cookie: customer.cookie })).status,
    );
  });
});

describe('top up the gap (S22 BG1)', () => {
  it('shows the open reservations beside the balance', async () => {
    const item = await product(ids.gameId, 2);
    const customer = await buyer(usd(1));
    expect(
      await json(await client.get('/api/wallet', { cookie: customer.cookie }), 200),
    ).toMatchObject({ balanceUnits: usd(1), reservedUsdUnits: 0 });
    await json(await purchase(customer, item, { whenBalanceShort: 'reserve' }), 201);
    expect(
      await json(await client.get('/api/wallet', { cookie: customer.cookie }), 200),
    ).toMatchObject({ balanceUnits: usd(1), reservedUsdUnits: item.price });
  });
});

describe('best value (S22 BV1–BV3)', () => {
  it('prices per 100 and badges a 2% lead, until the game’s switch is off', async () => {
    const valueGame = await game('value');
    const small = await product(valueGame.id, 0.88, 60);
    const middle = await product(valueGame.id, 4, 325);
    const large = await product(valueGame.id, 7, 660);
    const page = async () =>
      (
        await json<{
          products: { id: string; perHundredUsdUnits: number | null; bestValue: boolean }[];
        }>(await client.get(`/api/catalog/games/${valueGame.slug}`), 200)
      ).products;
    const before = await page();
    expect(before.find((pack) => pack.id === large.id)).toMatchObject({ bestValue: true });
    expect(before.filter((pack) => pack.bestValue)).toHaveLength(1);
    expect(before.every((pack) => pack.perHundredUsdUnits !== null)).toBe(true);
    expect(before.find((pack) => pack.id === small.id)?.perHundredUsdUnits).toBeGreaterThan(
      before.find((pack) => pack.id === middle.id)?.perHundredUsdUnits as number,
    );

    const customer = await buyer(0);
    const prices = await json<{ products: { id: string; bestValue: boolean }[] }>(
      await client.get(`/api/catalog/games/${valueGame.slug}/prices`, { cookie: customer.cookie }),
      200,
    );
    expect(prices.products.find((pack) => pack.id === large.id)?.bestValue).toBe(true);

    // The test game has no cover: an active game cannot be saved without one (S06 CT3).
    await test.db.execute(
      sql`update catalog_games set status = 'paused' where id = ${valueGame.id}`,
    );
    const updated = await json<{ bestValueEnabled: boolean }>(
      await client.patch(`/api/admin/catalog/games/${valueGame.id}`, {
        cookie: admin.cookie,
        body: { bestValueEnabled: false },
      }),
      200,
    );
    expect(updated.bestValueEnabled).toBe(false);
    await test.db.execute(
      sql`update catalog_games set status = 'active' where id = ${valueGame.id}`,
    );
    expect(
      (await page()).every((pack) => pack.perHundredUsdUnits === null && !pack.bestValue),
    ).toBe(true);
    expect(await auditOf(test.db, valueGame.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'catalog_game.updated',
          details: { before: { bestValueEnabled: true }, after: { bestValueEnabled: false } },
        }),
      ]),
    );
  });
});
