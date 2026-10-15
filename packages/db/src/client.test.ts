import { afterAll, describe, expect, it } from 'vitest';
import { APP_POOL_LIMITS, createDatabase } from './client.js';
import { testDatabaseUrl } from './testing.js';

const limited = createDatabase(testDatabaseUrl(), {
  ...APP_POOL_LIMITS,
  connectionTimeoutMillis: 500,
});

afterAll(() => limited.close());

describe('the limits of the app pools (F3-4 safeguard)', () => {
  it('sets the lock timeout on every connection', async () => {
    const { rows } = await limited.pool.query('show lock_timeout');
    expect(rows).toEqual([{ lock_timeout: '15s' }]);
  });

  it('fails a wait for a connection instead of queueing for ever', async () => {
    const pool = createDatabase(testDatabaseUrl(), { connectionTimeoutMillis: 200 });
    // A transaction holding the only connections reads through the pool: the F3-4 slip.
    const held = await Promise.all(Array.from({ length: 10 }, () => pool.pool.connect()));
    try {
      await expect(pool.pool.query('select 1')).rejects.toThrow(/timeout/);
    } finally {
      for (const client of held) client.release();
      await pool.close();
    }
  });
});
