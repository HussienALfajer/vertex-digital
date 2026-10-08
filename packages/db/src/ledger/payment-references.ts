import type { PaymentMethod } from '@vertex-digital/contracts';
import { and, eq } from 'drizzle-orm';
import type { Database, Transaction } from '../client.js';
import { paymentReferences } from '../schema/index.js';
import { LedgerError } from './errors.js';

/*
 * Real-world payment references (Sham Cash transaction numbers, TXIDs), claimed once across every
 * record that can credit them (S03 rule SC14).
 */

/** The record that claimed a reference: shown to the admin in the refusal's `details`. */
export interface PaymentReferenceOwner {
  kind: 'adjustment';
  id: string;
}

/** How references compare: trimmed and upper-cased (`' test-001 '` is `TEST-001`). */
export const normalizePaymentReference = (reference: string) => reference.trim().toUpperCase();

/** The record that holds the claim on `reference`, or null when it is free. */
export async function paymentReferenceOwner(
  db: Database | Transaction,
  method: PaymentMethod,
  reference: string,
): Promise<PaymentReferenceOwner | null> {
  const [row] = await db
    .select({ walletAdjustmentId: paymentReferences.walletAdjustmentId })
    .from(paymentReferences)
    .where(
      and(
        eq(paymentReferences.method, method),
        eq(paymentReferences.reference, normalizePaymentReference(reference)),
      ),
    );
  if (!row) return null;
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
  owner: { walletAdjustmentId: string },
): Promise<void> {
  const claimed = await tx
    .insert(paymentReferences)
    .values({
      method,
      reference: normalizePaymentReference(reference),
      walletAdjustmentId: owner.walletAdjustmentId,
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
