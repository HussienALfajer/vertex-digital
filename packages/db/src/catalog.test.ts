import type pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase } from './client.js';
import { newId } from './id.js';

/*
 * The catalog and margin rules (S06): checks, partial unique indexes and seeds. Every write runs
 * in a rolled-back transaction, so no test leaves a row behind or meets another test's rows.
 */

const connection = createDatabase(process.env.DATABASE_URL as string);

afterAll(() => connection.close());

async function rolledBack(work: (client: pg.PoolClient) => Promise<void>) {
  const client = await connection.pool.connect();
  try {
    await client.query('begin');
    await work(client);
  } finally {
    await client.query('rollback');
    client.release();
  }
}

/** Runs `sql` under a savepoint and returns the constraint it violated, or null. */
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

async function category(client: pg.PoolClient, values: { slug?: string; name?: string } = {}) {
  const id = newId();
  await client.query(
    'insert into catalog_categories (id, slug, name_ar, sort_order) values ($1, $2, $3, 99)',
    [id, values.slug ?? `c-${unique()}`, values.name ?? `فئة ${unique()}`],
  );
  return id;
}

async function game(client: pg.PoolClient, categoryId: string) {
  const id = newId();
  await client.query(
    `insert into catalog_games (id, category_id, slug, name_ar, name_en, sort_order)
     values ($1, $2, $3, $4, 'Game', 1)`,
    [id, categoryId, `g-${unique()}`, `لعبة ${unique()}`],
  );
  return id;
}

describe('seeds', () => {
  it('hold the three categories and the global rule (Q7)', async () => {
    const { rows } = await connection.pool.query<{ slug: string; name_ar: string }>(
      `select slug, name_ar from catalog_categories
       where slug in ('games', 'apps', 'gift-cards') order by sort_order`,
    );
    expect(rows).toEqual([
      { slug: 'games', name_ar: 'ألعاب' },
      { slug: 'apps', name_ar: 'تطبيقات' },
      { slug: 'gift-cards', name_ar: 'بطاقات هدايا' },
    ]);
    const global = await connection.pool.query(
      `select percent_bp, fixed_usd_units, min_margin_usd_units from margin_rules
       where scope = 'global' and archived_at is null`,
    );
    expect(global.rows).toEqual([
      { percent_bp: 1000, fixed_usd_units: '0', min_margin_usd_units: '100000' },
    ]);
  });

  it('add catalog_image to the stored file kinds', async () => {
    const { rows } = await connection.pool.query<{ kinds: string }>(
      `select enum_range(null::stored_file_kind)::text as kinds`,
    );
    expect(rows[0]?.kinds).toContain('catalog_image');
  });
});

describe('catalog checks and indexes', () => {
  it('keep slugs unique across archived rows, names among unarchived ones', () =>
    rolledBack(async (client) => {
      const slug = `s-${unique()}`;
      const name = `اسم ${unique()}`;
      const first = await category(client, { slug, name });
      expect(
        await violation(
          client,
          `insert into catalog_categories (id, slug, name_ar, sort_order)
        values ($1, $2, 'x', 1)`,
          [newId(), slug],
        ),
      ).toBe('catalog_categories_slug_unique');
      expect(
        await violation(
          client,
          `insert into catalog_categories (id, slug, name_ar, sort_order)
        values ($1, $2, $3, 1)`,
          [newId(), `s-${unique()}`, name],
        ),
      ).toBe('catalog_categories_name_ar_live_idx');
      await client.query('update catalog_categories set archived_at = now() where id = $1', [
        first,
      ]);
      expect(
        await violation(
          client,
          `insert into catalog_categories (id, slug, name_ar, sort_order)
        values ($1, $2, $3, 1)`,
          [newId(), `s-${unique()}`, name],
        ),
      ).toBeNull();
      expect(
        await violation(
          client,
          `insert into catalog_categories (id, slug, name_ar, sort_order)
        values ($1, 'Bad-Slug', 'y', 1)`,
          [newId()],
        ),
      ).toBe('catalog_categories_slug_check');
    }));

  it('check games: accent upper-case #RRGGBB, text bounds', () =>
    rolledBack(async (client) => {
      const gameId = await game(client, await category(client));
      const set = (column: string, value: unknown) =>
        violation(client, `update catalog_games set ${column} = $2 where id = $1`, [gameId, value]);
      expect(await set('accent_color', '#F2A900')).toBeNull();
      expect(await set('accent_color', '#f2a900')).toBe('catalog_games_accent_color_check');
      expect(await set('region_notes_ar', 'x'.repeat(501))).toBe(
        'catalog_games_region_notes_ar_check',
      );
      expect(await set('name_en', '')).toBe('catalog_games_name_en_check');
      const { rows } = await client.query('select status from catalog_games where id = $1', [
        gameId,
      ]);
      expect(rows[0]).toEqual({ status: 'paused' });
    }));

  it('check input fields: keys once per game, bounds and options by type', () =>
    rolledBack(async (client) => {
      const gameId = await game(client, await category(client));
      const insert = (
        key: string,
        type: string,
        min: number | null,
        max: number | null,
        options: unknown,
      ) =>
        violation(
          client,
          `insert into catalog_input_fields
             (id, game_id, key, label_ar, type, required, min_length, max_length, options, sort_order)
           values ($1, $2, $3, 'حقل', $4, true, $5, $6, $7, 1)`,
          [newId(), gameId, key, type, min, max, options === null ? null : JSON.stringify(options)],
        );
      expect(await insert('player_id', 'digits', 5, 15, null)).toBeNull();
      expect(await insert('player_id', 'text', null, null, null)).toBe(
        'catalog_input_fields_game_id_key_idx',
      );
      expect(await insert('a1', 'digits', 9, 5, null)).toBe('catalog_input_fields_bounds_check');
      expect(await insert('a2', 'digits', 1, 33, null)).toBe('catalog_input_fields_bounds_check');
      expect(await insert('a3', 'text', 1, 64, null)).toBeNull();
      expect(await insert('a4', 'phone', 1, null, null)).toBe('catalog_input_fields_bounds_check');
      const two = [
        { value: 'a', labelAr: 'أ' },
        { value: 'b', labelAr: 'ب' },
      ];
      expect(await insert('a5', 'select', null, null, two)).toBeNull();
      expect(await insert('a6', 'select', null, null, [two[0]])).toBe(
        'catalog_input_fields_options_check',
      );
      expect(await insert('a7', 'text', null, null, two)).toBe(
        'catalog_input_fields_options_check',
      );
      expect(await insert('Bad', 'text', null, null, null)).toBe('catalog_input_fields_key_check');
    }));

  it('check products: whole-cent official price, quantity, code-only text, names per game', () =>
    rolledBack(async (client) => {
      const gameId = await game(client, await category(client));
      const insert = (values: {
        kind?: string;
        name?: string;
        price?: number | null;
        quantity?: number;
        region?: string | null;
      }) =>
        violation(
          client,
          `insert into catalog_products
             (id, game_id, kind, name_ar, official_price_usd_units, max_quantity, region_ar, sort_order)
           values ($1, $2, $3, $4, $5, $6, $7, 1)`,
          [
            newId(),
            gameId,
            values.kind ?? 'direct',
            values.name ?? `باقة ${unique()}`,
            values.price ?? null,
            values.quantity ?? 1,
            values.region ?? null,
          ],
        );
      expect(await insert({ name: '60 UC', price: 990_000 })).toBeNull();
      expect(await insert({ name: '60 UC' })).toBe('catalog_products_game_id_name_ar_live_idx');
      expect(await insert({ price: 990_001 })).toBe('catalog_products_official_price_check');
      expect(await insert({ price: 0 })).toBe('catalog_products_official_price_check');
      expect(await insert({ quantity: 51 })).toBe('catalog_products_max_quantity_check');
      expect(await insert({ quantity: 0 })).toBe('catalog_products_max_quantity_check');
      expect(await insert({ region: 'US' })).toBe('catalog_products_code_text_check');
      expect(await insert({ kind: 'code', region: 'US', quantity: 10 })).toBeNull();
      // The same name in another game is fine.
      const other = await game(client, await category(client));
      expect(
        await violation(
          client,
          `insert into catalog_products (id, game_id, kind, name_ar, max_quantity, sort_order)
           values ($1, $2, 'direct', '60 UC', 1, 1)`,
          [newId(), other],
        ),
      ).toBeNull();
    }));
});

describe('margin rules', () => {
  const insert = (
    client: pg.PoolClient,
    scope: string,
    targetId: string | null,
    values = [1000, 0, 100_000],
  ) =>
    violation(
      client,
      `insert into margin_rules (id, scope, target_id, percent_bp, fixed_usd_units, min_margin_usd_units)
       values ($1, $2, $3, $4, $5, $6)`,
      [newId(), scope, targetId, ...values],
    );

  it('keep one live rule per target and one global rule', () =>
    rolledBack(async (client) => {
      const target = newId();
      expect(await insert(client, 'game', target)).toBeNull();
      expect(await insert(client, 'game', target)).toBe('margin_rules_scope_target_id_live_idx');
      expect(await insert(client, 'global', null)).toBe('margin_rules_global_live_idx');
      await client.query(`update margin_rules set archived_at = now() where target_id = $1`, [
        target,
      ]);
      expect(await insert(client, 'game', target)).toBeNull();
    }));

  it('check the target and the bounds of PR1', () =>
    rolledBack(async (client) => {
      expect(await insert(client, 'global', newId())).toBe('margin_rules_target_check');
      expect(await insert(client, 'product', null)).toBe('margin_rules_target_check');
      expect(await insert(client, 'product', newId(), [10_001, 0, 100_000])).toBe(
        'margin_rules_percent_bp_check',
      );
      expect(await insert(client, 'product', newId(), [0, 5_000, 100_000])).toBe(
        'margin_rules_fixed_check',
      );
      expect(await insert(client, 'product', newId(), [0, 50_010_000, 100_000])).toBe(
        'margin_rules_fixed_check',
      );
      expect(await insert(client, 'product', newId(), [0, 0, 0])).toBe(
        'margin_rules_min_margin_check',
      );
      expect(await insert(client, 'product', newId(), [0, 0, 15_000])).toBe(
        'margin_rules_min_margin_check',
      );
      expect(await insert(client, 'product', newId(), [0, 0, 10_000])).toBeNull();
    }));
});
