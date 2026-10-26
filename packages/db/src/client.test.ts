import { afterAll, describe, expect, it } from 'vitest';
import { APP_POOL_LIMITS, createDatabase } from './client.js';
import { testDatabaseUrl } from './testing.js';

// The apps' own limits: opening a connection may take seconds while the other suites run.
const limited = createDatabase(testDatabaseUrl(), APP_POOL_LIMITS);

afterAll(() => limited.close());

describe('the limits of the app pools (F3-4 safeguard)', () => {
  it('sets the lock timeout on every connection', async () => {
    const { rows } = await limited.pool.query('show lock_timeout');
    expect(rows).toEqual([{ lock_timeout: '15s' }]);
  });

  it('fails a wait for a connection instead of queueing for ever', async () => {
    // Long enough to open the ten connections while the other suites run (200 ms was not), short
    // enough for the test: the limit is the same for opening a connection and waiting for one,
    // so the refused read takes those 3 seconds (the test's own limit below).
    const pool = createDatabase(testDatabaseUrl(), { connectionTimeoutMillis: 3_000 });
    // A transaction holding the only connections reads through the pool: the F3-4 slip.
    const held = await Promise.all(Array.from({ length: 10 }, () => pool.pool.connect()));
    try {
      await expect(pool.pool.query('select 1')).rejects.toThrow(/timeout/);
    } finally {
      for (const client of held) client.release();
      await pool.close();
    }
  }, 15_000);
});
