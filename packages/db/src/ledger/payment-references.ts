import { isUsdtMethod, type PaymentMethod } from '@vertex-digital/contracts';
import { and, eq, inArray, or, type SQLWrapper, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../client.js';
import { deposits, paymentReferences, walletAdjustments } from '../schema/index.js';
import { LedgerError } from './errors.js';

/*
 * Real-world payment references (Sham Cash transaction numbers, TXIDs), claimed once across every
 * record that can credit them (S03 rule SC14).
 */

/** The record that claimed a reference: shown to the admin in the refusal's `details`. */
export interface PaymentReferenceOwner {
  kind: 'adjustment' | 'deposit';
  id: string;
}

/**
 * How references compare: trimmed and upper-cased by PostgreSQL (`' test-001 '` is `TEST-001`),
 * as the table's check, the S02 backfill and S02's unique index do, whatever the characters.
 */
const normalized = (reference: string) => sql<string>`upper(btrim(${reference}))`;

/**
 * The forms a reference may be stored in. A TXID (S04) is claimed as its 64 hex characters, as
 * `txidSchema` normalizes it; S02 manual deposits entered in development before S04 may hold it
 * with `0x`, so both forms are looked up. No such row exists in production (Phase 1 was not
 * deployed before S04).
 */
const storedForms = (method: PaymentMethod, reference: string) =>
  isUsdtMethod(method)
    ? [normalized(reference), sql<string>`'0X' || upper(btrim(${reference}))`]
    : [normalized(reference)];

/** The record that holds the claim on `reference`, or null when it is free. */
export async function paymentReferenceOwner(
  db: Database | Transaction,
  method: PaymentMethod,
  reference: string,
): Promise<PaymentReferenceOwner | null> {
  const [row] = await db
    .select({
      walletAdjustmentId: paymentReferences.walletAdjustmentId,
      depositId: paymentReferences.depositId,
    })
    .from(paymentReferences)
    .where(
      and(
        eq(paymentReferences.method, method),
        or(...storedForms(method, reference).map((form) => eq(paymentReferences.reference, form))),
      ),
    )
    .limit(1);
  if (!row) return null;
  if (row.depositId) return { kind: 'deposit', id: row.depositId };
  if (!row.walletAdjustmentId) throw new Error('A payment reference has no owner');
  return { kind: 'adjustment', id: row.walletAdjustmentId };
}

/**
 * Claims `reference` for its owner inside the owner's transaction, or refuses with
 * `EXTERNAL_REFERENCE_TAKEN` and the record that holds it. A parallel claim of the same
 * reference waits for the first transaction: if it commits, this one is refused; if it rolls
 * back, this one claims. A refusal leaves the caller's transaction usable.
 */
export async function claimPaymentReference(
  tx: Transaction,
  method: PaymentMethod,
  reference: string,
  owner: { walletAdjustmentId: string } | { depositId: string },
): Promise<void> {
  if (isUsdtMethod(method)) {
    const legacy = await paymentReferenceOwner(tx, method, reference);
    if (legacy) {
      throw new LedgerError('EXTERNAL_REFERENCE_TAKEN', 'The TXID is already claimed', legacy);
    }
  }
  const claimed = await tx
    .insert(paymentReferences)
    .values({
      method,
      reference: normalized(reference),
      ...owner,
    })
    .onConflictDoNothing({ target: [paymentReferences.method, paymentReferences.reference] })
    .returning({ id: paymentReferences.id });
  if (claimed.length > 0) return;
  throw new LedgerError(
    'EXTERNAL_REFERENCE_TAKEN',
    'The payment reference is already claimed',
    await paymentReferenceOwner(tx, method, reference),
  );
}

/**
 * True when the TXID `txid` (64 lower-case hex characters) is claimed under `method`, in either
 * stored form: a filter for the USDT transfer lists (S04 rule U13), without their module reading
 * the claims table itself. Pass fully qualified expressions: the claims table also has `method`.
 */
export const txidClaimed = (method: SQLWrapper, txid: SQLWrapper) =>
  sql<boolean>`exists (select 1 from payment_references as claim
    where claim.method = ${method}
      and claim.reference in (upper(${txid}), '0X' || upper(${txid})))`;

/** The record that claimed a TXID, and its customer. */
export interface TxidHolder extends PaymentReferenceOwner {
  customerId: string;
}

/**
 * The holders of claimed TXIDs (64 lower-case hex characters) of one network, by TXID: the
 * deposit or adjustment that claimed each, and its customer (S04 rule U13).
 */
export async function txidHolders(
  db: Database | Transaction,
  method: PaymentMethod,
  txids: readonly string[],
): Promise<Map<string, TxidHolder>> {
  if (txids.length === 0) return new Map();
  const forms = txids.flatMap((txid) => [txid.toUpperCase(), `0X${txid.toUpperCase()}`]);
  const rows = await db
    .select({
      reference: paymentReferences.reference,
      depositId: paymentReferences.depositId,
      adjustmentId: paymentReferences.walletAdjustmentId,
      depositCustomerId: deposits.customerId,
      adjustmentCustomerId: walletAdjustments.customerId,
    })
    .from(paymentReferences)
    .leftJoin(deposits, eq(deposits.id, paymentReferences.depositId))
    .leftJoin(walletAdjustments, eq(walletAdjustments.id, paymentReferences.walletAdjustmentId))
    .where(and(eq(paymentReferences.method, method), inArray(paymentReferences.reference, forms)));
  const holders = new Map<string, TxidHolder>();
  for (const row of rows) {
    const txid = row.reference.replace(/^0X/, '').toLowerCase();
    if (row.depositId && row.depositCustomerId) {
      holders.set(txid, { kind: 'deposit', id: row.depositId, customerId: row.depositCustomerId });
    } else if (row.adjustmentId && row.adjustmentCustomerId) {
      holders.set(txid, {
        kind: 'adjustment',
        id: row.adjustmentId,
        customerId: row.adjustmentCustomerId,
      });
    }
  }
  return holders;
}
