import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../client.js';
import { newId } from '../id.js';

/*
 * The database's own guards on the ledger (migrations 0000 and 0001, ADR 0003 and 0014), tested
 * with raw SQL so nothing in `postJournal` helps them. `connection` is the app role, as the API
 * and the worker; `owner` is the owner role, to prove the trigger refuses even the table owner.
 * Ledger rows written here stay in the test database: it is append-only by design. Every run uses
 * new accounts and keys.
 */

const connection = createDatabase(process.env.DATABASE_URL as string);
const owner = createDatabase(process.env.DATABASE_OWNER_URL as string);

afterAll(() => Promise.all([connection.close(), owner.close()]));

type Client = pg.PoolClient;
type Posting = [accountId: string, currency: 'USD' | 'SYP', amountUnits: number];

/** Runs `work` in a transaction that is always rolled back, as the app role or the owner role. */
async function rolledBack(
  work: (client: Client) => Promise<void>,
  pool: pg.Pool = connection.pool,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await work(client);
  } finally {
    await client.query('rollback');
    client.release();
  }
}

/** Runs `work` in a transaction and commits it: rejects when the commit is refused. */
async function committed(work: (client: Client) => Promise<void>): Promise<void> {
  const client = await connection.pool.connect();
  try {
    await client.query('begin');
    await work(client);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

async function createAccount(kind: string, currency: 'USD' | 'SYP'): Promise<string> {
  const id = newId();
  await connection.pool.query(
    'insert into ledger_accounts (id, code, kind, currency) values ($1, $2, $3, $4)',
    [id, `test:${id}`, kind, currency],
  );
  return id;
}

/** Inserts a journal declaring `declared` postings (by default as many as it gets), then them. */
async function insertJournal(
  client: Client,
  postings: Posting[],
  declared = postings.length,
): Promise<string> {
  const journalId = newId();
  await client.query(
    `insert into ledger_journals (id, idempotency_key, kind, posting_count)
     values ($1, $2, 'adjustment', $3)`,
    [journalId, `test:${journalId}`, declared],
  );
  for (const posting of postings) await insertPosting(client, journalId, posting);
  return journalId;
}

async function insertPosting(
  client: Client,
  journalId: string,
  [accountId, currency, amountUnits]: Posting,
): Promise<void> {
  await client.query(
    `insert into public.ledger_postings (id, journal_id, account_id, currency, amount_units)
     values ($1, $2, $3, $4, $5)`,
    [newId(), journalId, accountId, currency, amountUnits],
  );
}

let usdA: string;
let usdB: string;
let sypA: string;
let sypB: string;
let journalId: string;

beforeAll(async () => {
  [usdA, usdB, sypA, sypB] = await Promise.all([
    createAccount('adjustments', 'USD'),
    createAccount('sales_revenue', 'USD'),
    createAccount('adjustments', 'SYP'),
    createAccount('sham_cash_receipts', 'SYP'),
  ]);
  await committed(async (client) => {
    journalId = await insertJournal(client, [
      [usdA, 'USD', 500],
      [usdB, 'USD', -500],
    ]);
  });
});

describe('ledger privileges', () => {
  it('runs as an app role that is no superuser and owns no table (ADR 0014)', async () => {
    const { rows } = await connection.pool.query(
      `select rolsuper,
              (select count(*)::int from pg_tables where tableowner = current_user) as owned
       from pg_roles where rolname = current_user`,
    );
    expect(rows).toEqual([{ rolsuper: false, owned: 0 }]);
  });

  it('keeps the ledger tables with the owner role, which is no superuser either', async () => {
    const { rows } = await owner.pool.query(
      `select distinct tableowner = current_user as owned, rolsuper
       from pg_tables join pg_roles on rolname = current_user
       where tablename in ('ledger_accounts', 'ledger_journals', 'ledger_postings')`,
    );
    expect(rows).toEqual([{ owned: true, rolsuper: false }]);
  });

  it('lets the app role insert and read the ledger, never change or remove it', async () => {
    const { rows } = await connection.pool.query<{ privileges: Record<string, boolean> }>(
      `select json_object_agg(t || ' ' || p, has_table_privilege(current_user, t, p)) as privileges
       from unnest(array['ledger_accounts', 'ledger_journals', 'ledger_postings']) as t,
            unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as p`,
    );
    expect(rows[0]?.privileges).toEqual({
      'ledger_accounts SELECT': true,
      'ledger_accounts INSERT': true,
      'ledger_accounts UPDATE': true,
      'ledger_accounts DELETE': false,
      'ledger_accounts TRUNCATE': false,
      'ledger_journals SELECT': true,
      'ledger_journals INSERT': true,
      'ledger_journals UPDATE': false,
      'ledger_journals DELETE': false,
      'ledger_journals TRUNCATE': false,
      'ledger_postings SELECT': true,
      'ledger_postings INSERT': true,
      'ledger_postings UPDATE': false,
      'ledger_postings DELETE': false,
      'ledger_postings TRUNCATE': false,
    });
  });

  it('refuses deleting an account: accounts are archived', async () => {
    await rolledBack(async (client) => {
      await expect(
        client.query('delete from ledger_accounts where id = $1', [usdA]),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it('cannot create temporary tables, which could shadow a table a trigger reads', async () => {
    await rolledBack(async (client) => {
      await expect(client.query('create temporary table shadow (id int)')).rejects.toThrow(
        /permission denied to create temporary tables/,
      );
    });
  });

  it('cannot disable the guard or grant the privileges back to itself', async () => {
    await rolledBack(async (client) => {
      await expect(
        client.query('alter table ledger_journals disable trigger ledger_journals_append_only'),
      ).rejects.toThrow(/must be owner/);
    });
    await rolledBack(async (client) => {
      await client.query('grant update, delete on ledger_journals to current_user');
      const { rows } = await client.query(
        `select has_table_privilege(current_user, 'ledger_journals', 'UPDATE') as allowed`,
      );
      expect(rows).toEqual([{ allowed: false }]);
    });
  });
});

describe('append-only trigger', () => {
  it('guards exactly the append-only tables', async () => {
    const { rows } = await connection.pool.query(
      `select distinct c.relname as name from pg_trigger t
       join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
       where p.proname = 'append_only_guard' order by 1`,
    );
    expect(rows.map((row) => row.name)).toEqual([
      'audit_entries',
      'ledger_journals',
      'ledger_postings',
    ]);
  });

  it.each([
    [
      'update ledger_journals set kind = kind where id = $1',
      /ledger_journals is append-only: UPDATE/,
    ],
    ['delete from ledger_journals where id = $1', /ledger_journals is append-only: DELETE/],
    [
      'update ledger_postings set amount_units = amount_units where journal_id = $1',
      /ledger_postings is append-only: UPDATE/,
    ],
    ['delete from ledger_postings where journal_id = $1', /ledger_postings is append-only: DELETE/],
  ])(
    'refuses `%s`: the app role lacks the privilege, the owner meets the trigger',
    async (statement, refusal) => {
      await rolledBack(async (client) => {
        await expect(client.query(statement, [journalId])).rejects.toThrow(/permission denied/);
      });
      await rolledBack(async (client) => {
        await expect(client.query(statement, [journalId])).rejects.toThrow(refusal);
      }, owner.pool);
    },
  );

  it('refuses TRUNCATE to the app role and to the owner', async () => {
    const statement = 'truncate ledger_journals, ledger_postings';
    await rolledBack(async (client) => {
      await expect(client.query(statement)).rejects.toThrow(/permission denied/);
    });
    await rolledBack(async (client) => {
      await expect(client.query(statement)).rejects.toThrow(/is append-only: TRUNCATE/);
    }, owner.pool);
  });
});

describe('journal balance check at commit', () => {
  it('accepts a journal balanced in each of its currencies', async () => {
    await expect(
      committed(async (client) => {
        await insertJournal(client, [
          [usdA, 'USD', 1_000],
          [usdB, 'USD', -1_000],
          [sypA, 'SYP', 250],
          [sypB, 'SYP', -250],
        ]);
      }),
    ).resolves.toBeUndefined();
  });

  it('refuses a journal that does not sum to zero', async () => {
    await expect(
      committed(async (client) => {
        await insertJournal(client, [
          [usdA, 'USD', 100],
          [usdB, 'USD', -90],
        ]);
      }),
    ).rejects.toThrow(/does not balance/);
  });

  it('balances per currency, never across currencies', async () => {
    await expect(
      committed(async (client) => {
        await insertJournal(client, [
          [usdA, 'USD', 100],
          [sypA, 'SYP', -100],
        ]);
      }),
    ).rejects.toThrow(/does not balance/);
  });

  it('refuses a journal that declares fewer than two postings', async () => {
    await rolledBack(async (client) => {
      await expect(insertJournal(client, [[usdA, 'USD', 100]])).rejects.toThrow(
        /ledger_journals_posting_count_check/,
      );
    });
  });

  it('refuses a journal with fewer postings than it declares, or none', async () => {
    await expect(
      committed(async (client) => {
        await insertJournal(client, [[usdA, 'USD', 100]], 2);
      }),
    ).rejects.toThrow(/has 1 postings but declares 2/);
    await expect(
      committed(async (client) => {
        await insertJournal(client, [], 2);
      }),
    ).rejects.toThrow(/has 0 postings but declares 2/);
  });

  it('refuses postings added later to a committed journal, even a balanced pair', async () => {
    await expect(
      committed(async (client) => {
        await insertPosting(client, journalId, [usdA, 'USD', 500_000_000]);
        await insertPosting(client, journalId, [usdB, 'USD', -500_000_000]);
      }),
    ).rejects.toThrow(/has 4 postings but declares 2/);
  });

  it('reads the real postings even when the session has a temporary table of the same name', async () => {
    // As the owner, which may create temporary tables (the app role may not, below).
    const client = await owner.pool.connect();
    try {
      await client.query(
        'create temporary table ledger_postings (journal_id uuid, currency text, amount_units bigint)',
      );
      await client.query('begin');
      const forged = await insertJournal(client, [[usdA, 'USD', 700]], 2);
      await client.query(
        // Two rows summing to zero: what a check reading the temporary table would accept.
        `insert into pg_temp.ledger_postings values ($1, 'USD', 700), ($1, 'USD', -700)`,
        [forged],
      );
      await expect(client.query('commit')).rejects.toThrow(/has 1 postings but declares 2/);
    } finally {
      await client.query('rollback');
      await client.query('drop table if exists pg_temp.ledger_postings');
      client.release();
    }
  });

  it('stamps a journal with the insert time, whatever the insert says', async () => {
    await rolledBack(async (client) => {
      const id = newId();
      await client.query(
        `insert into ledger_journals (id, idempotency_key, kind, posting_count, created_at)
         values ($1, $2, 'adjustment', 2, '2020-01-01T00:00:00Z')`,
        [id, `test:${id}`],
      );
      const { rows } = await client.query(
        'select created_at = now() as stamped from ledger_journals where id = $1',
        [id],
      );
      expect(rows).toEqual([{ stamped: true }]);
    });
  });
});

describe('ledger constraints', () => {
  it('refuses a posting in another currency than its account', async () => {
    await rolledBack(async (client) => {
      await expect(insertJournal(client, [[usdA, 'SYP', 100]], 2)).rejects.toThrow(
        /ledger_postings_account_currency_fk/,
      );
    });
  });

  it('refuses a zero posting', async () => {
    await rolledBack(async (client) => {
      await expect(insertJournal(client, [[usdA, 'USD', 0]], 2)).rejects.toThrow(
        /ledger_postings_amount_check/,
      );
    });
  });

  it('refuses a repeated idempotency key', async () => {
    await rolledBack(async (client) => {
      await expect(
        client.query(
          `insert into ledger_journals (id, idempotency_key, kind, posting_count)
           values ($1, $2, 'adjustment', 2)`,
          [newId(), `test:${journalId}`],
        ),
      ).rejects.toThrow(/ledger_journals_idempotency_key_unique/);
    });
  });

  it('keeps every customer wallet in USD', async () => {
    await expect(createAccount('customer_wallet', 'SYP')).rejects.toThrow(
      /ledger_accounts_wallet_usd_check/,
    );
  });

  it.each([["kind = 'refunds'"], ["currency = 'SYP'"], ["code = 'renamed'"]])(
    'never changes an account identity (%s)',
    async (change) => {
      await rolledBack(async (client) => {
        await expect(
          client.query(`update ledger_accounts set ${change} where id = $1`, [usdB]),
        ).rejects.toThrow(/never change/);
      });
    },
  );

  it('lets an account be archived', async () => {
    await rolledBack(async (client) => {
      const result = await client.query(
        'update ledger_accounts set archived_at = now(), updated_at = now() where id = $1',
        [usdA],
      );
      expect(result.rowCount).toBe(1);
    });
  });
});
