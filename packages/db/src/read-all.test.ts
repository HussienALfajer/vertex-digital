import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase, readAll } from './client.js';
import { testDatabaseUrl } from './testing.js';

/*
 * `readAll` (launch hardening, 2026-10-14): independent reads run in parallel through the pool and
 * one after another in a transaction, whose single client runs one query at a time (pg warns since
 * 8.20 and refuses from 9). `no-concurrent-queries.setup.ts` fails any file that triggers pg's
 * warning, this one included.
 */

const { db, close } = createDatabase(testDatabaseUrl());
afterAll(close);

/** A read of about `ms` that logs when it starts and ends. */
function timed(log: string[], name: string, ms: number) {
  return async () => {
    log.push(`start ${name}`);
    await db.execute(sql`select pg_sleep(${ms / 1000})`);
    log.push(`end ${name}`);
    return name;
  };
}

describe('readAll', () => {
  it('runs the reads one after another in a transaction, results in order', async () => {
    const log: string[] = [];
    const results = await db.transaction((tx) =>
      readAll(tx, [
        async () => {
          log.push('start a');
          const [row] = (await tx.execute(sql`select pg_sleep(0.03), 1 as n`)).rows;
          log.push('end a');
          return row?.n;
        },
        async () => {
          log.push('start b');
          const [row] = (await tx.execute(sql`select 2 as n`)).rows;
          log.push('end b');
          return row?.n;
        },
        () => null,
      ]),
    );
    expect(results).toEqual([1, 2, null]);
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b']);
  });

  it('runs the reads in parallel through the pool', async () => {
    const log: string[] = [];
    const results = await readAll(db, [timed(log, 'a', 50), timed(log, 'b', 10)]);
    expect(results).toEqual(['a', 'b']);
    expect(log.slice(0, 2)).toEqual(['start a', 'start b']);
  });

  it('keeps a transaction quiet where Promise.all queued queries on its client', async () => {
    // The worker's startup warning (2026-10-14): many reads on one transaction's client.
    const rows = await db.transaction((tx) =>
      readAll(
        tx,
        Array.from({ length: 5 }, (_, index) => () => tx.execute(sql`select ${index}::int as n`)),
      ),
    );
    expect(rows.map((result) => result.rows[0]?.n)).toEqual([0, 1, 2, 3, 4]);
  });
});
