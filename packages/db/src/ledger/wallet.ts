import {
  type AdjustmentCategory,
  type AdjustmentDirection,
  type Currency,
  type DepositMethod,
  type JournalKind,
  type LedgerAccountKind,
  type ManualDepositMethod,
  rateFromNumeric,
} from '@vertex-digital/contracts';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Database, Transaction } from '../client.js';
import {
  catalogProducts,
  customers,
  deposits,
  ledgerAccounts,
  ledgerJournals,
  ledgerPostings,
  orders,
  walletAdjustments,
} from '../schema/index.js';

/*
 * Customer wallets and their timeline (S02 rules W1–W5, L1), shared by the API's customer and
 * admin routes. Later specs add their journal kinds' extras next to `adjustment` (S03 deposits,
 * S08 purchases and refunds) without changing the entry's shape.
 */

type Executor = Database | Transaction;

/** The code of a customer's wallet account. */
export const customerWalletCode = (customerId: string) => `customer_wallet:${customerId}`;

/** The id of the customer's wallet account, or null before its first posting (rule W1). */
export async function findCustomerWallet(db: Executor, customerId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.code, customerWalletCode(customerId)));
  return row?.id ?? null;
}

/**
 * The customer's wallet account, created on its first posting inside the posting's transaction
 * (rule W1). Two first postings at once end with the same account: the second insert waits for
 * the first, then does nothing and reads it.
 */
export async function ensureCustomerWallet(tx: Transaction, customerId: string): Promise<string> {
  return ensureAccount(tx, {
    code: customerWalletCode(customerId),
    kind: 'customer_wallet',
    currency: 'USD',
    customerId,
  });
}

/**
 * The customer's wallet, created if needed and locked (`FOR UPDATE`) for the caller's transaction.
 * Every write that both claims a payment reference and credits a wallet takes this lock first,
 * so two such writes for one customer queue here instead of deadlocking on the reference and the
 * wallet in opposite orders (S03 rule SC14).
 */
export async function lockCustomerWallet(tx: Transaction, customerId: string): Promise<string> {
  const wallet = await ensureCustomerWallet(tx, customerId);
  await tx
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.id, wallet))
    .for('update');
  return wallet;
}

/** A system account by its code (`adjustments:<category>`), created on first use (rule J2). */
export async function ensureSystemAccount(
  tx: Transaction,
  account: {
    code: string;
    kind: Exclude<LedgerAccountKind, 'customer_wallet'>;
    currency: Currency;
  },
): Promise<string> {
  return ensureAccount(tx, account);
}

async function ensureAccount(
  tx: Transaction,
  account: { code: string; kind: LedgerAccountKind; currency: Currency; customerId?: string },
): Promise<string> {
  // Any unique index, not only `code`: two first writes can both pass the conflict pre-check, and
  // the second may then meet the wallet's `customer_id` index first. Both name the same account
  // (a wallet's code is made from its customer), which the select below reads.
  await tx.insert(ledgerAccounts).values(account).onConflictDoNothing();
  const [row] = await tx
    .select({ id: ledgerAccounts.id, kind: ledgerAccounts.kind, currency: ledgerAccounts.currency })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.code, account.code));
  if (!row) throw new Error(`Ledger account ${account.code} exists but cannot be read`);
  if (row.kind !== account.kind || row.currency !== account.currency) {
    throw new Error(`Ledger account ${account.code} is a ${row.currency} ${row.kind}`);
  }
  return row.id;
}

const toUnits = (value: string): number => {
  const units = Number(value);
  if (!Number.isSafeInteger(units)) throw new RangeError(`Not a safe integer: ${value}`);
  return units;
};

/** A journal's place on a wallet's timeline: the last write position of its wallet postings. */
const journalPosition = sql<string>`max(${ledgerPostings.position})`;

/**
 * The wallet's balance right after a journal (rule W4): its postings up to and including the
 * journal's, in write order (`ledger_postings.position`). Write order follows the wallet lock, so
 * a debit comes after everything its balance check saw and no running balance is negative; the
 * journal's `created_at` (its transaction's start) would not.
 */
export async function walletBalanceAfter(
  db: Executor,
  accountId: string,
  journalId: string,
): Promise<number> {
  const [row] = await db
    .select({ balance: sql<string>`coalesce(sum(${ledgerPostings.amountUnits}), 0)::text` })
    .from(ledgerPostings)
    .where(
      and(
        eq(ledgerPostings.accountId, accountId),
        sql`${ledgerPostings.position} <= (
          select max(p.position) from ${ledgerPostings} as p
          where p.journal_id = ${journalId} and p.account_id = ${accountId}
        )`,
      ),
    );
  return toUnits(row?.balance ?? '0');
}

/** Where a timeline page starts: strictly before this write position, newest first. */
export interface TimelinePosition {
  position: number;
}

/** An adjustment as the timeline shows it (rule W5); the API picks what each reader sees. */
export interface TimelineAdjustment {
  id: string;
  direction: AdjustmentDirection;
  category: AdjustmentCategory;
  customerNote: string | null;
  reason: string;
  adminId: string;
  depositMethod: ManualDepositMethod | null;
  externalReference: string | null;
  reversesAdjustmentId: string | null;
  reversedByAdjustmentId: string | null;
}

/** A credited deposit as the timeline shows it (rule W5, S03). */
export interface TimelineDeposit {
  id: string;
  method: DepositMethod;
  referenceCode: string;
  /** The pounds received and the rate they were converted at; null when USD was received. */
  syp: { amountUnits: number; rate: string } | null;
  /** A USDT deposit's TXID (S04), for the admin; null for Sham Cash. */
  txid: string | null;
}

/** The order of a `purchase` or `refund` entry (S08 "Money flows"). */
export interface TimelineOrder {
  id: string;
  number: string;
  productNameAr: string;
}

export interface TimelineEntry {
  journalId: string;
  kind: JournalKind;
  occurredAt: Date;
  position: TimelinePosition;
  /** The net signed amount the journal moved on the wallet (rule W3). */
  amountUnits: number;
  balanceAfterUnits: number;
  adjustment: TimelineAdjustment | null;
  deposit: TimelineDeposit | null;
  order: TimelineOrder | null;
}

/**
 * One page of a wallet's timeline (rules W3–W5): one entry per journal that touches the wallet,
 * newest first in write order (`walletBalanceAfter`). The running balance is the balance after the page's
 * newest entry, then each older entry's is the newer one's minus the newer amount (edge case 14).
 * `more` says whether entries older than the page exist.
 */
export async function walletTimeline(
  db: Executor,
  accountId: string,
  page: { after?: TimelinePosition; limit: number },
): Promise<{ entries: TimelineEntry[]; more: boolean }> {
  const rows = await db
    .select({
      journalId: ledgerJournals.id,
      kind: ledgerJournals.kind,
      occurredAt: ledgerJournals.createdAt,
      position: sql<string>`${journalPosition}::text`,
      amount: sql<string>`sum(${ledgerPostings.amountUnits})::text`,
    })
    .from(ledgerPostings)
    .innerJoin(ledgerJournals, eq(ledgerJournals.id, ledgerPostings.journalId))
    .where(eq(ledgerPostings.accountId, accountId))
    .groupBy(ledgerJournals.id)
    .having(page.after ? sql`${journalPosition} < ${page.after.position}` : undefined)
    .orderBy(desc(journalPosition))
    .limit(page.limit + 1);
  const more = rows.length > page.limit;
  const pageRows = rows.slice(0, page.limit);
  const first = pageRows[0];
  if (!first) return { entries: [], more };

  const journalIds = pageRows.map((row) => row.journalId);
  const [balance, adjustments, depositsByJournal, ordersByJournal] = await Promise.all([
    walletBalanceAfter(db, accountId, first.journalId),
    adjustmentsOf(db, journalIds),
    depositsOf(db, journalIds),
    ordersOf(db, journalIds),
  ]);
  let balanceAfter = balance;
  const entries = pageRows.map((row): TimelineEntry => {
    const amountUnits = toUnits(row.amount);
    const entry = {
      journalId: row.journalId,
      kind: row.kind,
      occurredAt: row.occurredAt,
      position: { position: toUnits(row.position) },
      amountUnits,
      balanceAfterUnits: balanceAfter,
      adjustment: adjustments.get(row.journalId) ?? null,
      deposit: depositsByJournal.get(row.journalId) ?? null,
      order: ordersByJournal.get(row.journalId) ?? null,
    };
    balanceAfter -= amountUnits;
    return entry;
  });
  return { entries, more };
}

async function adjustmentsOf(
  db: Executor,
  journalIds: string[],
): Promise<Map<string, TimelineAdjustment>> {
  const reversal = alias(walletAdjustments, 'reversal');
  const rows = await db
    .select({
      journalId: walletAdjustments.journalId,
      id: walletAdjustments.id,
      direction: walletAdjustments.direction,
      category: walletAdjustments.category,
      customerNote: walletAdjustments.customerNote,
      reason: walletAdjustments.reason,
      adminId: walletAdjustments.adminId,
      depositMethod: walletAdjustments.depositMethod,
      externalReference: walletAdjustments.externalReference,
      reversesAdjustmentId: walletAdjustments.reversesAdjustmentId,
      reversedByAdjustmentId: reversal.id,
    })
    .from(walletAdjustments)
    .leftJoin(reversal, eq(reversal.reversesAdjustmentId, walletAdjustments.id))
    .where(inArray(walletAdjustments.journalId, journalIds));
  return new Map(rows.map(({ journalId, ...adjustment }) => [journalId, adjustment]));
}

async function ordersOf(db: Executor, journalIds: string[]): Promise<Map<string, TimelineOrder>> {
  const rows = await db
    .select({
      id: orders.id,
      number: orders.number,
      productNameAr: catalogProducts.nameAr,
      purchaseJournalId: orders.purchaseJournalId,
      refundJournalId: orders.refundJournalId,
    })
    .from(orders)
    .innerJoin(catalogProducts, eq(catalogProducts.id, orders.productId))
    .where(
      or(
        inArray(orders.purchaseJournalId, journalIds),
        inArray(orders.refundJournalId, journalIds),
      ),
    );
  const byJournal = new Map<string, TimelineOrder>();
  for (const { purchaseJournalId, refundJournalId, ...order } of rows) {
    if (purchaseJournalId) byJournal.set(purchaseJournalId, order);
    if (refundJournalId) byJournal.set(refundJournalId, order);
  }
  return byJournal;
}

async function depositsOf(
  db: Executor,
  journalIds: string[],
): Promise<Map<string, TimelineDeposit>> {
  const rows = await db
    .select({
      journalId: deposits.journalId,
      id: deposits.id,
      method: deposits.method,
      referenceCode: deposits.referenceCode,
      transactionNumber: deposits.transactionNumber,
      receivedCurrency: deposits.receivedCurrency,
      receivedAmountUnits: deposits.receivedAmountUnits,
      creditRate: deposits.creditRate,
    })
    .from(deposits)
    .where(inArray(deposits.journalId, journalIds));
  return new Map(
    rows.map((row) => [
      row.journalId as string,
      {
        id: row.id,
        method: row.method,
        referenceCode: row.referenceCode,
        syp:
          row.receivedCurrency === 'SYP' && row.receivedAmountUnits && row.creditRate
            ? { amountUnits: row.receivedAmountUnits, rate: rateFromNumeric(row.creditRate) }
            : null,
        txid: row.method === 'sham_cash' ? null : row.transactionNumber,
      },
    ]),
  );
}

export interface LedgerSummaryRows {
  owedToCustomersUnits: number;
  owedToTestCustomersUnits: number;
  walletsWithBalance: number;
  systemAccounts: {
    kind: LedgerAccountKind;
    code: string;
    currency: Currency;
    balanceUnits: number;
  }[];
}

/**
 * What the store owes its customers and every system account's balance (rule L1), from the
 * postings at read time: real and test customers apart (S01: test customers stay out of reports).
 */
export async function ledgerSummary(db: Executor): Promise<LedgerSummaryRows> {
  const balances = db
    .select({
      id: ledgerAccounts.id,
      kind: ledgerAccounts.kind,
      code: ledgerAccounts.code,
      currency: ledgerAccounts.currency,
      customerId: ledgerAccounts.customerId,
      balance: sql<string>`coalesce(sum(${ledgerPostings.amountUnits}), 0)`.as('balance'),
    })
    .from(ledgerAccounts)
    .leftJoin(ledgerPostings, eq(ledgerPostings.accountId, ledgerAccounts.id))
    .groupBy(ledgerAccounts.id)
    .as('balances');
  const [wallets, systemAccounts] = await Promise.all([
    db
      .select({
        real: sql<string>`coalesce(sum(${balances.balance}) filter (where not ${customers.isTest}), 0)::text`,
        test: sql<string>`coalesce(sum(${balances.balance}) filter (where ${customers.isTest}), 0)::text`,
        withBalance: sql<number>`(count(*) filter (where ${balances.balance} > 0))::int`,
      })
      .from(balances)
      .innerJoin(customers, eq(customers.id, balances.customerId))
      .where(eq(balances.kind, 'customer_wallet')),
    db
      .select({
        kind: balances.kind,
        code: balances.code,
        currency: balances.currency,
        balance: sql<string>`${balances.balance}::text`,
      })
      .from(balances)
      .where(sql`${balances.kind} <> 'customer_wallet'`)
      .orderBy(balances.kind, balances.code),
  ]);
  const totals = wallets[0];
  return {
    owedToCustomersUnits: toUnits(totals?.real ?? '0'),
    owedToTestCustomersUnits: toUnits(totals?.test ?? '0'),
    walletsWithBalance: totals?.withBalance ?? 0,
    systemAccounts: systemAccounts.map(({ balance, ...account }) => ({
      ...account,
      balanceUnits: toUnits(balance),
    })),
  };
}

/** Balances of customers' wallets by customer id; a customer without a wallet holds 0 (rule W1). */
export async function customerWalletBalances(
  db: Executor,
  customerIds: readonly string[],
): Promise<Map<string, number>> {
  if (customerIds.length === 0) return new Map();
  const rows = await db
    .select({
      customerId: ledgerAccounts.customerId,
      balance: sql<string>`coalesce(sum(${ledgerPostings.amountUnits}), 0)::text`,
    })
    .from(ledgerAccounts)
    .leftJoin(ledgerPostings, eq(ledgerPostings.accountId, ledgerAccounts.id))
    .where(inArray(ledgerAccounts.customerId, [...customerIds]))
    .groupBy(ledgerAccounts.id);
  return new Map(rows.map((row) => [row.customerId as string, toUnits(row.balance)]));
}
