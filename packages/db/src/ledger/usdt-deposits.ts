import type { DepositFlagCode, UsdtMethod } from '@vertex-digital/contracts';
import { eq, sql } from 'drizzle-orm';
import { recordAudit } from '../audit/record-audit.js';
import type { Transaction } from '../client.js';
import { deposits, usdtDeposits } from '../schema/index.js';
import { type PostedDepositCredit, postUsdtDepositCredit } from './deposits.js';
import { claimPaymentReference } from './payment-references.js';
import { lockCustomerWallet } from './wallet.js';

/*
 * The credit of a USDT deposit (S04 rule U7): the one write path shared by the worker's automatic
 * credit of an exact match and the admin's approval of a review (rule U15).
 */

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
