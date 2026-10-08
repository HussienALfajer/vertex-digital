import {
  DEPOSIT_FLAG_DETAILS,
  type DepositFlagCode,
  floorToWholeCents,
  USDT_METHODS,
  type UsdtCheckError,
} from '@vertex-digital/contracts';
import {
  creditUsdtDeposit,
  customers,
  depositFlags,
  deposits,
  paymentReferenceOwner,
  recordAudit,
  type Transaction,
  usdtDeposits,
  usdtTransfers,
} from '@vertex-digital/db';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { queueEmail } from '../../core/email/outbox.js';
import type { TransferFacts } from './usdt-assess.js';

/*
 * The writes shared by the verifier and the scanner (S04 rules U7, U10, U11). Each runs inside
 * the caller's transaction, after the caller locked the deposit and checked its state.
 */

type DepositRow = typeof deposits.$inferSelect;
type TransferRow = typeof usdtTransfers.$inferSelect;

/**
 * Records `transfer` once (`unique (method, txid)` absorbs a second insert, by the scanner or the
 * verifier, edge case 6) and returns its row.
 */
export async function recordTransfer(
  tx: Transaction,
  transfer: TransferFacts,
  source: 'scan' | 'txid',
): Promise<{ row: TransferRow; inserted: boolean }> {
  const [inserted] = await tx
    .insert(usdtTransfers)
    .values({
      method: transfer.method,
      txid: transfer.txid,
      fromAddress: transfer.fromAddress,
      toAddress: transfer.toAddress,
      rawAmount: transfer.raw.toString(),
      amountUnits: transfer.amountUnits,
      blockNumber: transfer.blockNumber,
      blockTime: transfer.blockTime,
      source,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { row: inserted, inserted: true };
  const [existing] = await tx
    .select()
    .from(usdtTransfers)
    .where(and(eq(usdtTransfers.method, transfer.method), eq(usdtTransfers.txid, transfer.txid)));
  if (!existing) throw new Error(`Transfer ${transfer.txid} was neither inserted nor found`);
  return { row: existing, inserted: false };
}

/**
 * True when another deposit is bound to the transfer, or its TXID is claimed on either network
 * (an S02 manual deposit, or a credit): a final outcome for this deposit, never a retry.
 */
export async function transferHeldElsewhere(
  tx: Transaction,
  transfer: TransferRow,
  depositId: string,
): Promise<boolean> {
  const [bound] = await tx
    .select({ depositId: usdtDeposits.depositId })
    .from(usdtDeposits)
    .where(and(eq(usdtDeposits.transferId, transfer.id), ne(usdtDeposits.depositId, depositId)));
  if (bound) return true;
  for (const method of USDT_METHODS) {
    if (await paymentReferenceOwner(tx, method, transfer.txid)) return true;
  }
  return false;
}

export interface Binding {
  deposit: DepositRow;
  transfer: TransferRow;
  /** Empty for an exact match (rule U7); else the review's reasons (rule U11). */
  flags: DepositFlagCode[];
  txidSource: 'customer' | 'scan';
  /** The deposit's own `payAmountUnits`, for the `amount_mismatch` details. */
  payAmountUnits: number;
  depositMethod: TransferFacts['method'];
}

/**
 * Binds a `submitted` deposit to its transfer and settles it: an exact match is credited at once
 * (rule U7: the transfer is final), anything else goes to review with its flags (rule U11).
 * Returns the outcome.
 */
export async function bindAndSettle(
  tx: Transaction,
  boss: PgBoss,
  binding: Binding,
): Promise<'credited' | 'review'> {
  const { deposit, transfer, flags } = binding;
  const exact = flags.length === 0;
  await tx
    .update(usdtDeposits)
    .set({
      txid: transfer.txid,
      txidSource: binding.txidSource,
      transferId: transfer.id,
      checkStatus: exact ? 'confirming' : 'review',
      checkError: null,
      lastCheckedAt: sql`now()`,
    })
    .where(eq(usdtDeposits.depositId, deposit.id));
  await recordAudit(tx, {
    action: 'deposit.transfer_bound',
    actorKind: 'system',
    actorId: null,
    channel: 'worker',
    entityType: 'deposit',
    entityId: deposit.id,
    details: {
      depositId: deposit.id,
      transferId: transfer.id,
      txid: transfer.txid,
      source: binding.txidSource,
      receivedUnits: transfer.amountUnits,
      match: exact ? 'exact' : 'review',
      flags,
    },
  });
  if (!exact) {
    for (const code of flags) {
      await tx
        .insert(depositFlags)
        .values({ depositId: deposit.id, code, details: flagDetails(code, binding) })
        .onConflictDoNothing();
    }
    return 'review';
  }
  const credited = await creditUsdtDeposit(tx, {
    depositId: deposit.id,
    transfer: {
      id: transfer.id,
      method: transfer.method as TransferFacts['method'],
      txid: transfer.txid,
      amountUnits: transfer.amountUnits,
    },
    // An exact match carries the declared whole cents; the tail goes to `deposit_rounding`.
    creditedUsdUnits: floorToWholeCents(transfer.amountUnits),
    decision: { by: 'system' },
  });
  const [customer] = await tx
    .select({ email: customers.email })
    .from(customers)
    .where(eq(customers.id, deposit.customerId));
  if (!customer) throw new Error(`Deposit ${deposit.id} has no customer`);
  // The amount only; never the TXID or an address (S04 "Jobs and integrations").
  await queueEmail(tx, boss, {
    to: customer.email,
    template: 'customer_deposit_credited',
    customerId: deposit.customerId,
    params: {
      at: (credited.deposit.decidedAt as Date).toISOString(),
      depositId: deposit.id,
      referenceCode: deposit.referenceCode,
      creditedUsdUnits: credited.deposit.creditedUsdUnits as number,
    },
  });
  // A02: paying `awaiting_balance` orders after a credit hooks in here (S08/S09).
  return 'credited';
}

function flagDetails(code: DepositFlagCode, binding: Binding) {
  const { transfer } = binding;
  const details =
    code === 'amount_mismatch'
      ? {
          declaredCurrency: 'USD',
          declaredAmountUnits: binding.payAmountUnits,
          receivedCurrency: 'USD',
          receivedAmountUnits: transfer.amountUnits,
        }
      : code === 'wrong_network'
        ? { depositMethod: binding.depositMethod, transferMethod: transfer.method }
        : {
            depositCreatedAt: binding.deposit.createdAt.toISOString(),
            blockTime: transfer.blockTime.toISOString(),
          };
  return DEPOSIT_FLAG_DETAILS[code].parse(details);
}

/**
 * Bounces a `submitted` deposit whose TXID failed (rule U10): back to `pending` with the error
 * for the customer, the TXID cleared, audited; past `expires_at` it then expires (S03 rule SC12).
 * No email: the deposit page shows it.
 */
export async function bounce(
  tx: Transaction,
  deposit: DepositRow,
  txid: string,
  error: UsdtCheckError,
): Promise<'pending' | 'expired'> {
  // The USDT row first: the deposit guard allows the move only with the TXID's failure.
  await tx
    .update(usdtDeposits)
    .set({
      checkStatus: 'awaiting_transfer',
      checkError: error,
      txid: null,
      txidSource: null,
      searchStartedAt: null,
      confirmations: null,
      lastCheckedAt: sql`now()`,
    })
    .where(eq(usdtDeposits.depositId, deposit.id));
  await tx.update(deposits).set({ status: 'pending' }).where(eq(deposits.id, deposit.id));
  await recordAudit(tx, {
    action: 'deposit.txid_bounced',
    actorKind: 'system',
    actorId: null,
    channel: 'worker',
    entityType: 'deposit',
    entityId: deposit.id,
    details: { depositId: deposit.id, txid, error },
  });
  const [expired] = await tx
    .update(deposits)
    .set({ status: 'expired' })
    .where(and(eq(deposits.id, deposit.id), sql`${deposits.expiresAt} <= now()`))
    .returning({ id: deposits.id });
  if (!expired) return 'pending';
  await tx
    .update(usdtDeposits)
    .set({ checkStatus: 'done', checkError: null })
    .where(eq(usdtDeposits.depositId, deposit.id));
  await recordAudit(tx, {
    action: 'deposit.expired',
    actorKind: 'system',
    actorId: null,
    channel: 'worker',
    entityType: 'deposit',
    entityId: deposit.id,
    details: { depositId: deposit.id },
  });
  return 'expired';
}
