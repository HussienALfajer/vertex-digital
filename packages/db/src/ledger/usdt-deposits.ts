import {
  type DepositFlagCode,
  USD_CENT,
  USDT_RESERVATION_GRACE_DAYS,
  type UsdtMethod,
  type UsdtTransferState,
} from '@vertex-digital/contracts';
import { and, eq, or, type SQL, sql } from 'drizzle-orm';
import { recordAudit } from '../audit/record-audit.js';
import type { Transaction } from '../client.js';
import { deposits, usdtDeposits } from '../schema/index.js';
import { type PostedDepositCredit, postUsdtDepositCredit } from './deposits.js';
import { claimPaymentReference, txidClaimed } from './payment-references.js';
import { lockCustomerWallet } from './wallet.js';

/*
 * The credit of a USDT deposit (S04 rule U7): the one write path shared by the worker's automatic
 * credit of an exact match and the admin's approval of a review (rule U15).
 */

/**
 * A USDT deposit whose amount is reserved (rules U3, U4): open, or closed (expired, cancelled,
 * credited or rejected) less than 7 days ago. A closed deposit's last change is its closing, so
 * `updated_at` dates it; an expired one is never closed before `expires_at`. Keeping credited
 * amounts reserved too means a customer's second payment of the same amount is never credited
 * to someone else's new deposit (edge case 3). Used over `usdt_deposits` joined to `deposits`.
 */
export const usdtReserved = sql<boolean>`(${usdtDeposits.depositOpen}
  or greatest(${deposits.updatedAt}, ${deposits.expiresAt})
    > now() - make_interval(days => ${USDT_RESERVATION_GRACE_DAYS}))`;

/**
 * The candidate deposits of a transfer (S04 rules U11, U13): the network's reserved deposits with
 * that exact amount, or with the same tail (an exchange that took a whole-dollar fee). Shared by
 * the panel's lists and the bot's unmatched notice (S05 rule TC7).
 */
export function usdtCandidateMatch(method: UsdtMethod, amountUnits: number): SQL | undefined {
  const tail = amountUnits % USD_CENT;
  return and(
    eq(usdtDeposits.method, method),
    or(
      eq(usdtDeposits.payAmountUnits, amountUnits),
      tail > 0 ? eq(usdtDeposits.tailUnits, tail) : undefined,
    ),
    usdtReserved,
  );
}

/**
 * A recorded transfer's state (rule U13), for the lists and the badge: `credited` once its TXID is
 * claimed (by a deposit or an S02 manual deposit), `bound` while an open deposit holds it, else
 * `unmatched` (a rejected deposit leaves its transfer unmatched: its owner can still be credited).
 * Written with qualified names: it is used in select lists, where Drizzle drops table names.
 */
export const usdtTransferState = sql<UsdtTransferState>`case
  when ${txidClaimed(sql`usdt_transfers.method`, sql`usdt_transfers.txid`)} then 'credited'
  when exists (select 1 from usdt_deposits as bound
    where bound.transfer_id = usdt_transfers.id and bound.deposit_open) then 'bound'
  else 'unmatched' end`;

/** The transfer bound to the deposit, as recorded in `usdt_transfers`. */
export interface BoundUsdtTransfer {
  id: string;
  method: UsdtMethod;
  txid: string;
  /** In USD units, floored from the raw on-chain sum. */
  amountUnits: number;
}

export type UsdtCreditDecision =
  | { by: 'system' }
  | {
      by: 'admin';
      adminId: string;
      idempotencyKey: string;
      acknowledgedFlags: DepositFlagCode[];
      internalNote: string | null;
      ipAddress: string | null;
      userAgent: string | null;
    };

export interface UsdtCredit {
  depositId: string;
  transfer: BoundUsdtTransfer;
  /** Whole cents, at most the transfer's amount: the declared amount, or the received floored. */
  creditedUsdUnits: number;
  decision: UsdtCreditDecision;
}

export type CreditedUsdtDeposit = PostedDepositCredit & { deposit: typeof deposits.$inferSelect };

/**
 * Credits a `submitted` USDT deposit bound to `transfer`, inside the caller's transaction:
 * 1. the deposit row locked and checked (`submitted`, bound to this transfer);
 * 2. the customer's wallet locked, before the claim, as every write that claims and credits;
 * 3. the TXID claimed under the transfer's network (refused with `EXTERNAL_REFERENCE_TAKEN`);
 * 4. the journal (money flow M1); 5–6. the deposit credited and its check `done`; 7. the audit.
 * The caller queues the email (step 8) and runs the after-commit hook.
 */
export async function creditUsdtDeposit(
  tx: Transaction,
  credit: UsdtCredit,
): Promise<CreditedUsdtDeposit> {
  const [deposit] = await tx
    .select()
    .from(deposits)
    .where(eq(deposits.id, credit.depositId))
    .for('update');
  const [usdt] = await tx
    .select({ transferId: usdtDeposits.transferId })
    .from(usdtDeposits)
    .where(eq(usdtDeposits.depositId, credit.depositId));
  if (deposit?.status !== 'submitted' || usdt?.transferId !== credit.transfer.id) {
    throw new Error(`Deposit ${credit.depositId} is not submitted and bound to the transfer`);
  }
  await lockCustomerWallet(tx, deposit.customerId);
  await claimPaymentReference(tx, credit.transfer.method, credit.transfer.txid, {
    depositId: deposit.id,
  });
  const posted = await postUsdtDepositCredit(tx, {
    depositId: deposit.id,
    customerId: deposit.customerId,
    transferMethod: credit.transfer.method,
    receivedUnits: credit.transfer.amountUnits,
    creditedUsdUnits: credit.creditedUsdUnits,
  });
  const { decision } = credit;
  const [updated] = await tx
    .update(deposits)
    .set({
      status: 'credited',
      decidedAt: sql`now()`,
      decidedBy: decision.by,
      transactionNumber: credit.transfer.txid,
      receivedCurrency: 'USD',
      receivedAmountUnits: credit.transfer.amountUnits,
      creditedUsdUnits: credit.creditedUsdUnits,
      journalId: posted.journalId,
      ...(decision.by === 'admin' && {
        adminId: decision.adminId,
        decisionIdempotencyKey: decision.idempotencyKey,
      }),
    })
    .where(eq(deposits.id, deposit.id))
    .returning();
  if (!updated) throw new Error(`Deposit ${deposit.id} was not credited`);
  await tx
    .update(usdtDeposits)
    .set({ checkStatus: 'done', lastCheckedAt: sql`now()` })
    .where(eq(usdtDeposits.depositId, deposit.id));
  await recordAudit(tx, {
    action: 'deposit.credited',
    ...(decision.by === 'admin'
      ? {
          actorKind: 'admin',
          actorId: decision.adminId,
          channel: 'admin',
          reason: decision.internalNote,
          ipAddress: decision.ipAddress,
          userAgent: decision.userAgent,
        }
      : { actorKind: 'system', actorId: null, channel: 'worker' }),
    entityType: 'deposit',
    entityId: deposit.id,
    details: {
      depositId: deposit.id,
      customerId: deposit.customerId,
      transactionNumber: credit.transfer.txid,
      receivedCurrency: 'USD',
      receivedAmountUnits: credit.transfer.amountUnits,
      creditedUsdUnits: credit.creditedUsdUnits,
      creditRateId: null,
      referenceCheck: null,
      acknowledgedFlags: decision.by === 'admin' ? decision.acknowledgedFlags : null,
      decidedBy: decision.by,
      journalId: posted.journalId,
      balanceAfterUnits: posted.balanceAfterUnits,
    },
  });
  return { ...posted, deposit: updated };
}
