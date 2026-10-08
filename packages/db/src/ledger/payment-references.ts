import type { PaymentMethod } from '@vertex-digital/contracts';
import { and, eq, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../client.js';
import { paymentReferences } from '../schema/index.js';
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
        eq(paymentReferences.reference, normalized(reference)),
      ),
    );
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
