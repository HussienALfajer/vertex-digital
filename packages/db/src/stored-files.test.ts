import type pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase } from './client.js';
import { newId } from './id.js';

/*
 * The stored files sweep (audit A10-45, migration 0103): which files the two functions mark and
 * sweep, and the guard that keeps every other change refused. Every write runs in a rolled-back
 * transaction.
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

/** Runs `sql` under a savepoint and returns the message it failed with, or null. */
async function violation(client: pg.PoolClient, sql: string, values: unknown[] = []) {
  await client.query('savepoint attempt');
  try {
    await client.query(sql, values);
    await client.query('release savepoint attempt');
    return null;
  } catch (error) {
    await client.query('rollback to savepoint attempt');
    return (error as Error).message;
  }
}

const unique = () => newId().replaceAll('-', '').slice(-12);

async function file(client: pg.PoolClient, kind: string, daysAgo: number) {
  const id = newId();
  const extension = kind === 'sham_cash_qr' ? 'png' : 'webp';
  await client.query(
    `insert into stored_files (id, kind, storage_key, content_type, byte_size, width, height,
       created_at)
     values ($1, $2, $3, $4, 10, 100, 100, now() - make_interval(days => $5))`,
    [id, kind, `${kind}/${id.slice(-2)}/${id}.${extension}`, `image/${extension}`, daysAgo],
  );
  return id;
}

/** A game under a new category with `cover` as its cover. */
async function gameWithCover(client: pg.PoolClient, cover: string | null) {
  const category = newId();
  const game = newId();
  await client.query(
    'insert into catalog_categories (id, slug, name_ar, sort_order) values ($1, $2, $3, 99)',
    [category, `c-${unique()}`, `فئة ${unique()}`],
  );
  await client.query(
    `insert into catalog_games (id, category_id, slug, name_ar, name_en, sort_order, cover_file_id)
     values ($1, $2, $3, $4, 'Game', 1, $5)`,
    [game, category, `g-${unique()}`, `لعبة ${unique()}`, cover],
  );
  return game;
}

async function state(client: pg.PoolClient, id: string) {
  const { rows } = await client.query<{ unreferenced: boolean; swept: boolean }>(
    `select unreferenced_since is not null as unreferenced, swept_at is not null as swept
     from stored_files where id = $1`,
    [id],
  );
  return rows[0];
}

/** Moves a file's mark back in time, as the owner with the sweep's flag (test only). */
async function markedDaysAgo(client: pg.PoolClient, id: string, days: number) {
  await client.query(`select set_config('vertex.stored_files_sweep', 'on', true)`);
  await client.query(
    `update stored_files set unreferenced_since = now() - make_interval(days => $2) where id = $1`,
    [id, days],
  );
  await client.query(`select set_config('vertex.stored_files_sweep', 'off', true)`);
}

describe('the stored files sweep (audit A10-45)', () => {
  it('marks only sweepable files nothing references, and clears the mark when one is used', () =>
    rolledBack(async (client) => {
      const loose = await file(client, 'catalog_image', 40);
      const cover = await file(client, 'catalog_image', 40);
      const receipt = await file(client, 'deposit_receipt', 400);
      const attachment = await file(client, 'ticket_attachment', 400);
      const game = await gameWithCover(client, cover);

      await client.query('select stored_files_mark_unreferenced()');
      expect(await state(client, loose)).toEqual({ unreferenced: true, swept: false });
      expect(await state(client, cover)).toEqual({ unreferenced: false, swept: false });
      expect(await state(client, receipt)).toEqual({ unreferenced: false, swept: false });
      expect(await state(client, attachment)).toEqual({ unreferenced: false, swept: false });

      await client.query('update catalog_games set cover_file_id = $2 where id = $1', [
        game,
        loose,
      ]);
      await client.query('select stored_files_mark_unreferenced()');
      expect(await state(client, loose)).toEqual({ unreferenced: false, swept: false });
      expect(await state(client, cover)).toEqual({ unreferenced: true, swept: false });
    }, owner.pool));

  it('sweeps a file unreferenced for 30 days and older than 30 days, and returns its key', () =>
    rolledBack(async (client) => {
      const due = await file(client, 'merchant_logo', 60);
      const markedLately = await file(client, 'catalog_image', 60);
      const young = await file(client, 'sham_cash_qr', 10);
      await client.query('select stored_files_mark_unreferenced()');
      await markedDaysAgo(client, due, 31);
      await markedDaysAgo(client, young, 31);

      const { rows } = await client.query<{ key: string }>(
        'select stored_files_sweep(1000) as key',
      );
      const keys = rows.map((row) => row.key);
      expect(keys.some((key) => key.includes(due))).toBe(true);
      expect(keys.some((key) => key.includes(markedLately))).toBe(false);
      expect(keys.some((key) => key.includes(young))).toBe(false);
      expect(await state(client, due)).toEqual({ unreferenced: true, swept: true });
      expect(await state(client, markedLately)).toEqual({ unreferenced: true, swept: false });

      // A swept row is final, even for the sweep's own functions.
      await client.query('select stored_files_mark_unreferenced()');
      expect(await state(client, due)).toEqual({ unreferenced: true, swept: true });
      await client.query(`select set_config('vertex.stored_files_sweep', 'on', true)`);
      expect(
        await violation(client, 'update stored_files set swept_at = null where id = $1', [due]),
      ).toMatch(/stored_files is append-only: UPDATE/);
    }, owner.pool));

  it('never sweeps a file a row references again before the sweep runs', () =>
    rolledBack(async (client) => {
      const reused = await file(client, 'catalog_image', 60);
      await client.query('select stored_files_mark_unreferenced()');
      await markedDaysAgo(client, reused, 45);
      await gameWithCover(client, reused);
      const { rows } = await client.query<{ key: string }>(
        'select stored_files_sweep(1000) as key',
      );
      expect(rows.some((row) => row.key.includes(reused))).toBe(false);
      expect(await state(client, reused)).toEqual({ unreferenced: true, swept: false });
    }, owner.pool));

  it('refuses the owner every other change: other columns, evidence files, deletes', () =>
    rolledBack(async (client) => {
      const image = await file(client, 'catalog_image', 60);
      const receipt = await file(client, 'deposit_receipt', 60);
      expect(
        await violation(client, 'update stored_files set width = 1 where id = $1', [image]),
      ).toMatch(/stored_files is append-only: UPDATE/);
      await client.query(`select set_config('vertex.stored_files_sweep', 'on', true)`);
      expect(
        await violation(client, 'update stored_files set width = 1 where id = $1', [image]),
      ).toMatch(/stored_files is append-only: UPDATE/);
      expect(
        await violation(
          client,
          'update stored_files set unreferenced_since = now() where id = $1',
          [receipt],
        ),
      ).toMatch(/stored_files is append-only: UPDATE/);
      expect(
        await violation(client, 'update stored_files set swept_at = now() where id = $1', [image]),
      ).toMatch(/stored_files is append-only: UPDATE/);
      expect(await violation(client, 'delete from stored_files where id = $1', [image])).toMatch(
        /stored_files is append-only: DELETE/,
      );
    }, owner.pool));

  it('lets the app role run both functions but change no row itself', () =>
    rolledBack(async (client) => {
      const image = await file(client, 'catalog_image', 60);
      expect(await violation(client, 'select stored_files_mark_unreferenced()')).toBeNull();
      expect(await violation(client, 'select stored_files_sweep(10)')).toBeNull();
      expect(
        await violation(client, 'update stored_files set swept_at = now() where id = $1', [image]),
      ).toMatch(/permission denied/);
      expect(await violation(client, 'select stored_files_sweep(0)')).toMatch(
        /batch must be between/,
      );
    }));
});
