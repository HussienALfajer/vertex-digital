import { monthRange, type StatementEntry, type StatementOrder } from '@vertex-digital/contracts';
import { and, asc, eq, gte, inArray, lt, or, sql } from 'drizzle-orm';
import { type Database, type Executor, readAll, type Transaction } from '../client.js';
import {
  findCustomerWallet,
  timelineAdjustments,
  timelineDeposits,
  walletBalanceAfter,
} from '../ledger/wallet.js';
import { type JobSender, notifyCustomer } from '../notifications/index.js';
import { fieldLines } from '../orders/receipts.js';
import {
  catalogGames,
  catalogInputFields,
  catalogProducts,
  customerNotifications,
  customers,
  ledgerAccounts,
  ledgerJournals,
  ledgerPostings,
  merchantProfiles,
  orders,
} from '../schema/index.js';

/*
 * The monthly statement (S21 F38, ST1–ST4): a merchant's wallet entries of a Damascus month,
 * read from the ledger and never written. A month is cut in write order (`position`), as every
 * running balance is (`walletBalanceAfter`): it starts at the first wallet posting whose journal
 * began in the month and ends before the first one that began after it. A journal whose
 * transaction began just before midnight and wrote after a newer one falls in the later month,
 * so no month ever shows a balance the wallet never had.
 */

const toUnits = (value: string | null | undefined): number => {
  const units = Number(value ?? '0');
  if (!Number.isSafeInteger(units)) throw new RangeError(`Not a safe integer: ${value}`);
  return units;
};

export interface StatementFacts {
  openingUsdUnits: number;
  /**
   * The wallet's balance after the month's last entry, read on its own (`walletBalanceAfter`), to
   * check the equation (ST2); the opening when the month has none.
   */
  closingUsdUnits: number;
  entries: StatementEntry[];
}

/**
 * ST2: the month's opening balance, its entries with their extras, and the closing balance, in
 * one `REPEATABLE READ` read-only snapshot, so a journal committed while it reads never shows in
 * one sum and not the other.
 */
export function statementFacts(
  db: Database,
  customerId: string,
  month: string,
): Promise<StatementFacts> {
  return db.transaction((tx) => statementFactsIn(tx, customerId, month), {
    isolationLevel: 'repeatable read',
    accessMode: 'read only',
  });
}

/** The first wallet posting position whose journal began at or after `instant`; null for none. */
async function firstPositionFrom(
  tx: Transaction,
  wallet: string,
  instant: Date,
): Promise<number | null> {
  const [row] = await tx
    .select({ position: sql<string | null>`min(${ledgerPostings.position})::text` })
    .from(ledgerPostings)
    .innerJoin(ledgerJournals, eq(ledgerJournals.id, ledgerPostings.journalId))
    .where(and(eq(ledgerPostings.accountId, wallet), gte(ledgerJournals.createdAt, instant)));
  return row?.position == null ? null : toUnits(row.position);
}

async function statementFactsIn(
  tx: Transaction,
  customerId: string,
  month: string,
): Promise<StatementFacts> {
  const wallet = await findCustomerWallet(tx, customerId);
  if (wallet === null) return { openingUsdUnits: 0, closingUsdUnits: 0, entries: [] };
  const { start, end } = monthRange(month);
  const from = await firstPositionFrom(tx, wallet, start);
  const until = from === null ? null : await firstPositionFrom(tx, wallet, end);
  const [opening] = await tx
    .select({ sum: sql<string>`coalesce(sum(${ledgerPostings.amountUnits}), 0)::text` })
    .from(ledgerPostings)
    .where(
      and(
        eq(ledgerPostings.accountId, wallet),
        from === null ? undefined : lt(ledgerPostings.position, from),
      ),
    );
  const openingUsdUnits = toUnits(opening?.sum);
  if (from === null) return { openingUsdUnits, closingUsdUnits: openingUsdUnits, entries: [] };
  const position = sql`max(${ledgerPostings.position})`;
  const rows = await tx
    .select({
      journalId: ledgerJournals.id,
      kind: ledgerJournals.kind,
      occurredAt: ledgerJournals.createdAt,
      amount: sql<string>`sum(${ledgerPostings.amountUnits})::text`,
    })
    .from(ledgerPostings)
    .innerJoin(ledgerJournals, eq(ledgerJournals.id, ledgerPostings.journalId))
    .where(
      and(
        eq(ledgerPostings.accountId, wallet),
        gte(ledgerPostings.position, from),
        until === null ? undefined : lt(ledgerPostings.position, until),
      ),
    )
    .groupBy(ledgerJournals.id)
    .orderBy(asc(position));
  const last = rows.at(-1);
  const closingUsdUnits = last
    ? await walletBalanceAfter(tx, wallet, last.journalId)
    : openingUsdUnits;
  if (rows.length === 0) return { openingUsdUnits, closingUsdUnits, entries: [] };

  const journalIds = rows.map((row) => row.journalId);
  const [adjustments, depositsByJournal, ordersByJournal] = await readAll(tx, [
    () => timelineAdjustments(tx, journalIds),
    () => timelineDeposits(tx, journalIds),
    () => statementOrders(tx, journalIds),
  ]);
  let balance = openingUsdUnits;
  const entries = rows.map((row): StatementEntry => {
    const amountUnits = toUnits(row.amount);
    balance += amountUnits;
    const adjustment = adjustments.get(row.journalId);
    const deposit = depositsByJournal.get(row.journalId);
    return {
      occurredAt: row.occurredAt.toISOString(),
      kind: row.kind,
      amountUnits,
      balanceAfterUnits: balance,
      adjustment: adjustment
        ? {
            category: adjustment.category,
            customerNote: adjustment.customerNote,
            reversal: adjustment.reversesAdjustmentId !== null,
          }
        : null,
      deposit: deposit
        ? { method: deposit.method, referenceCode: deposit.referenceCode, syp: deposit.syp }
        : null,
      order: ordersByJournal.orders.get(row.journalId) ?? null,
      checkout: ordersByJournal.checkouts.get(row.journalId) ?? null,
    };
  });
  return { openingUsdUnits, closingUsdUnits, entries };
}

/** The orders of purchase and refund journals with their full player IDs; a checkout's in line order. */
async function statementOrders(
  db: Executor,
  journalIds: string[],
): Promise<{
  orders: Map<string, StatementOrder>;
  checkouts: Map<string, { id: string; orders: StatementOrder[] }>;
}> {
  const rows = await db
    .select({
      id: orders.id,
      number: orders.number,
      gameId: orders.gameId,
      gameNameAr: catalogGames.nameAr,
      productNameAr: catalogProducts.nameAr,
      quantity: orders.quantity,
      fields: orders.fields,
      purchaseJournalId: orders.purchaseJournalId,
      refundJournalId: orders.refundJournalId,
      checkoutId: orders.checkoutId,
      checkoutLine: orders.checkoutLine,
    })
    .from(orders)
    .innerJoin(catalogProducts, eq(catalogProducts.id, orders.productId))
    .innerJoin(catalogGames, eq(catalogGames.id, orders.gameId))
    .where(
      or(
        inArray(orders.purchaseJournalId, journalIds),
        inArray(orders.refundJournalId, journalIds),
      ),
    )
    .orderBy(asc(orders.checkoutLine), asc(orders.id));
  const gameIds = [...new Set(rows.map((row) => row.gameId))];
  const rules =
    gameIds.length === 0
      ? []
      : await db
          .select()
          .from(catalogInputFields)
          .where(inArray(catalogInputFields.gameId, gameIds))
          .orderBy(asc(catalogInputFields.sortOrder));
  const byJournal = new Map<string, StatementOrder>();
  const checkouts = new Map<string, { id: string; orders: StatementOrder[] }>();
  for (const row of rows) {
    const order: StatementOrder = {
      id: row.id,
      number: row.number,
      gameNameAr: row.gameNameAr,
      productNameAr: row.productNameAr,
      quantity: row.quantity,
      fields: fieldLines(
        rules.filter((rule) => rule.gameId === row.gameId),
        row.fields,
        true,
      ),
    };
    if (row.purchaseJournalId && row.checkoutId) {
      const checkout = checkouts.get(row.purchaseJournalId) ?? { id: row.checkoutId, orders: [] };
      checkout.orders.push(order);
      checkouts.set(row.purchaseJournalId, checkout);
    } else if (row.purchaseJournalId) {
      byJournal.set(row.purchaseJournalId, order);
    }
    if (row.refundJournalId) byJournal.set(row.refundJournalId, order);
  }
  return { orders: byJournal, checkouts };
}

/** ST2: the statement's heading: the approved trade name, the account's email and creation. */
export async function statementAccount(
  db: Executor,
  customerId: string,
): Promise<{ tradeName: string; email: string; createdAt: Date } | null> {
  const [row] = await db
    .select({
      tradeName: merchantProfiles.tradeName,
      email: customers.email,
      createdAt: customers.createdAt,
    })
    .from(customers)
    .innerJoin(merchantProfiles, eq(merchantProfiles.customerId, customers.id))
    .where(eq(customers.id, customerId));
  return row ?? null;
}

/** ST4: unarchived merchants with at least one wallet entry in the month, in id order. */
export async function statementEmailMerchants(db: Executor, month: string): Promise<string[]> {
  const { start, end } = monthRange(month);
  const rows = await db
    .selectDistinct({ id: customers.id })
    .from(customers)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.customerId, customers.id))
    .innerJoin(ledgerPostings, eq(ledgerPostings.accountId, ledgerAccounts.id))
    .innerJoin(ledgerJournals, eq(ledgerJournals.id, ledgerPostings.journalId))
    .where(
      and(
        eq(customers.accountType, 'merchant'),
        sql`${customers.archivedAt} is null`,
        gte(ledgerJournals.createdAt, start),
        lt(ledgerJournals.createdAt, end),
      ),
    )
    .orderBy(asc(customers.id));
  return rows.map((row) => row.id);
}

/**
 * ST4 for one merchant: `merchant_statement_ready` once per month (the dedupe key
 * `statement:<customer>:<month>` as an advisory lock, then a notification of that month already
 * written means sent). False when already sent.
 */
export async function sendStatementReady(
  tx: Transaction,
  jobs: JobSender,
  customerId: string,
  month: string,
): Promise<boolean> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`statement:${customerId}:${month}`}))`,
  );
  const [sent] = await tx
    .select({ id: customerNotifications.id })
    .from(customerNotifications)
    .where(
      and(
        eq(customerNotifications.customerId, customerId),
        eq(customerNotifications.event, 'merchant_statement_ready'),
        sql`${customerNotifications.params}->>'month' = ${month}`,
      ),
    )
    .limit(1);
  if (sent) return false;
  await notifyCustomer(tx, jobs, {
    customerId,
    event: 'merchant_statement_ready',
    params: { month },
  });
  return true;
}
