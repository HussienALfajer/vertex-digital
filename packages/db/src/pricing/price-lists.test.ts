import { ROOT_PRICE_LIST_IDS } from '@vertex-digital/contracts';
import type pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../client.js';
import { newId } from '../id.js';

/*
 * S20 data (ADR 0035): the seeded lists, their checks, partial unique indexes and guards, the
 * backfill of the list columns and `orders_guard` on an order's list. Every write runs in a
 * rolled-back transaction.
 */

const connection = createDatabase(process.env.DATABASE_URL as string);
const owner = createDatabase(process.env.DATABASE_OWNER_URL as string);

afterAll(() => Promise.all([connection.close(), owner.close()]));

const { retail, wholesale, cost } = ROOT_PRICE_LIST_IDS;

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

/** The violated constraint's name, or the error message; null when the statement passed. */
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

const insertList = (client: pg.PoolClient, kind: string, parent: string | null, name?: string) =>
  violation(
    client,
    'insert into price_lists (id, kind, name, parent_list_id) values ($1, $2, $3, $4)',
    [newId(), kind, name ?? `قائمة ${unique()}`, parent],
  );

/** An unarchived product of any game, for fixed prices. */
async function anyProduct(client: pg.PoolClient): Promise<string> {
  const { rows } = await client.query<{ id: string }>('select id from catalog_products limit 1');
  if (rows[0]) return rows[0].id;
  const [category, game, product] = [newId(), newId(), newId()];
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
  return product;
}

describe('seeds and backfill', () => {
  it('hold the three root lists with their fixed ids', async () => {
    const { rows } = await connection.pool.query(
      `select id, kind, name, parent_list_id from price_lists where kind <> 'custom' order by id`,
    );
    expect(rows).toEqual([
      { id: retail, kind: 'retail', name: 'التجزئة', parent_list_id: null },
      { id: wholesale, kind: 'wholesale', name: 'الجملة', parent_list_id: null },
      { id: cost, kind: 'cost', name: 'سعر التكلفة', parent_list_id: null },
    ]);
  });

  it('put every row written before S20 on retail, with a rule source', async () => {
    const { rows } = await connection.pool.query(
      `select
         (select count(*) from margin_rules where price_list_id is null)::int as rules,
         (select count(*) from product_prices where price_list_id is null or source is null)::int as prices,
         (select count(*) from orders where price_list_id is null)::int as orders,
         (select column_default from information_schema.columns
           where table_name = 'orders' and column_name = 'price_list_id') as order_default,
         (select column_default from information_schema.columns
           where table_name = 'customers' and column_name = 'account_type') as account_default`,
    );
    expect(rows[0]).toEqual({
      rules: 0,
      prices: 0,
      orders: 0,
      // 0082 dropped the retail default once S20 ran in production: every insert names its list.
      order_default: null,
      account_default: `'customer'::account_type`,
    });
  });
});

describe('price lists', () => {
  it('keep one live list per root kind, names unique among live lists, a parent for custom only', () =>
    rolledBack(async (client) => {
      expect(await insertList(client, 'wholesale', null)).toBe('price_lists_root_kind_live_idx');
      expect(await insertList(client, 'custom', null)).toBe('price_lists_parent_check');
      expect(await insertList(client, 'cost', wholesale)).toBe('price_lists_parent_check');
      expect(await insertList(client, 'custom', wholesale, ' VIP')).toBe('price_lists_name_check');
      expect(await insertList(client, 'custom', wholesale, 'V')).toBe('price_lists_name_check');
      const name = `VIP ${unique()}`;
      expect(await insertList(client, 'custom', wholesale, name)).toBeNull();
      expect(await insertList(client, 'custom', retail, name.toLowerCase())).toBe(
        'price_lists_name_live_idx',
      );
      await client.query('update price_lists set archived_at = now() where name = $1', [name]);
      expect(await insertList(client, 'custom', retail, name)).toBeNull();
    }));

  it('never archive a root list, never change a kind or parent, never bring one back', () =>
    rolledBack(async (client) => {
      expect(
        await violation(client, 'update price_lists set archived_at = now() where id = $1', [cost]),
      ).toBe('price_lists_root_live_check');
      expect(
        await violation(client, `update price_lists set name = 'التجزئة الجديدة' where id = $1`, [
          retail,
        ]),
      ).toBeNull();
      const id = newId();
      await client.query(
        `insert into price_lists (id, kind, name, parent_list_id) values ($1, 'custom', $2, $3)`,
        [id, `قائمة ${unique()}`, wholesale],
      );
      expect(
        await violation(client, 'update price_lists set parent_list_id = $2 where id = $1', [
          id,
          retail,
        ]),
      ).toMatch(/fixed/);
      expect(
        await violation(client, `update price_lists set kind = 'cost' where id = $1`, [id]),
      ).toMatch(/fixed/);
      await client.query('update price_lists set archived_at = now() where id = $1', [id]);
      expect(
        await violation(client, 'update price_lists set archived_at = null where id = $1', [id]),
      ).toMatch(/stays archived/);
    }));

  it('are never deleted, by the app role or the owner', async () => {
    await rolledBack(async (client) => {
      expect(await violation(client, 'delete from price_lists where id = $1', [cost])).toMatch(
        /permission denied/,
      );
    });
    await rolledBack(async (client) => {
      expect(await violation(client, 'delete from price_lists where id = $1', [cost])).toMatch(
        /never deleted/,
      );
    }, owner.pool);
  });
});

describe('fixed prices and list rows', () => {
  it('keep one live fixed price per list and product, in whole cents up to $10,000', () =>
    rolledBack(async (client) => {
      const product = await anyProduct(client);
      const insert = (priceUsdUnits: number, list: string = wholesale) =>
        violation(
          client,
          `insert into price_list_fixed_prices (id, price_list_id, product_id, price_usd_units)
           values ($1, $2, $3, $4)`,
          [newId(), list, product, priceUsdUnits],
        );
      expect(await insert(1_005_000)).toBe('price_list_fixed_prices_price_check');
      expect(await insert(0)).toBe('price_list_fixed_prices_price_check');
      expect(await insert(10_000_010_000)).toBe('price_list_fixed_prices_price_check');
      expect(await insert(990_000)).toBeNull();
      expect(await insert(980_000)).toBe('price_list_fixed_prices_list_product_live_idx');
      expect(await insert(980_000, cost)).toBeNull();
    }));

  it('change only by archiving, once, and are never deleted', async () => {
    await rolledBack(async (client) => {
      const product = await anyProduct(client);
      const id = newId();
      await client.query(
        `insert into price_list_fixed_prices (id, price_list_id, product_id, price_usd_units)
         values ($1, $2, $3, 990000)`,
        [id, wholesale, product],
      );
      expect(
        await violation(
          client,
          'update price_list_fixed_prices set price_usd_units = 980000 where id = $1',
          [id],
        ),
      ).toMatch(/only archived/);
      expect(
        await violation(client, 'delete from price_list_fixed_prices where id = $1', [id]),
      ).toMatch(/permission denied/);
      await client.query('update price_list_fixed_prices set archived_at = now() where id = $1', [
        id,
      ]);
      expect(
        await violation(
          client,
          'update price_list_fixed_prices set archived_at = now() where id = $1',
          [id],
        ),
      ).toMatch(/only archived/);
    });
    await rolledBack(async (client) => {
      // A row of its own: an empty table would fire no row trigger.
      const id = newId();
      await client.query(
        `insert into price_list_fixed_prices (id, price_list_id, product_id, price_usd_units)
         values ($1, $2, $3, 990000)`,
        [id, wholesale, await anyProduct(client)],
      );
      expect(
        await violation(client, 'delete from price_list_fixed_prices where id = $1', [id]),
      ).toMatch(/never deleted/);
    }, owner.pool);
  });

  it('tie a fixed price to the fixed sources of a price row', () =>
    rolledBack(async (client) => {
      const { rows } = await client.query<{
        product_id: string;
        route_id: string;
        rule_id: string;
      }>('select product_id, route_id, rule_id from product_prices limit 1');
      const row = rows[0];
      if (!row) return;
      const insert = (source: string, fixedPriceId: string | null) =>
        violation(
          client,
          `insert into product_prices (id, product_id, price_list_id, source, fixed_price_id,
             price_usd_units, cost_usd_units, route_id, rule_id, percent_bp, fixed_usd_units,
             min_margin_usd_units, cause)
           values ($1, $2, $3, $4, $5, 2000000, 1000000, $6, $7, 0, 0, 10000, 'list_change')`,
          [newId(), row.product_id, wholesale, source, fixedPriceId, row.route_id, row.rule_id],
        );
      expect(await insert('fixed', null)).toBe('product_prices_fixed_price_check');
      expect(await insert('retail_cap', null)).toBeNull();
    }));
});
