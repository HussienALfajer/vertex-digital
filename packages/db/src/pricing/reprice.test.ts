import { priceFromCost } from '@vertex-digital/contracts';
import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../client.js';
import { newId } from '../id.js';
import { priceReviews, productPrices } from '../schema/index.js';
import { repriceProducts } from './reprice.js';
import { productRoutingStates } from './routing.js';

/*
 * The repricing write path (S07 rules P1–P6) against PostgreSQL. Each product gets its own
 * category, game and product margin rule (10%, $0, $0.10), so shared rules and other tests' rows
 * never move these prices. The `fake` supplier is configured once (credentials are append-only);
 * health, balances and switches are left as they are: no row here changes them.
 */

const connection = createDatabase(process.env.DATABASE_URL as string);
const { db, pool } = connection;
const context = () => ({ now: new Date(), fakeEnabled: true });
const rule = { percentBp: 1000, fixedUsdUnits: 0, minMarginUsdUnits: 100_000 };
const usd = (dollars: number) => Math.round(dollars * 1_000_000);
const unique = () => newId().replaceAll('-', '').slice(-12);

let suppliers: Record<'fake' | 'manual', string>;

beforeAll(async () => {
  const { rows } = await pool.query<{ id: string; code: 'fake' | 'manual' }>(
    `select id, code from suppliers where code in ('fake', 'manual')`,
  );
  suppliers = Object.fromEntries(rows.map((row) => [row.code, row.id])) as typeof suppliers;
  await pool.query(
    `insert into supplier_credentials (id, supplier_id, ciphertext, hints, admin_id)
     select $1, $2, '\\x00', '{}', $3
     where not exists (select 1 from supplier_credentials where supplier_id = $2)`,
    [newId(), suppliers.fake, newId()],
  );
});

const categories: string[] = [];

// Archived at the end: no product of these tests stays available to other tests (rule P9 reads
// the cheapest available product).
afterAll(async () => {
  await pool.query(
    'update catalog_categories set archived_at = now() where id = any($1::uuid[])',
    [categories],
  );
  await connection.close();
});

async function offer(supplier: 'fake' | 'manual', costUsdUnits: number | null) {
  const id = newId();
  await pool.query(
    `insert into supplier_offers (id, supplier_id, offer_id, name, in_stock, cost_usd_units,
       cost_confirmed_at, last_seen_at) values ($1, $2, $3, 'Offer', true, $4, now(), now())`,
    [id, suppliers[supplier], `o-${unique()}`, costUsdUnits],
  );
  return id;
}

async function route(productId: string, supplier: 'fake' | 'manual', offerId: string) {
  const id = newId();
  await pool.query(
    `insert into product_routes (id, product_id, supplier_id, offer_id, field_map)
     values ($1, $2, $3, $4, '{"playerId": "player_id"}')`,
    [id, productId, suppliers[supplier], offerId],
  );
  return id;
}

/** An active product in an active game with a `player_id` field and its own margin rule. */
async function product() {
  const [category, game, id] = [newId(), newId(), newId()];
  categories.push(category);
  await pool.query(
    'insert into catalog_categories (id, slug, name_ar, sort_order) values ($1, $2, $3, 99)',
    [category, `c-${unique()}`, `فئة ${unique()}`],
  );
  await pool.query(
    `insert into catalog_games (id, category_id, slug, name_ar, name_en, status, sort_order)
     values ($1, $2, $3, $4, 'Game', 'active', 1)`,
    [game, category, `g-${unique()}`, `لعبة ${unique()}`],
  );
  await pool.query(
    `insert into catalog_input_fields (id, game_id, key, label_ar, type, required, sort_order)
     values ($1, $2, 'player_id', 'المعرف', 'digits', true, 1)`,
    [newId(), game],
  );
  await pool.query(
    `insert into catalog_products (id, game_id, kind, name_ar, max_quantity, sort_order)
     values ($1, $2, 'direct', $3, 1, 1)`,
    [id, game, `باقة ${unique()}`],
  );
  await pool.query(
    `insert into margin_rules (id, scope, target_id, percent_bp, fixed_usd_units,
       min_margin_usd_units) values ($1, 'product', $2, $3, $4, $5)`,
    [newId(), id, rule.percentBp, rule.fixedUsdUnits, rule.minMarginUsdUnits],
  );
  return { id, game };
}

const setCost = (offerId: string, costUsdUnits: number | null) =>
  pool.query(
    'update supplier_offers set cost_usd_units = $2, cost_confirmed_at = now() where id = $1',
    [offerId, costUsdUnits],
  );

const reprice = (productIds: string[], cause: 'cost_sync' | 'route_change' | 'rule_change') =>
  db.transaction((tx) => repriceProducts(tx, { productIds, cause, context: context() }));

const prices = (productId: string) =>
  db
    .select()
    .from(productPrices)
    .where(eq(productPrices.productId, productId))
    .orderBy(desc(productPrices.createdAt));

const openReview = async (productId: string) =>
  (await db.select().from(priceReviews).where(eq(priceReviews.productId, productId))).find(
    (review) => review.status === 'open',
  );

const state = async (productId: string) =>
  (await productRoutingStates(db, [productId], context())).get(productId);

describe('repriceProducts (rule P2)', () => {
  it('prices a product from its first usable route, then follows small cost changes', async () => {
    const p = await product();
    const fakeOffer = await offer('fake', usd(0.88));
    const fakeRoute = await route(p.id, 'fake', fakeOffer);
    await route(p.id, 'manual', await offer('manual', usd(0.5)));

    // First price at once: the healthy automatic route, though the manual one is cheaper (RT5).
    expect(await reprice([p.id], 'route_change')).toEqual({ repriced: 1, reviewsOpened: 0 });
    const [first] = await prices(p.id);
    expect(first).toMatchObject({
      priceUsdUnits: priceFromCost(usd(0.88), rule),
      costUsdUnits: usd(0.88),
      routeId: fakeRoute,
      cause: 'route_change',
      ...rule,
    });
    expect((await state(p.id))?.availability).toBe('available');

    // Nothing changed: nothing written.
    expect(await reprice([p.id], 'cost_sync')).toEqual({ repriced: 0, reviewsOpened: 0 });

    // +4.5%: applied at once with its cause.
    await setCost(fakeOffer, usd(0.92));
    expect(await reprice([p.id], 'cost_sync')).toEqual({ repriced: 1, reviewsOpened: 0 });
    expect((await prices(p.id))[0]).toMatchObject({
      priceUsdUnits: priceFromCost(usd(0.92), rule),
      cause: 'cost_sync',
    });
  });

  it('holds a synced change above 10% for review, refreshes it, and guards the margin', async () => {
    const p = await product();
    const fakeOffer = await offer('fake', usd(0.92));
    await route(p.id, 'fake', fakeOffer);
    await reprice([p.id], 'route_change');
    const held = priceFromCost(usd(0.92), rule);

    await setCost(fakeOffer, usd(1.1));
    expect(await reprice([p.id], 'cost_sync')).toEqual({ repriced: 0, reviewsOpened: 1 });
    expect((await prices(p.id)).map((row) => row.priceUsdUnits)).toEqual([held]);
    expect(await openReview(p.id)).toMatchObject({
      costBeforeUsdUnits: usd(0.92),
      costAfterUsdUnits: usd(1.1),
      changeBp: 1956,
      priceBeforeUsdUnits: held,
      proposedPriceUsdUnits: priceFromCost(usd(1.1), rule),
    });
    // The held price leaves less than the minimum margin over the real cost (rule P6).
    expect((await state(p.id))?.availability).toBe('paused_by_margin_guard');

    // The cost moves again: the proposal follows, the price stays (edge case 3).
    await setCost(fakeOffer, usd(0.9));
    expect(await reprice([p.id], 'cost_sync')).toEqual({ repriced: 0, reviewsOpened: 0 });
    expect(await openReview(p.id)).toMatchObject({
      costAfterUsdUnits: usd(0.9),
      changeBp: -217,
      proposedPriceUsdUnits: priceFromCost(usd(0.9), rule),
    });
    expect((await prices(p.id)).length).toBe(1);
    expect((await state(p.id))?.availability).toBe('available');

    // A rule change refreshes the proposal instead of the price (rule P5).
    await pool.query(
      `update margin_rules set percent_bp = 2000 where scope = 'product' and target_id = $1`,
      [p.id],
    );
    expect(await reprice([p.id], 'rule_change')).toEqual({ repriced: 0, reviewsOpened: 0 });
    expect((await openReview(p.id))?.proposedPriceUsdUnits).toBe(
      priceFromCost(usd(0.9), { ...rule, percentBp: 2000 }),
    );
  });

  it('applies a change of basis route at once, and keeps the last price with no route', async () => {
    const p = await product();
    const fakeOffer = await offer('fake', usd(1));
    const fakeRoute = await route(p.id, 'fake', fakeOffer);
    const manualRoute = await route(p.id, 'manual', await offer('manual', usd(2)));
    await reprice([p.id], 'route_change');

    // The fake offer disappears in a sync: the manual route becomes the basis, +100% at once.
    await pool.query('update supplier_offers set missing_since = now() where id = $1', [fakeOffer]);
    expect(await reprice([p.id], 'cost_sync')).toEqual({ repriced: 1, reviewsOpened: 0 });
    expect((await prices(p.id))[0]).toMatchObject({
      routeId: manualRoute,
      priceUsdUnits: priceFromCost(usd(2), rule),
      cause: 'route_change',
    });
    expect((await state(p.id))?.routes.map((item) => [item.id, item.unusableReason])).toEqual([
      [manualRoute, null],
      [fakeRoute, 'offer_missing'],
    ]);

    // It comes back: the price returns with it.
    await pool.query('update supplier_offers set missing_since = null where id = $1', [fakeOffer]);
    await reprice([p.id], 'cost_sync');
    expect((await prices(p.id))[0]).toMatchObject({ routeId: fakeRoute, cause: 'route_change' });

    // No usable route: nothing is written; the product is out of stock with its last price.
    await pool.query('update product_routes set enabled = false where product_id = $1', [p.id]);
    expect(await reprice([p.id], 'route_change')).toEqual({ repriced: 0, reviewsOpened: 0 });
    expect((await prices(p.id)).length).toBe(3);
    expect((await state(p.id))?.availability).toBe('out_of_stock');
  });

  it('makes a route with a field the game no longer has unusable (rule RT3)', async () => {
    const p = await product();
    await route(p.id, 'fake', await offer('fake', usd(1)));
    await pool.query(`update catalog_input_fields set archived_at = now() where game_id = $1`, [
      p.game,
    ]);
    expect((await state(p.id))?.routes[0]?.unusableReason).toBe('fields_incomplete');
    expect(await reprice([p.id], 'route_change')).toEqual({ repriced: 0, reviewsOpened: 0 });
  });

  it('serializes a sync and a rule change on one product, each from fresh facts', async () => {
    const p = await product();
    const fakeOffer = await offer('fake', usd(1));
    await route(p.id, 'fake', fakeOffer);
    await reprice([p.id], 'route_change');
    await setCost(fakeOffer, usd(1.05));
    await pool.query(
      `update margin_rules set percent_bp = 1500 where scope = 'product' and target_id = $1`,
      [p.id],
    );
    const results = await Promise.all([
      reprice([p.id], 'cost_sync'),
      reprice([p.id], 'rule_change'),
      reprice([p.id], 'cost_sync'),
    ]);
    // Exactly one of them wrote the new price; the others found it current.
    expect(results.reduce((sum, result) => sum + result.repriced, 0)).toBe(1);
    expect((await prices(p.id))[0]?.priceUsdUnits).toBe(
      priceFromCost(usd(1.05), { ...rule, percentBp: 1500 }),
    );
  });
});
