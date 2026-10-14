import {
  CURRENCY_SCALE,
  type ReconciliationCheck,
  TREASURY_ACCOUNTS,
  type TreasuryEndpoint,
} from '@vertex-digital/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database, type Transaction } from '../client.js';
import { newId } from '../id.js';
import { ensureCustomerWallet, ensureSystemAccount, postJournal } from '../ledger/index.js';
import {
  customers,
  reconciliationExplanations,
  reconciliationResults,
  reconciliationRuns,
  usdtTransfers,
  walletAdjustments,
} from '../schema/index.js';
import { recordMovement, reverseMovement } from '../treasury/index.js';
import {
  placeBooks,
  shamCashCountCheck,
  supplierBalanceCheck,
  usdtBalanceCheck,
} from './external.js';
import { internalChecks } from './internal.js';
import type { CheckResult } from './types.js';

/*
 * The reconciliation (S13 rules RN1–RN9, C1–C9, E1–E5). The test database holds every other
 * suite's rows, some of them deliberately odd (journals posted without their records), so a check
 * is asserted on the ids it lists: a planted fault is listed, a correct record is not. Faults are
 * planted as the owner in a transaction that is rolled back, and the checks read inside it.
 */

const connection = createDatabase(process.env.DATABASE_URL as string);
const owner = createDatabase(process.env.DATABASE_OWNER_URL as string);
const { db } = connection;

afterAll(() => Promise.all([connection.close(), owner.close()]));

const USD = CURRENCY_SCALE.USD;
const actor = { adminId: newId(), ipAddress: null, userAgent: null };

class Rollback extends Error {}

async function rolledBack<T>(target: Database, work: (tx: Transaction) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await target
    .transaction(async (tx) => {
      result = await work(tx);
      throw new Rollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });
  return result as T;
}

/** The result of one check and subject among a run's results. */
function resultOf(results: CheckResult[], check: ReconciliationCheck, subject?: string) {
  const result = results.find(
    (item) => item.check === check && (subject === undefined || item.subject === subject),
  );
  if (!result) throw new Error(`No ${check} result`);
  return result;
}

const offendingIds = (result: CheckResult) => result.details.offending.map((item) => item.id);

/** A journal written by hand as the owner: no `postJournal` checks, never committed. */
async function rawJournal(
  tx: Transaction,
  kind: string,
  postings: { accountId: string; currency: 'USD' | 'SYP'; amountUnits: number }[],
  postingCount = postings.length,
): Promise<string> {
  const id = newId();
  await tx.execute(sql`insert into ledger_journals (id, idempotency_key, kind, posting_count)
    values (${id}, ${`test:${id}`}, ${kind}, ${postingCount})`);
  for (const posting of postings) {
    await tx.execute(sql`insert into ledger_postings (id, journal_id, account_id, currency, amount_units)
      values (${newId()}, ${id}, ${posting.accountId}, ${posting.currency}, ${posting.amountUnits})`);
  }
  return id;
}

const system = (tx: Transaction, endpoint: TreasuryEndpoint) =>
  ensureSystemAccount(tx, TREASURY_ACCOUNTS[endpoint]);

async function customer(tx: Transaction): Promise<string> {
  const id = newId();
  await tx.insert(customers).values({
    id,
    name: 'Reconciliation',
    email: `${id}@test.vertex-digital.local`,
    phone: '+963900000000',
  });
  return id;
}

function transfer(from: TreasuryEndpoint, to: TreasuryEndpoint, units: number, overrides = {}) {
  return {
    idempotencyKey: newId(),
    kind: 'transfer' as const,
    from,
    to,
    sentUnits: units,
    receivedUnits: units,
    outsideCategory:
      from.startsWith('outside') || to.startsWith('outside') ? ('owner' as const) : null,
    openingBalance: false,
    orderId: null,
    externalReference: null,
    reason: 'Reconciliation test',
    ...overrides,
  };
}

describe('runs, results and settings (migrations 0044, 0045)', () => {
  const insertRun = (tx: Transaction, values: Partial<typeof reconciliationRuns.$inferInsert>) =>
    tx
      .transaction(async (savepoint) => {
        const [row] = await savepoint
          .insert(reconciliationRuns)
          .values({ trigger: 'manual', adminId: actor.adminId, ...values })
          .returning();
        return row;
      })
      .catch(
        (error: unknown) =>
          (error as { cause?: { message?: string } }).cause?.message ?? String(error),
      );

  it('runs one at a time, one nightly run per day, with the admin of a manual run', async () => {
    await rolledBack(db, async (tx) => {
      // Any committed running run (none outside a worker) would refuse the first insert too.
      const first = await insertRun(tx, {});
      expect(first).toMatchObject({ status: 'running' });
      expect(await insertRun(tx, {})).toMatch(/reconciliation_runs_running_idx/);
      await tx.execute(
        sql`update reconciliation_runs set status = 'finished', finished_at = now() where id = ${(first as { id: string }).id}`,
      );
      const date = '1990-01-02';
      await insertRun(tx, {
        trigger: 'schedule',
        businessDate: date,
        adminId: null,
        status: 'finished',
        finishedAt: new Date(),
      });
      expect(
        await insertRun(tx, {
          trigger: 'schedule',
          businessDate: date,
          adminId: null,
          status: 'finished',
          finishedAt: new Date(),
        }),
      ).toMatch(/business_date_unique/);
      expect(await insertRun(tx, { trigger: 'schedule', adminId: null })).toMatch(
        /business_date_check/,
      );
      expect(await insertRun(tx, { trigger: 'count', adminId: null })).toMatch(/admin_check/);
      expect(await insertRun(tx, { status: 'finished' })).toMatch(/finished_check/);
    });
  });

  it('changes an ended run only to stamp its alert, once, and never deletes one', async () => {
    await rolledBack(owner.db, async (tx) => {
      const [run] = await tx
        .insert(reconciliationRuns)
        .values({ trigger: 'manual', adminId: actor.adminId })
        .returning();
      const id = run?.id as string;
      const attempt = (statement: ReturnType<typeof sql>) =>
        tx
          .transaction(async (savepoint) => {
            await savepoint.execute(statement);
            return null;
          })
          .catch(
            (error: unknown) =>
              (error as { cause?: { message?: string } }).cause?.message ?? String(error),
          );
      expect(
        await attempt(
          sql`update reconciliation_runs set mismatch_count = 2, recheck_at = now() where id = ${id}`,
        ),
      ).toBeNull();
      expect(
        await attempt(sql`update reconciliation_runs set trigger = 'count' where id = ${id}`),
      ).toMatch(/fixed/);
      expect(
        await attempt(
          sql`update reconciliation_runs set status = 'finished', finished_at = now() where id = ${id}`,
        ),
      ).toBeNull();
      expect(
        await attempt(sql`update reconciliation_runs set mismatch_count = 3 where id = ${id}`),
      ).toMatch(/ended run/);
      expect(
        await attempt(sql`update reconciliation_runs set alerted_at = now() where id = ${id}`),
      ).toBeNull();
      expect(
        await attempt(
          sql`update reconciliation_runs set alerted_at = now() + interval '1 hour' where id = ${id}`,
        ),
      ).toMatch(/ended run/);
      expect(await attempt(sql`delete from reconciliation_runs where id = ${id}`)).toMatch(
        /never deleted/,
      );
    });
    await expect(
      connection.pool.query('delete from reconciliation_runs where false'),
    ).rejects.toThrow(/permission denied/);
  });

  it('keeps results, explanations and settings append-only, one explanation per result', async () => {
    const result = await db.transaction(async (tx) => {
      const [run] = await tx
        .insert(reconciliationRuns)
        .values({
          trigger: 'manual',
          adminId: actor.adminId,
          status: 'failed',
          finishedAt: new Date(),
          failure: 'Test',
        })
        .returning();
      const [row] = await tx
        .insert(reconciliationResults)
        .values({
          runId: run?.id as string,
          check: 'ledger_total',
          subject: 'ledger:USD',
          status: 'ok',
          details: { offending: [], lines: [], reason: null },
        })
        .returning();
      await tx
        .insert(reconciliationExplanations)
        .values({ resultId: row?.id as string, note: 'Checked it', adminId: actor.adminId });
      return row?.id as string;
    });
    await expect(
      db
        .insert(reconciliationExplanations)
        .values({ resultId: result, note: 'Twice over', adminId: actor.adminId }),
    ).rejects.toThrow();
    for (const target of [connection, owner]) {
      for (const statement of [
        'update reconciliation_results set status = status where id = $1',
        'delete from reconciliation_results where id = $1',
        'update reconciliation_explanations set note = note where result_id = $1',
        'update reconciliation_settings set count_stale_days = 8 where $1::uuid is not null',
      ]) {
        await expect(target.pool.query(statement, [result])).rejects.toThrow(
          /permission denied|append-only/,
        );
      }
    }
    const { rows } = await db.execute<{ tolerance: string; days: number }>(sql`
      select tolerance_usd_units::text as tolerance, count_stale_days as days from reconciliation_settings
      where admin_id is null order by created_at limit 1`);
    expect(rows[0]).toEqual({ tolerance: String(USD), days: 7 });
  });
});

describe('internal checks (C1–C9)', () => {
  it('lists planted faults in the ledger: unbalanced, short, negative wallets, wrong kinds (C1–C4)', async () => {
    await rolledBack(owner.db, async (tx) => {
      const fees = await system(tx, 'supplier_corrections');
      const outside = await system(tx, 'outside_usd');
      const unbalanced = await rawJournal(tx, 'treasury', [
        { accountId: fees, currency: 'USD', amountUnits: 5 },
        { accountId: outside, currency: 'USD', amountUnits: -4 },
      ]);
      const short = await rawJournal(
        tx,
        'treasury',
        [
          { accountId: fees, currency: 'USD', amountUnits: 7 },
          { accountId: outside, currency: 'USD', amountUnits: -7 },
        ],
        3,
      );
      const buyer = await customer(tx);
      const wallet = await ensureCustomerWallet(tx, buyer);
      const revenue = await ensureSystemAccount(tx, {
        code: 'sales_revenue:USD',
        kind: 'sales_revenue',
        currency: 'USD',
      });
      const refunds = await ensureSystemAccount(tx, {
        code: 'refunds:USD',
        kind: 'refunds',
        currency: 'USD',
      });
      const wrongKind = await rawJournal(tx, 'purchase', [
        { accountId: wallet, currency: 'USD', amountUnits: -10_000 },
        { accountId: refunds, currency: 'USD', amountUnits: 10_000 },
      ]);
      const orphanPurchase = await rawJournal(tx, 'purchase', [
        { accountId: wallet, currency: 'USD', amountUnits: -10_000 },
        { accountId: revenue, currency: 'USD', amountUnits: 10_000 },
      ]);

      const { results, snapshotPosition } = await internalChecks(tx);
      expect(snapshotPosition).toBeGreaterThan(0);
      const balance = resultOf(results, 'journal_balance');
      expect(balance.status).toBe('mismatch');
      expect(offendingIds(balance)).toEqual(expect.arrayContaining([unbalanced, short]));
      expect(resultOf(results, 'ledger_total', 'ledger:USD')).toMatchObject({ status: 'mismatch' });
      expect(offendingIds(resultOf(results, 'wallet_non_negative'))).toContain(buyer);
      expect(offendingIds(resultOf(results, 'account_journal_kinds'))).toContain(wrongKind);
      expect(offendingIds(resultOf(results, 'order_purchase', 'orders'))).toContain(orphanPurchase);
      expect(resultOf(results, 'order_purchase', 'sales_revenue:USD').status).toBe('mismatch');
      // Every check and subject has one result.
      const keys = results.map((result) => `${result.check}/${result.subject}`);
      expect(new Set(keys).size).toBe(keys.length);
    });
  });

  it('lists journals without their records (C5–C9)', async () => {
    await rolledBack(owner.db, async (tx) => {
      const buyer = await customer(tx);
      const wallet = await ensureCustomerWallet(tx, buyer);
      const account = (code: string, kind: string) =>
        ensureSystemAccount(tx, { code, kind: kind as never, currency: 'USD' });
      const cost = await rawJournal(tx, 'cost_of_goods', [
        {
          accountId: await account('cost_of_goods:USD', 'cost_of_goods'),
          currency: 'USD',
          amountUnits: -3,
        },
        { accountId: await system(tx, 'supplier:fake'), currency: 'USD', amountUnits: 3 },
      ]);
      const refund = await rawJournal(tx, 'refund', [
        { accountId: wallet, currency: 'USD', amountUnits: 10_000 },
        {
          accountId: await account('refunds:USD', 'refunds'),
          currency: 'USD',
          amountUnits: -10_000,
        },
      ]);
      const deposit = await rawJournal(tx, 'deposit', [
        { accountId: wallet, currency: 'USD', amountUnits: 10_000 },
        { accountId: await system(tx, 'sham_cash_usd'), currency: 'USD', amountUnits: -10_000 },
      ]);
      const adjustment = await rawJournal(tx, 'adjustment', [
        { accountId: wallet, currency: 'USD', amountUnits: 10_000 },
        {
          accountId: await account('adjustments:correction', 'adjustments'),
          currency: 'USD',
          amountUnits: -10_000,
        },
      ]);
      const treasury = await rawJournal(tx, 'treasury', [
        { accountId: await system(tx, 'outside_usd'), currency: 'USD', amountUnits: 10_000 },
        { accountId: await system(tx, 'supplier:fake'), currency: 'USD', amountUnits: -10_000 },
      ]);
      const { results } = await internalChecks(tx);
      expect(offendingIds(resultOf(results, 'attempt_cost'))).toContain(cost);
      expect(offendingIds(resultOf(results, 'order_refund', 'orders'))).toContain(refund);
      expect(offendingIds(resultOf(results, 'deposit_credit'))).toContain(deposit);
      expect(offendingIds(resultOf(results, 'manual_journals'))).toEqual(
        expect.arrayContaining([adjustment, treasury]),
      );
    });
  });

  it('passes a correct movement and adjustment, and lists one whose journal was changed (C9)', async () => {
    await rolledBack(owner.db, async (tx) => {
      const { movement } = await recordMovement(
        tx,
        transfer('usdt_trc20', 'supplier:fake', 20 * USD, { receivedUnits: 19 * USD }),
        actor,
      );
      const { movement: reversal } = await reverseMovement(
        tx,
        { movementId: movement.id, idempotencyKey: newId(), reason: 'Reverse it' },
        actor,
      );
      const exchange = await recordMovement(
        tx,
        transfer('sham_cash_syp', 'usdt_bep20', 130_000_00, { receivedUnits: 10 * USD }),
        actor,
      );
      const buyer = await customer(tx);
      const wallet = await ensureCustomerWallet(tx, buyer);
      const counter = await ensureSystemAccount(tx, {
        code: 'adjustments:compensation',
        kind: 'adjustments',
        currency: 'USD',
      });
      const adjustmentId = newId();
      const { journalId } = await postJournal(tx, {
        idempotencyKey: `adjustment:${adjustmentId}`,
        kind: 'adjustment',
        postings: [
          { accountId: wallet, amountUnits: 50_000 },
          { accountId: counter, amountUnits: -50_000 },
        ],
      });
      await tx.insert(walletAdjustments).values({
        id: adjustmentId,
        customerId: buyer,
        direction: 'credit',
        amountUsdUnits: 50_000,
        category: 'compensation',
        reason: 'Correct adjustment',
        journalId,
        idempotencyKey: newId(),
        adminId: actor.adminId,
      });
      const clean = offendingIds(resultOf((await internalChecks(tx)).results, 'manual_journals'));
      for (const id of [movement.id, reversal.id, exchange.movement.id, adjustmentId])
        expect(clean).not.toContain(id);

      // A posting added to the exchange's journal (never committed) makes it wrong.
      await tx.execute(sql`insert into ledger_postings (id, journal_id, account_id, currency, amount_units)
        values (${newId()}, ${exchange.movement.journalId}, ${await system(tx, 'outside_usd')}, 'USD', 1)`);
      const after = (await internalChecks(tx)).results;
      expect(offendingIds(resultOf(after, 'manual_journals'))).toContain(exchange.movement.id);
      expect(offendingIds(resultOf(after, 'journal_balance'))).toContain(
        exchange.movement.journalId,
      );
    });
  });
});

describe('external checks (E1–E4)', () => {
  it('skips a place without an opening, then compares within the range and the tolerance (E2)', async () => {
    await rolledBack(db, async (tx) => {
      const check = (actualUnits: number) =>
        supplierBalanceCheck(tx, { supplier: 'manual', actualUnits, toleranceUsdUnits: USD });
      // Tests elsewhere never record a standing opening on the manual supplier.
      expect(await check(0)).toMatchObject({
        status: 'skipped',
        details: { reason: 'opening_missing' },
      });
      await recordMovement(
        tx,
        transfer('outside_usd', 'supplier:manual', 200 * USD, { openingBalance: true }),
        actor,
      );
      const books = await placeBooks(tx, 'supplier:manual');
      expect(await check(books)).toMatchObject({
        status: 'ok',
        booksUnits: books,
        allowedHighUnits: books,
      });
      expect(await check(books + USD)).toMatchObject({ status: 'ok', differenceUnits: USD });
      const off = await check(books + 2 * USD);
      expect(off).toMatchObject({
        status: 'mismatch',
        differenceUnits: 2 * USD,
        offendingCount: 1,
      });
    });
  });

  it('allows the uncredited transfers in the USDT range, until booked as unclaimed (E3)', async () => {
    await rolledBack(db, async (tx) => {
      const network = 'usdt_bep20';
      const check = (actualUnits: number) =>
        usdtBalanceCheck(tx, { network, actualUnits, toleranceUsdUnits: USD });
      await recordMovement(
        tx,
        transfer('outside_usd', network, 10 * USD, { openingBalance: true }),
        actor,
      );
      const books = await placeBooks(tx, network);
      // Other suites leave uncredited transfers on the network: the range starts above them.
      const elsewhere = ((await check(books)).allowedHighUnits ?? 0) - books;
      const txid = newId().replaceAll('-', '').padEnd(64, '0');
      const [transferRow] = await tx
        .insert(usdtTransfers)
        .values({
          method: network,
          txid,
          fromAddress: '0x1111111111111111111111111111111111111111',
          toAddress: '0x2222222222222222222222222222222222222222',
          rawAmount: '5000000000000000000',
          amountUnits: 5 * USD,
          blockNumber: 1,
          // The oldest: the result lists 50 lines, oldest first, and other suites leave more.
          blockTime: new Date('2020-01-01T00:00:00Z'),
          source: 'scan',
        })
        .returning();
      const withTransfer = await check(books + 5 * USD);
      expect(withTransfer.status).toBe('ok');
      expect(withTransfer.details.lines).toContainEqual({
        kind: 'uncredited_transfer',
        id: transferRow?.id,
        amountUnits: 5 * USD,
      });
      expect((await check(books - 2 * USD)).status).toBe('mismatch');
      await recordMovement(
        tx,
        transfer('outside_usd', network, 5 * USD, {
          outsideCategory: 'unclaimed_receipt',
          externalReference: txid,
        }),
        actor,
      );
      const booked = await check(books + 5 * USD);
      expect(booked).toMatchObject({
        status: 'ok',
        booksUnits: books + 5 * USD,
        allowedHighUnits: books + 5 * USD + elsewhere,
      });
      expect(booked.details.lines.map((line) => line.id)).not.toContain(transferRow?.id);
    });
  });

  it('compares a Sham Cash count with the books (E4)', async () => {
    await rolledBack(db, async (tx) => {
      const check = (countedUnits: number) =>
        shamCashCountCheck(tx, { currency: 'SYP', countedUnits, toleranceUnits: 13_000_00 });
      // Before an opening the count is skipped, but keeps the amount typed (its replay reads it).
      expect(await check(5_000_00)).toMatchObject({
        status: 'skipped',
        actualUnits: 5_000_00,
        differenceUnits: null,
        details: { reason: 'opening_missing' },
      });
      await recordMovement(
        tx,
        transfer('outside_syp', 'sham_cash_syp', 1_000_000_00, { openingBalance: true }),
        actor,
      );
      const books = await placeBooks(tx, 'sham_cash_syp');
      expect(await check(books)).toMatchObject({ status: 'ok', currency: 'SYP' });
      expect(await check(books - 13_000_00)).toMatchObject({ status: 'ok' });
      expect(await check(books - 13_000_01)).toMatchObject({
        status: 'mismatch',
        differenceUnits: -13_000_01,
      });
    });
  });
});
