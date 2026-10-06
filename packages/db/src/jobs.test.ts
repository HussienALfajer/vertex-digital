import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase } from './client.js';
import { createPgBoss, PG_BOSS_SCHEMA } from './jobs.js';

/*
 * pg-boss under the role split of ADR 0014: the global setup installed its tables as the owner;
 * the app role sends and works jobs, and cannot change the schema.
 */

const connection = createDatabase(process.env.DATABASE_URL as string);

afterAll(() => connection.close());

describe('pg-boss under the app role', () => {
  it('is installed in its own schema, owned by the owner role', async () => {
    const { rows } = await connection.pool.query<{ owner: string; app: string }>(
      `select pg_get_userbyid(n.nspowner) as owner, current_user as app
         from pg_namespace n where n.nspname = $1`,
      [PG_BOSS_SCHEMA],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.owner).not.toBe(rows[0]?.app);
    const { rows: owned } = await connection.pool.query(
      `select tablename from pg_tables where schemaname = $1 and tableowner = current_user`,
      [PG_BOSS_SCHEMA],
    );
    expect(owned).toEqual([]);
  });

  it('cannot create a table in the pg-boss schema', async () => {
    await expect(
      connection.pool.query(`create table ${PG_BOSS_SCHEMA}.intruder (id int)`),
    ).rejects.toThrow(/permission denied/);
  });

  it('creates a queue, sends a job and works it', async () => {
    const boss = createPgBoss(process.env.DATABASE_URL as string, {
      supervise: false,
      schedule: false,
    });
    const queue = `test.${randomUUID()}`;
    await boss.start();
    try {
      await boss.createQueue(queue);
      const id = await boss.send(queue, { hello: 'world' });
      const [job] = await boss.fetch<{ hello: string }>(queue);
      expect(job).toMatchObject({ id, data: { hello: 'world' } });
      await boss.complete(queue, id as string);
    } finally {
      await boss.deleteQueue(queue);
      await boss.stop({ graceful: false });
    }
  });
});
