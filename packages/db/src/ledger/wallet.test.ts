import type { AdjustmentCategory, AdjustmentDirection } from '@vertex-digital/contracts';
import { CURRENCY_SCALE } from '@vertex-digital/contracts';
import type pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase, type Transaction } from '../client.js';
import { newId } from '../id.js';
import { customers, walletAdjustments } from '../schema/index.js';
import { postJournal } from './post-journal.js';
import {
  customerWalletBalances,
  ensureCustomerWallet,
  ensureSystemAccount,
  findCustomerWallet,
  ledgerSummary,
  walletBalanceAfter,
  walletTimeline,
} from './wallet.js';

/*
 * Customer wallets, adjustments and the timeline (S02). Rows written here stay in the test
 * database: the ledger and adjustments are append-only. Every test uses new customers and keys.
 */

const connection = createDatabase(process.env.DATABASE_URL as string);
const owner = createDatabase(process.env.DATABASE_OWNER_URL as string);
const { db } = connection;

afterAll(() => Promise.all([connection.close(), owner.close()]));

const DOLLAR = CURRENCY_SCALE.USD;
const ADMIN_ID = newId();

async function customer(isTest = false): Promise<string> {
  const id = newId();
  await db.insert(customers).values({
    id,
    name: 'Test',
    email: `${id}@test.vertex-digital.local`,
    phone: '+963900000000',
    isTest,
  });
  return id;
}

/** Moves `units` between the wallet and the category's account, as an adjustment journal. */
async function adjustmentJournal(
  tx: Transaction,
  customerId: string,
  category: AdjustmentCategory,
  signedUnits: number,
): Promise<string> {
  const wallet = await ensureCustomerWallet(tx, customerId);
  const counter = await ensureSystemAccount(tx, {
    code: `adjustments:${category}`,
    kind: 'adjustments',
    currency: 'USD',
  });
  const { journalId } = await postJournal(tx, {
    idempotencyKey: `test:${newId()}`,
    kind: 'adjustment',
    postings: [
      { accountId: wallet, amountUnits: signedUnits },
      { accountId: counter, amountUnits: -signedUnits },
    ],
  });
  return journalId;
}

interface AdjustmentInput {
  customerId: string;
  direction: AdjustmentDirection;
  amountUnits: number;
  category?: AdjustmentCategory;
  reverses?: string;
  depositMethod?: 'sham_cash' | 'usdt_trc20';
  externalReference?: string;
}

/** Writes an adjustment and its journal, in `tx` or in a transaction of its own. */
async function adjust(input: AdjustmentInput, tx?: Transaction): Promise<string> {
  if (!tx) return db.transaction((own) => adjust(input, own));
  const category = input.category ?? 'correction';
  {
    const signed = input.direction === 'credit' ? input.amountUnits : -input.amountUnits;
    const journalId = await adjustmentJournal(tx, input.customerId, category, signed);
    const id = newId();
    await tx.insert(walletAdjustments).values({
      id,
      customerId: input.customerId,
      direction: input.direction,
      amountUsdUnits: input.amountUnits,
      category,
      reason: 'A test adjustment',
      depositMethod: input.depositMethod ?? null,
      externalReference: input.externalReference ?? null,
      reversesAdjustmentId: input.reverses ?? null,
      journalId,
      idempotencyKey: newId(),
      adminId: ADMIN_ID,
    });
    return id;
  }
}

/** The database's refusal message: Drizzle wraps it as the cause of a "Failed query" error. */
async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    const { cause, message } = error as Error & { cause?: Error };
    return cause?.message ?? message;
  }
  throw new Error('Expected a refusal');
}

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

describe('customer wallets (rule W1)', () => {
  it('exist only once posted to: reading never creates one', async () => {
    const customerId = await customer();
    expect(await findCustomerWallet(db, customerId)).toBeNull();
    expect((await walletTimeline(db, newId(), { limit: 30 })).entries).toEqual([]);
    const wallet = await db.transaction((tx) => ensureCustomerWallet(tx, customerId));
    expect(await findCustomerWallet(db, customerId)).toBe(wallet);
  });

  it('are created once when two first postings race (edge case 1)', async () => {
    const customerId = await customer();
    const ids = await Promise.all(
      [1, 2].map(() =>
        db.transaction(async (tx) => {
          const wallet = await ensureCustomerWallet(tx, customerId);
          await adjustmentJournal(tx, customerId, 'correction', DOLLAR);
          return wallet;
        }),
      ),
    );
    expect(ids[0]).toBe(ids[1]);
    expect((await customerWalletBalances(db, [customerId])).get(customerId)).toBe(2 * DOLLAR);
  });

  it('refuse a system account code taken by another kind', async () => {
    const code = `test:${newId()}`;
    await db.transaction((tx) =>
      ensureSystemAccount(tx, { code, kind: 'adjustments', currency: 'USD' }),
    );
    await expect(
      db.transaction((tx) => ensureSystemAccount(tx, { code, kind: 'refunds', currency: 'USD' })),
    ).rejects.toThrow(/is a USD adjustments/);
  });
});

describe('wallet_adjustments guards', () => {
  it('lets the app role insert and read adjustments, never change or remove them', async () => {
    const { rows } = await connection.pool.query<{ privileges: Record<string, boolean> }>(
      `select json_object_agg(p, has_table_privilege(current_user, 'wallet_adjustments', p))
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

  it.each([
    ['update wallet_adjustments set reason = reason where id = $1', /append-only: UPDATE/],
    ['delete from wallet_adjustments where id = $1', /append-only: DELETE/],
  ])('refuses `%s` to the app role and the owner', async (statement, guard) => {
    const id = await adjust({
      customerId: await customer(),
      direction: 'credit',
      amountUnits: DOLLAR,
    });
    await rolledBack(connection.pool, async (client) => {
      await expect(client.query(statement, [id])).rejects.toThrow(/permission denied/);
    });
    await rolledBack(owner.pool, async (client) => {
      await expect(client.query(statement, [id])).rejects.toThrow(guard);
    });
  });

  it('refuses a reversal that does not mirror its original (rule R1)', async () => {
    const customerId = await customer();
    const original = await adjust({ customerId, direction: 'credit', amountUnits: 5 * DOLLAR });
    expect(
      await refusal(
        adjust({ customerId, direction: 'credit', amountUnits: 5 * DOLLAR, reverses: original }),
      ),
    ).toMatch(/must mirror/);
    expect(
      await refusal(
        adjust({ customerId, direction: 'debit', amountUnits: 4 * DOLLAR, reverses: original }),
      ),
    ).toMatch(/must mirror/);
    expect(
      await refusal(
        adjust({
          customerId,
          direction: 'debit',
          amountUnits: 5 * DOLLAR,
          category: 'test_funds',
          reverses: original,
        }),
      ),
    ).toMatch(/must mirror/);
  });

  it('reverses an adjustment once, and never a reversal (rules R2, R3)', async () => {
    const customerId = await customer();
    // Enough balance for a second reversal to reach the unique index.
    await adjust({ customerId, direction: 'credit', amountUnits: 20 * DOLLAR });
    const original = await adjust({ customerId, direction: 'credit', amountUnits: 5 * DOLLAR });
    const reversal = await adjust({
      customerId,
      direction: 'debit',
      amountUnits: 5 * DOLLAR,
      reverses: original,
    });
    expect(
      await refusal(
        adjust({ customerId, direction: 'debit', amountUnits: 5 * DOLLAR, reverses: original }),
      ),
    ).toMatch(/reverses_adjustment_id_unique/);
    expect(
      await refusal(
        adjust({ customerId, direction: 'credit', amountUnits: 5 * DOLLAR, reverses: reversal }),
      ),
    ).toMatch(/is a reversal and cannot be reversed/);
  });

  it('keeps an external reference unique per method, whatever its case (rule J8)', async () => {
    const customerId = await customer();
    const reference = `REF${newId().slice(-8)}`;
    const manual = {
      customerId,
      direction: 'credit',
      amountUnits: DOLLAR,
      category: 'manual_deposit',
    } as const;
    await adjust({ ...manual, depositMethod: 'sham_cash', externalReference: reference });
    expect(
      await refusal(
        adjust({
          ...manual,
          depositMethod: 'sham_cash',
          externalReference: reference.toLowerCase(),
        }),
      ),
    ).toMatch(/wallet_adjustments_external_reference_unique/);
    await adjust({ ...manual, depositMethod: 'usdt_trc20', externalReference: reference });
  });

  it('needs a method and reference on, and only on, a manual deposit', async () => {
    const customerId = await customer();
    expect(
      await refusal(
        adjust({
          customerId,
          direction: 'credit',
          amountUnits: DOLLAR,
          category: 'manual_deposit',
        }),
      ),
    ).toMatch(/wallet_adjustments_deposit_method_check/);
    expect(
      await refusal(
        adjust({
          customerId,
          direction: 'credit',
          amountUnits: DOLLAR,
          depositMethod: 'sham_cash',
          externalReference: 'X1',
        }),
      ),
    ).toMatch(/wallet_adjustments_deposit_method_check/);
  });

  it('takes whole cents above zero only', async () => {
    const customerId = await customer();
    // postJournal refuses a wallet posting in sub-cents before the row is written.
    await expect(
      adjust({ customerId, direction: 'credit', amountUnits: DOLLAR + 1 }),
    ).rejects.toThrow(/whole cents/);
    await rolledBack(connection.pool, async (client) => {
      await expect(
        client.query(
          `insert into wallet_adjustments
             (id, customer_id, direction, amount_usd_units, category, reason, journal_id,
              idempotency_key, admin_id)
           values ($1, $2, 'credit', 0, 'correction', 'A reason', $3, $4, $5)`,
          [newId(), customerId, newId(), newId(), ADMIN_ID],
        ),
      ).rejects.toThrow(/wallet_adjustments_amount_check/);
    });
  });
});

describe('the timeline (rules W3–W5)', () => {
  it('pages newest first with a running balance stable across pages and equal times', async () => {
    const customerId = await customer();
    // Four journals in one transaction share its time (now()): the journal id orders them.
    await db.transaction(async (tx) => {
      for (const units of [10, 5, -3, 7]) {
        await adjustmentJournal(tx, customerId, 'correction', units * DOLLAR);
      }
    });
    await db.transaction((tx) => adjustmentJournal(tx, customerId, 'correction', -4 * DOLLAR));

    const wallet = (await findCustomerWallet(db, customerId)) as string;
    const first = await walletTimeline(db, wallet, { limit: 2 });
    const last = first.entries.at(-1);
    const second = await walletTimeline(db, wallet, { after: last?.position, limit: 2 });
    const third = await walletTimeline(db, wallet, {
      after: second.entries.at(-1)?.position,
      limit: 2,
    });
    const all = [...first.entries, ...second.entries, ...third.entries];
    expect(all.map((entry) => entry.amountUnits / DOLLAR)).toEqual([-4, 7, -3, 5, 10]);
    expect(all.map((entry) => entry.balanceAfterUnits / DOLLAR)).toEqual([15, 19, 12, 15, 10]);
    expect([first.more, second.more, third.more]).toEqual([true, true, false]);
    expect(await walletBalanceAfter(db, wallet, all[2]?.journalId as string)).toBe(12 * DOLLAR);
  });

  it('shows one entry with the net amount for a journal with two postings on the wallet', async () => {
    const customerId = await customer();
    await db.transaction(async (tx) => {
      const wallet = await ensureCustomerWallet(tx, customerId);
      const counter = await ensureSystemAccount(tx, {
        code: 'adjustments:correction',
        kind: 'adjustments',
        currency: 'USD',
      });
      await postJournal(tx, {
        idempotencyKey: `test:${newId()}`,
        kind: 'adjustment',
        postings: [
          { accountId: wallet, amountUnits: 8 * DOLLAR },
          { accountId: wallet, amountUnits: -3 * DOLLAR },
          { accountId: counter, amountUnits: -5 * DOLLAR },
        ],
      });
    });
    const wallet = (await findCustomerWallet(db, customerId)) as string;
    const { entries } = await walletTimeline(db, wallet, { limit: 30 });
    expect(entries.map((entry) => [entry.amountUnits, entry.balanceAfterUnits])).toEqual([
      [5 * DOLLAR, 5 * DOLLAR],
    ]);
    expect(entries[0]?.adjustment).toBeNull();
  });

  it('carries the adjustment of each entry, and the reversal of a reversed one', async () => {
    const customerId = await customer();
    const original = await adjust({ customerId, direction: 'credit', amountUnits: 9 * DOLLAR });
    const reversal = await adjust({
      customerId,
      direction: 'debit',
      amountUnits: 9 * DOLLAR,
      reverses: original,
    });
    const wallet = (await findCustomerWallet(db, customerId)) as string;
    const { entries } = await walletTimeline(db, wallet, { limit: 30 });
    expect(entries.map((entry) => entry.adjustment)).toEqual([
      expect.objectContaining({ id: reversal, reversesAdjustmentId: original, direction: 'debit' }),
      expect.objectContaining({
        id: original,
        reversedByAdjustmentId: reversal,
        reason: 'A test adjustment',
        adminId: ADMIN_ID,
      }),
    ]);
  });
});

describe('the ledger summary (rule L1)', () => {
  it('splits what is owed to real and test customers and lists the system accounts', async () => {
    // One REPEATABLE READ snapshot, rolled back: other test files' postings cannot move the totals.
    const [real, test] = [await customer(false), await customer(true)];
    const rollback = new Error('rollback');
    const run = db.transaction(
      async (tx) => {
        const before = await ledgerSummary(tx);
        await adjust({ customerId: real, direction: 'credit', amountUnits: 3 * DOLLAR }, tx);
        await adjust({ customerId: test, direction: 'credit', amountUnits: 2 * DOLLAR }, tx);
        const after = await ledgerSummary(tx);
        expect(after.owedToCustomersUnits - before.owedToCustomersUnits).toBe(3 * DOLLAR);
        expect(after.owedToTestCustomersUnits - before.owedToTestCustomersUnits).toBe(2 * DOLLAR);
        expect(after.walletsWithBalance - before.walletsWithBalance).toBe(2);
        expect(after.systemAccounts).toContainEqual(
          expect.objectContaining({ kind: 'adjustments', code: 'adjustments:correction' }),
        );
        expect(after.systemAccounts.some((account) => account.kind === 'customer_wallet')).toBe(
          false,
        );
        throw rollback;
      },
      { isolationLevel: 'repeatable read' },
    );
    await expect(run).rejects.toBe(rollback);
  });

  it('gives no balance for customers without a wallet', async () => {
    expect(await customerWalletBalances(db, [])).toEqual(new Map());
    expect(await customerWalletBalances(db, [await customer()])).toEqual(new Map());
  });
});
