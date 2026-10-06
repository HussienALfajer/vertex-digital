import { eq, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../client.js';
import { ledgerPostings } from '../schema/index.js';

/** An account's balance in integer units of its currency: the sum of its postings (ADR 0003). */
export async function accountBalance(
  db: Database | Transaction,
  accountId: string,
): Promise<number> {
  const [row] = await db
    .select({ balance: sql<string>`coalesce(sum(${ledgerPostings.amountUnits}), 0)::text` })
    .from(ledgerPostings)
    .where(eq(ledgerPostings.accountId, accountId));
  const balance = Number(row?.balance);
  if (!Number.isSafeInteger(balance)) {
    throw new RangeError(`The balance of ${accountId} is not a safe integer: ${row?.balance}`);
  }
  return balance;
}
