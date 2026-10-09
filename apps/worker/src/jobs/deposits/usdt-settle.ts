import {
  DEPOSIT_FLAG_DETAILS,
  type DepositFlagCode,
  floorToWholeCents,
  USDT_METHODS,
  type UsdtCheckError,
} from '@vertex-digital/contracts';
import {
  bossJobSender,
  creditUsdtDeposit,
  depositFlags,
  deposits,
  notifyCustomer,
  paymentReferenceOwner,
  queueDepositCard,
  queuePayWaiting,
  queueTelegramMessage,
  recordAudit,
  type Transaction,
  usdtCandidateMatch,
  usdtDeposits,
  usdtTransfers,
} from '@vertex-digital/db';
import { and, count, eq, ne, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
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
 * The admin's notice of an unmatched transfer (S05 rule TC7): once per transfer (`dedupe_key`
 * `unmatched:<transferId>`), with the sender shortened and the number of candidate deposits.
 */
export async function queueUnmatchedNotice(
  tx: Transaction,
  boss: PgBoss,
  transfer: TransferRow,
): Promise<void> {
  const method = transfer.method as TransferFacts['method'];
  const [candidates] = await tx
    .select({ count: count() })
    .from(usdtDeposits)
    .innerJoin(deposits, eq(deposits.id, usdtDeposits.depositId))
    .where(usdtCandidateMatch(method, transfer.amountUnits));
  const sender = transfer.fromAddress;
  await queueTelegramMessage(tx, bossJobSender(boss), {
    kind: 'usdt_unmatched',
    params: {
      transferId: transfer.id,
      method,
      amountUnits: transfer.amountUnits,
      sender: sender.length > 14 ? `${sender.slice(0, 6)}…${sender.slice(-6)}` : sender,
      candidates: candidates?.count ?? 0,
    },
    dedupeKey: `unmatched:${transfer.id}`,
  });
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
  return txidClaimed(tx, transfer.txid);
}

/** True when `txid` is claimed in `payment_references` under either USDT network. */
export async function txidClaimed(tx: Transaction, txid: string): Promise<boolean> {
  for (const method of USDT_METHODS) {
    if (await paymentReferenceOwner(tx, method, txid)) return true;
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
    // The review's card in Telegram (S05 rule TC1).
    await queueDepositCard(tx, bossJobSender(boss), deposit.id);
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
  // The amount only; never the TXID or an address (S04 "Jobs and integrations", S05 rule NT3).
  await notifyCustomer(tx, bossJobSender(boss), {
    customerId: deposit.customerId,
    event: 'deposit_credited',
    params: {
      depositId: deposit.id,
      referenceCode: deposit.referenceCode,
      creditedUsdUnits: credited.deposit.creditedUsdUnits as number,
    },
  });
  // A02 (S09 rule RS4): the customer's reservations are paid by `orders.pay-waiting`.
  await queuePayWaiting(tx, bossJobSender(boss), deposit.customerId);
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
 * No email: the deposit page shows it. When the customer has opened another `pending` deposit
 * meanwhile (one per customer, rule SC4), it cannot go back: it is rejected `not_received` by the
 * system, with the rejection email (owner, 2026-10-08). Under the customer's creation lock, the
 * one the API's deposit creation takes, so a creation cannot slip in between.
 */
export async function bounce(
  tx: Transaction,
  boss: PgBoss,
  deposit: DepositRow,
  txid: string,
  error: UsdtCheckError,
): Promise<'pending' | 'expired' | 'rejected'> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`deposits:${deposit.customerId}`}))`,
  );
  const [otherPending] = await tx
    .select({ id: deposits.id })
    .from(deposits)
    .where(
      and(
        eq(deposits.customerId, deposit.customerId),
        eq(deposits.status, 'pending'),
        ne(deposits.id, deposit.id),
      ),
    );
  if (otherPending) {
    await rejectBounced(tx, boss, deposit, txid, error);
    return 'rejected';
  }
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

/** The bounce that cannot return to `pending`: a system rejection, audited and emailed. */
async function rejectBounced(
  tx: Transaction,
  boss: PgBoss,
  deposit: DepositRow,
  txid: string,
  error: UsdtCheckError,
): Promise<void> {
  const system = {
    actorKind: 'system',
    actorId: null,
    channel: 'worker',
    entityType: 'deposit',
    entityId: deposit.id,
  } as const;
  await recordAudit(tx, {
    ...system,
    action: 'deposit.txid_bounced',
    details: { depositId: deposit.id, txid, error },
  });
  const [rejected] = await tx
    .update(deposits)
    .set({
      status: 'rejected',
      decidedAt: sql`now()`,
      decidedBy: 'system',
      rejectReason: 'not_received',
    })
    .where(eq(deposits.id, deposit.id))
    .returning();
  if (!rejected) throw new Error(`Deposit ${deposit.id} was not rejected`);
  await tx
    .update(usdtDeposits)
    .set({ checkStatus: 'done', checkError: null, lastCheckedAt: sql`now()` })
    .where(eq(usdtDeposits.depositId, deposit.id));
  await recordAudit(tx, {
    ...system,
    action: 'deposit.rejected',
    reason: `TXID failed (${error}) while another deposit was pending`,
    details: {
      depositId: deposit.id,
      customerId: deposit.customerId,
      rejectReason: 'not_received',
      customerNote: null,
    },
  });
  await notifyCustomer(tx, bossJobSender(boss), {
    customerId: deposit.customerId,
    event: 'deposit_rejected',
    params: { depositId: deposit.id, referenceCode: deposit.referenceCode, reason: 'not_received' },
  });
}
