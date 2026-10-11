import {
  rateFromNumeric,
  TREASURY_ACCOUNTS,
  type TreasuryEndpoint,
  type TreasuryMovement,
  type TreasuryPlace,
  treasuryEndpointOf,
} from '@vertex-digital/contracts';
import { and, desc, eq, or, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Database, Transaction } from '../client.js';
import { ledgerAccounts, orders, treasuryMovements } from '../schema/index.js';

/*
 * Movements as the panel lists them (S13 screens): each with its endpoints, its order's number and
 * its reversal. The admin's name is the API's to add.
 */

type Executor = Database | Transaction;

export type MovementView = Omit<TreasuryMovement, 'adminName'> & {
  adminId: string;
  /** `created_at` as PostgreSQL writes it, for the list's cursor. */
  at: string;
};

function endpoint(code: string): TreasuryEndpoint {
  const found = treasuryEndpointOf(code);
  if (!found) throw new Error(`Account ${code} is no treasury endpoint`);
  return found;
}

async function views(db: Executor, where: SQL | undefined, limit: number): Promise<MovementView[]> {
  const from = alias(ledgerAccounts, 'from_account');
  const to = alias(ledgerAccounts, 'to_account');
  const reversal = alias(treasuryMovements, 'reversal');
  const rows = await db
    .select({
      movement: treasuryMovements,
      fromCode: from.code,
      toCode: to.code,
      orderNumber: orders.number,
      reversedBy: reversal.id,
      at: sql<string>`${treasuryMovements.createdAt}::text`,
    })
    .from(treasuryMovements)
    .innerJoin(from, eq(from.id, treasuryMovements.fromAccountId))
    .innerJoin(to, eq(to.id, treasuryMovements.toAccountId))
    .leftJoin(orders, eq(orders.id, treasuryMovements.orderId))
    .leftJoin(reversal, eq(reversal.reversesMovementId, treasuryMovements.id))
    .where(where)
    .orderBy(desc(treasuryMovements.createdAt), desc(treasuryMovements.id))
    .limit(limit);
  return rows.map(({ movement, fromCode, toCode, orderNumber, reversedBy, at }) => ({
    id: movement.id,
    kind: movement.kind,
    from: endpoint(fromCode),
    to: endpoint(toCode),
    sentUnits: movement.sentUnits,
    sentCurrency: movement.sentCurrency,
    receivedUnits: movement.receivedUnits,
    receivedCurrency: movement.receivedCurrency,
    feeUnits:
      movement.sentCurrency === movement.receivedCurrency
        ? movement.sentUnits - movement.receivedUnits
        : null,
    rate: movement.rate === null ? null : rateFromNumeric(movement.rate),
    outsideCategory: movement.outsideCategory,
    openingBalance: movement.openingBalance,
    order:
      movement.orderId === null ? null : { id: movement.orderId, number: orderNumber as string },
    externalReference: movement.externalReference,
    reason: movement.reason,
    reversesMovementId: movement.reversesMovementId,
    reversedByMovementId: reversedBy,
    journalId: movement.journalId,
    adminId: movement.adminId,
    createdAt: movement.createdAt.toISOString(),
    at,
  }));
}

/** Newest first, strictly after `cursor` when given, touching `place` when given. */
export async function treasuryMovementViews(
  db: Executor,
  query: { place?: TreasuryPlace; after?: SQL; limit: number },
): Promise<MovementView[]> {
  let touching: SQL | undefined;
  if (query.place) {
    const code = TREASURY_ACCOUNTS[query.place].code;
    const [account] = await db
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.code, code));
    if (!account) return [];
    touching = or(
      eq(treasuryMovements.fromAccountId, account.id),
      eq(treasuryMovements.toAccountId, account.id),
    );
  }
  return views(db, and(touching, query.after), query.limit);
}

export async function treasuryMovementView(db: Executor, id: string): Promise<MovementView | null> {
  const [view] = await views(db, eq(treasuryMovements.id, id), 1);
  return view ?? null;
}

/** The order of a typed number (a supplier correction, rule T5), or null. */
export async function orderIdByNumber(db: Executor, number: string): Promise<string | null> {
  const [row] = await db.select({ id: orders.id }).from(orders).where(eq(orders.number, number));
  return row?.id ?? null;
}
