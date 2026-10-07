import type {
  AdjustmentCategory,
  AdjustmentDirection,
  Currency,
  JournalKind,
  LedgerAccountKind,
  ManualDepositMethod,
} from '@vertex-digital/contracts';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Database, Transaction } from '../client.js';
import {
  customers,
  ledgerAccounts,
  ledgerJournals,
  ledgerPostings,
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
  await tx
    .insert(ledgerAccounts)
    .values(account)
    .onConflictDoNothing({ target: ledgerAccounts.code });
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

/**
 * The wallet's balance right after a journal (rule W4): its postings in every journal up to and
 * including this one, in timeline order (time, then journal id).
 */
export async function walletBalanceAfter(
  db: Executor,
  accountId: string,
  journalId: string,
): Promise<number> {
  const [row] = await db
    .select({ balance: sql<string>`coalesce(sum(${ledgerPostings.amountUnits}), 0)::text` })
    .from(ledgerPostings)
    .innerJoin(ledgerJournals, eq(ledgerJournals.id, ledgerPostings.journalId))
    .where(
      and(
        eq(ledgerPostings.accountId, accountId),
        sql`(${ledgerJournals.createdAt}, ${ledgerJournals.id}) <= (
          select j.created_at, j.id from ${ledgerJournals} as j where j.id = ${journalId}
        )`,
      ),
    );
  return toUnits(row?.balance ?? '0');
}

/** Where a timeline page starts: strictly after this entry, newest first. */
export interface TimelinePosition {
  /** The journal's `created_at` as PostgreSQL writes it, with its microseconds. */
  at: string;
  journalId: string;
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

export interface TimelineEntry {
  journalId: string;
  kind: JournalKind;
  occurredAt: Date;
  position: TimelinePosition;
  /** The net signed amount the journal moved on the wallet (rule W3). */
  amountUnits: number;
  balanceAfterUnits: number;
  adjustment: TimelineAdjustment | null;
}

/**
 * One page of a wallet's timeline (rules W3–W5): one entry per journal that touches the wallet,
 * newest first, ties broken by journal id. The running balance is the balance after the page's
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
      at: sql<string>`${ledgerJournals.createdAt}::text`,
      amount: sql<string>`sum(${ledgerPostings.amountUnits})::text`,
    })
    .from(ledgerPostings)
    .innerJoin(ledgerJournals, eq(ledgerJournals.id, ledgerPostings.journalId))
    .where(
      and(
        eq(ledgerPostings.accountId, accountId),
        page.after
          ? sql`(${ledgerJournals.createdAt}, ${ledgerJournals.id}) < (${page.after.at}::timestamptz, ${page.after.journalId}::uuid)`
          : undefined,
      ),
    )
    .groupBy(ledgerJournals.id)
    .orderBy(desc(ledgerJournals.createdAt), desc(ledgerJournals.id))
    .limit(page.limit + 1);
  const more = rows.length > page.limit;
  const pageRows = rows.slice(0, page.limit);
  const first = pageRows[0];
  if (!first) return { entries: [], more };

  const [balance, adjustments] = await Promise.all([
    walletBalanceAfter(db, accountId, first.journalId),
    adjustmentsOf(
      db,
      pageRows.map((row) => row.journalId),
    ),
  ]);
  let balanceAfter = balance;
  const entries = pageRows.map((row): TimelineEntry => {
    const amountUnits = toUnits(row.amount);
    const entry = {
      journalId: row.journalId,
      kind: row.kind,
      occurredAt: row.occurredAt,
      position: { at: row.at, journalId: row.journalId },
      amountUnits,
      balanceAfterUnits: balanceAfter,
      adjustment: adjustments.get(row.journalId) ?? null,
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
