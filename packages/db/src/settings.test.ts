import type pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase } from './client.js';
import { newId } from './id.js';

/*
 * The store switches (S05 rule SW1): `store_switch_changes` is append-only. Rows written here stay
 * in the test database; they use a channel and admin id no other test reads.
 */

const connection = createDatabase(process.env.DATABASE_URL as string);
const owner = createDatabase(process.env.DATABASE_OWNER_URL as string);

afterAll(() => Promise.all([connection.close(), owner.close()]));

async function rolledBack(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<void>) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await work(client);
  } finally {
    await client.query('rollback');
    client.release();
  }
}

/** A change inside a rolled-back transaction, so no test leaves a real switch changed. */
const insertChange = (client: pg.PoolClient) =>
  client
    .query<{ id: string; created_at: Date }>(
      `insert into store_switch_changes (id, switch, value, admin_id, channel)
       values ($1, 'sham_cash_paused', true, $2, 'admin') returning id, created_at`,
      [newId(), newId()],
    )
    .then((result) => result.rows[0] as { id: string; created_at: Date });

describe('store_switch_changes', () => {
  it('gives the app role SELECT and INSERT only', async () => {
    const { rows } = await connection.pool.query<{ privileges: Record<string, boolean> }>(
      `select json_object_agg(p, has_table_privilege(current_user, 'store_switch_changes', p))
         as privileges
       from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as p`,
    );
    expect(rows[0]?.privileges).toEqual({
      SELECT: true,
      INSERT: true,
      UPDATE: false,
      DELETE: false,
      TRUNCATE: false,
    });
  });

  it('refuses changing or removing a row, to the app role and the owner', async () => {
    for (const statement of [
      'update store_switch_changes set value = false where id = $1',
      'delete from store_switch_changes where id = $1',
    ]) {
      await rolledBack(connection.pool, async (client) => {
        const change = await insertChange(client);
        await expect(client.query(statement, [change.id])).rejects.toThrow(/permission denied/);
      });
      await rolledBack(owner.pool, async (client) => {
        const change = await insertChange(client);
        await expect(client.query(statement, [change.id])).rejects.toThrow(/is append-only/);
      });
    }
  });

  it('stamps each row with the time of its insert, not of its transaction (rule SW2)', async () => {
    await rolledBack(connection.pool, async (client) => {
      const first = await insertChange(client);
      await client.query('select pg_sleep(0.01)');
      const second = await insertChange(client);
      expect(second.created_at.getTime()).toBeGreaterThan(first.created_at.getTime());
    });
  });
});
