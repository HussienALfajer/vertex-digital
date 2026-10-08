import { SUPPLIER_POLICY_DEFAULTS } from '@vertex-digital/contracts';
import type pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase } from './client.js';
import { newId } from './id.js';

/*
 * Suppliers, routes, stored prices and reviews (S07 "Data"): seeds, checks, partial unique
 * indexes and the append-only guards. Every write runs in a rolled-back transaction.
 */

const connection = createDatabase(process.env.DATABASE_URL as string);
const owner = createDatabase(process.env.DATABASE_OWNER_URL as string);

afterAll(() => Promise.all([connection.close(), owner.close()]));

async function rolledBack(
  work: (client: pg.PoolClient) => Promise<void>,
  pool: pg.Pool = connection.pool,
) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await work(client);
  } finally {
    await client.query('rollback');
    client.release();
  }
}

/** Runs `sql` under a savepoint and returns the constraint or message it failed with, or null. */
async function violation(client: pg.PoolClient, sql: string, values: unknown[] = []) {
  await client.query('savepoint attempt');
  try {
    await client.query(sql, values);
    await client.query('release savepoint attempt');
    return null;
  } catch (error) {
    await client.query('rollback to savepoint attempt');
    return (error as { constraint?: string }).constraint ?? (error as Error).message;
  }
}

const unique = () => newId().replaceAll('-', '').slice(-12);

async function supplierId(client: pg.PoolClient, code: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>('select id from suppliers where code = $1', [
    code,
  ]);
  return (rows[0] as { id: string }).id;
}

/** A product under a new category and game, with one manual offer and its route. */
async function routedProduct(client: pg.PoolClient) {
  const category = newId();
  const game = newId();
  const product = newId();
  const offer = newId();
  const route = newId();
  const manual = await supplierId(client, 'manual');
  await client.query(
    'insert into catalog_categories (id, slug, name_ar, sort_order) values ($1, $2, $3, 99)',
    [category, `c-${unique()}`, `فئة ${unique()}`],
  );
  await client.query(
    `insert into catalog_games (id, category_id, slug, name_ar, name_en, sort_order)
     values ($1, $2, $3, $4, 'Game', 1)`,
    [game, category, `g-${unique()}`, `لعبة ${unique()}`],
  );
  await client.query(
    `insert into catalog_products (id, game_id, kind, name_ar, max_quantity, sort_order)
     values ($1, $2, 'direct', $3, 1, 1)`,
    [product, game, `باقة ${unique()}`],
  );
  await client.query(
    `insert into supplier_offers (id, supplier_id, offer_id, name, in_stock, cost_usd_units,
       last_seen_at) values ($1, $2, $3, 'Manual', true, 1000000, now())`,
    [offer, manual, offer],
  );
  await client.query(
    'insert into product_routes (id, product_id, supplier_id, offer_id) values ($1, $2, $3, $4)',
    [route, product, manual, offer],
  );
  const { rows } = await client.query<{ id: string }>(
    `select id from margin_rules where scope = 'global' and archived_at is null`,
  );
  return { category, game, product, offer, route, manual, rule: (rows[0] as { id: string }).id };
}

describe('seeds', () => {
  it('hold the four suppliers and the default policy', async () => {
    const { rows } = await connection.pool.query(
      `select code, name_ar, low_balance_usd_units from suppliers order by code::text`,
    );
    expect(rows).toEqual([
      { code: 'fake', name_ar: 'مورد تجريبي', low_balance_usd_units: '50000000' },
      { code: 'manual', name_ar: 'يدوي', low_balance_usd_units: '50000000' },
      { code: 'shop2topup', name_ar: 'SHOP2TOPUP', low_balance_usd_units: '50000000' },
      { code: 'wdgzone', name_ar: 'WDGZone', low_balance_usd_units: '50000000' },
    ]);
    const policy = await connection.pool.query(
      `select price_review_threshold_bp, cost_stale_minutes, health_window_minutes,
         health_min_calls, degraded_success_bp, degraded_p90_ms, down_success_bp,
         down_consecutive_errors, probe_after_minutes
       from supplier_policy where id = '01a11d3c-890c-77e7-af29-451969625ce3'`,
    );
    expect(policy.rows).toEqual([
      {
        price_review_threshold_bp: SUPPLIER_POLICY_DEFAULTS.priceReviewThresholdBp,
        cost_stale_minutes: SUPPLIER_POLICY_DEFAULTS.costStaleMinutes,
        health_window_minutes: SUPPLIER_POLICY_DEFAULTS.healthWindowMinutes,
        health_min_calls: SUPPLIER_POLICY_DEFAULTS.healthMinCalls,
        degraded_success_bp: SUPPLIER_POLICY_DEFAULTS.degradedSuccessBp,
        degraded_p90_ms: SUPPLIER_POLICY_DEFAULTS.degradedP90Ms,
        down_success_bp: SUPPLIER_POLICY_DEFAULTS.downSuccessBp,
        down_consecutive_errors: SUPPLIER_POLICY_DEFAULTS.downConsecutiveErrors,
        probe_after_minutes: SUPPLIER_POLICY_DEFAULTS.probeAfterMinutes,
      },
    ]);
  });

  it('add the supplier pause switches', async () => {
    const { rows } = await connection.pool.query<{ values: string }>(
      `select enum_range(null::store_switch)::text as values`,
    );
    for (const value of ['shop2topup_paused', 'wdgzone_paused', 'manual_paused', 'fake_paused']) {
      expect(rows[0]?.values).toContain(value);
    }
  });
});

describe('routes', () => {
  it('allow one unarchived route per supplier per product, and one product per offer', () =>
    rolledBack(async (client) => {
      const a = await routedProduct(client);
      const b = await routedProduct(client);
      const offer = newId();
      await client.query(
        `insert into supplier_offers (id, supplier_id, offer_id, name, in_stock, last_seen_at)
         values ($1, $2, $3, 'Manual 2', true, now())`,
        [offer, a.manual, offer],
      );
      const insert = `insert into product_routes (id, product_id, supplier_id, offer_id)
        values ($1, $2, $3, $4)`;
      expect(await violation(client, insert, [newId(), a.product, a.manual, offer])).toBe(
        'product_routes_product_id_supplier_id_live_idx',
      );
      // b's own manual route archived: b may take a manual route, but not a's offer.
      await client.query('update product_routes set archived_at = now() where id = $1', [b.route]);
      expect(await violation(client, insert, [newId(), b.product, a.manual, a.offer])).toBe(
        'product_routes_offer_id_live_idx',
      );
      // An archived route frees its offer.
      await client.query('update product_routes set archived_at = now() where id = $1', [a.route]);
      expect(await violation(client, insert, [newId(), b.product, a.manual, a.offer])).toBeNull();
      expect(await violation(client, insert, [newId(), a.product, a.manual, offer])).toBeNull();
    }));

  it('bound the priority and keep the field map an object', () =>
    rolledBack(async (client) => {
      const { route } = await routedProduct(client);
      expect(
        await violation(client, 'update product_routes set priority = 10 where id = $1', [route]),
      ).toBe('product_routes_priority_check');
      expect(
        await violation(client, `update product_routes set field_map = '[]' where id = $1`, [
          route,
        ]),
      ).toBe('product_routes_field_map_check');
    }));
});

describe('offers', () => {
  it('keep one row per supplier offer id and a cost within $10,000', () =>
    rolledBack(async (client) => {
      const fake = await supplierId(client, 'fake');
      const offerId = `o-${unique()}`;
      const insert = `insert into supplier_offers (id, supplier_id, offer_id, name, in_stock,
        cost_usd_units, last_seen_at) values ($1, $2, $3, 'Offer', true, $4, now())`;
      expect(await violation(client, insert, [newId(), fake, offerId, 1])).toBeNull();
      expect(await violation(client, insert, [newId(), fake, offerId, 1])).toBe(
        'supplier_offers_supplier_id_offer_id_idx',
      );
      expect(await violation(client, insert, [newId(), fake, `o-${unique()}`, 0])).toBe(
        'supplier_offers_cost_check',
      );
      expect(
        await violation(client, insert, [newId(), fake, `o-${unique()}`, 10_000_000_001]),
      ).toBe('supplier_offers_cost_check');
    }));
});

describe('sync runs', () => {
  it('allow one running run per supplier and never change a finished one', () =>
    rolledBack(async (client) => {
      const fake = await supplierId(client, 'fake');
      await client.query(
        `update supplier_sync_runs set status = 'failed', finished_at = now(),
        error_code = 'ABANDONED' where supplier_id = $1 and status = 'running'`,
        [fake],
      );
      const insert = `insert into supplier_sync_runs (id, supplier_id, trigger) values ($1, $2,
        'admin')`;
      const run = newId();
      expect(await violation(client, insert, [run, fake])).toBeNull();
      expect(await violation(client, insert, [newId(), fake])).toBe(
        'supplier_sync_runs_running_idx',
      );
      expect(
        await violation(
          client,
          `update supplier_sync_runs set status = 'succeeded' where id = $1`,
          [run],
        ),
      ).toBe('supplier_sync_runs_finished_check');
      await client.query(
        `update supplier_sync_runs set status = 'succeeded', finished_at = now() where id = $1`,
        [run],
      );
      expect(
        await violation(client, 'update supplier_sync_runs set offers_seen = 1 where id = $1', [
          run,
        ]),
      ).toMatch(/a finished run never changes/);
      expect(
        await violation(client, 'delete from supplier_sync_runs where id = $1', [run]),
      ).toMatch(/never deleted/);
    }));
});

describe('stored prices and reviews', () => {
  const price = `insert into product_prices (id, product_id, price_usd_units, cost_usd_units,
    route_id, rule_id, percent_bp, fixed_usd_units, min_margin_usd_units, cause)
    values ($1, $2, $3, $4, $5, $6, 1000, 0, 100000, 'route_change')`;

  it('keep prices in whole cents and above the cost (rule P8)', () =>
    rolledBack(async (client) => {
      const p = await routedProduct(client);
      const values = (amount: number, cost: number) => [
        newId(),
        p.product,
        amount,
        cost,
        p.route,
        p.rule,
      ];
      expect(await violation(client, price, values(1_100_000, 1_000_000))).toBeNull();
      expect(await violation(client, price, values(1_100_001, 1_000_000))).toBe(
        'product_prices_price_check',
      );
      expect(await violation(client, price, values(1_000_000, 1_000_000))).toBe(
        'product_prices_price_check',
      );
    }));

  it('allow one open review per product and never change a decided one', () =>
    rolledBack(async (client) => {
      const p = await routedProduct(client);
      const insert = `insert into price_reviews (id, product_id, route_id, cost_before_usd_units,
        cost_after_usd_units, change_bp, price_before_usd_units, proposed_price_usd_units)
        values ($1, $2, $3, 1000000, 1200000, 2000, 1100000, 1320000)`;
      const review = newId();
      expect(await violation(client, insert, [review, p.product, p.route])).toBeNull();
      expect(await violation(client, insert, [newId(), p.product, p.route])).toBe(
        'price_reviews_open_idx',
      );
      expect(
        await violation(
          client,
          'update price_reviews set price_before_usd_units = 1200000 where id = $1',
          [review],
        ),
      ).toMatch(/price held are fixed/);
      await client.query(
        `update price_reviews set status = 'accepted', decided_at = now() where id = $1`,
        [review],
      );
      expect(
        await violation(client, `update price_reviews set status = 'paused' where id = $1`, [
          review,
        ]),
      ).toMatch(/a decided review never changes/);
      expect(await violation(client, 'delete from price_reviews where id = $1', [review])).toMatch(
        /never deleted/,
      );
      expect(await violation(client, insert, [newId(), p.product, p.route])).toBeNull();
    }));
});

describe('append-only supplier tables', () => {
  const tables = [
    'supplier_credentials',
    'supplier_cost_changes',
    'supplier_calls',
    'supplier_health_changes',
    'supplier_balance_reads',
    'supplier_policy',
    'product_prices',
  ];

  it.each(tables)('gives the app role SELECT and INSERT only on %s', async (table) => {
    const { rows } = await connection.pool.query<{ privileges: Record<string, boolean> }>(
      `select json_object_agg(p, has_table_privilege(current_user, $1, p)) as privileges
       from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as p`,
      [table],
    );
    expect(rows[0]?.privileges).toEqual({
      SELECT: true,
      INSERT: true,
      UPDATE: false,
      DELETE: false,
      TRUNCATE: false,
    });
  });

  it('refuses the owner a change of a policy row', () =>
    rolledBack(async (client) => {
      for (const statement of [
        'update supplier_policy set cost_stale_minutes = 60',
        'delete from supplier_policy',
      ]) {
        expect(await violation(client, statement)).toMatch(/supplier_policy is append-only/);
      }
    }, owner.pool));

  it('refuses a policy with down at or above degraded', () =>
    rolledBack(async (client) => {
      expect(
        await violation(
          client,
          `insert into supplier_policy (id, price_review_threshold_bp, cost_stale_minutes,
            health_window_minutes, health_min_calls, degraded_success_bp, degraded_p90_ms,
            down_success_bp, down_consecutive_errors, probe_after_minutes)
           values ($1, 1000, 120, 30, 5, 5000, 10000, 5000, 3, 10)`,
          [newId()],
        ),
      ).toBe('supplier_policy_bounds_check');
    }));
});
