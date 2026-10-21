import { lowBalanceDue } from '@vertex-digital/contracts';
import { eq, sql } from 'drizzle-orm';
import type { Executor, Transaction } from '../client.js';
import { accountBalance } from '../ledger/balance.js';
import { findCustomerWallet } from '../ledger/wallet.js';
import { queueMerchantLevel } from '../merchants/levels.js';
import { type JobSender, notifyCustomer } from '../notifications/index.js';
import { merchantAlertSettings } from '../schema/index.js';

/*
 * The low-balance alert (S21 AL5, AL6): sent once in the transaction of the merchant's purchase
 * that takes the balance below their threshold, and again only after the balance was back at or
 * above it. "Back above" is read from the wallet's running balance after the alert's posting
 * position, so a deposit, a refund or an adjustment clears it whatever path posted it; the hourly
 * job also clears it.
 */

/**
 * The highest balance the wallet reached after the posting at `position` (write order, never the
 * journal's `created_at`: a credit whose transaction began before the alert may post after it),
 * or null without a posting since.
 */
async function highestBalanceAfter(
  db: Executor,
  walletId: string,
  position: number,
): Promise<number | null> {
  const result = await db.execute<{ highest: string | null }>(sql`
    select (
      (select coalesce(sum(amount_units), 0) from ledger_postings
        where account_id = ${walletId} and position <= ${position})
      + max(running))::text as highest
    from (
      select sum(amount_units) over (order by position) as running
      from ledger_postings where account_id = ${walletId} and position > ${position}
    ) t`);
  const highest = result.rows[0]?.highest ?? null;
  return highest === null ? null : Number(highest);
}

/** The position of the wallet's newest posting (this transaction's included). */
async function lastPosition(db: Executor, walletId: string): Promise<number> {
  const result = await db.execute<{ position: string | null }>(
    sql`select max(position)::text as position from ledger_postings where account_id = ${walletId}`,
  );
  return Number(result.rows[0]?.position ?? 0);
}

/**
 * AL5, AL6 after a debit of the merchant's wallet, in its transaction: the settings row locked, a
 * pending alert cleared when the balance went back to the threshold since, then the alert sent
 * when due. A customer without a threshold reads one row.
 */
export async function checkLowBalance(
  tx: Transaction,
  jobs: JobSender,
  customerId: string,
): Promise<boolean> {
  const [settings] = await tx
    .select()
    .from(merchantAlertSettings)
    .where(eq(merchantAlertSettings.customerId, customerId))
    .for('update');
  if (!settings || settings.lowBalanceUsdUnits === null) return false;
  const wallet = await findCustomerWallet(tx, customerId);
  if (wallet === null) return false;
  const threshold = settings.lowBalanceUsdUnits;
  let alerted = settings.lowBalanceAlertedAt !== null;
  if (alerted) {
    const highest =
      settings.lowBalanceAlertedPosition === null
        ? null
        : await highestBalanceAfter(tx, wallet, settings.lowBalanceAlertedPosition);
    if (highest !== null && highest >= threshold) alerted = false;
  }
  const balance = await accountBalance(tx, wallet);
  const due = lowBalanceDue(balance, { lowBalanceUsdUnits: threshold, alerted });
  if (due) {
    await notifyCustomer(tx, jobs, {
      customerId,
      event: 'merchant_low_balance',
      params: { balanceUsdUnits: balance, thresholdUsdUnits: threshold },
    });
  }
  if (due || alerted !== (settings.lowBalanceAlertedAt !== null)) {
    await tx
      .update(merchantAlertSettings)
      .set(
        due
          ? {
              lowBalanceAlertedAt: sql`now()`,
              lowBalanceAlertedPosition: await lastPosition(tx, wallet),
            }
          : { lowBalanceAlertedAt: null, lowBalanceAlertedPosition: null },
      )
      .where(eq(merchantAlertSettings.customerId, customerId));
  }
  return due;
}

/** AL6 (the hourly job): clears a sent alert once the balance is at or above the threshold. */
export async function clearLowBalanceIfAbove(tx: Transaction, customerId: string): Promise<void> {
  const [settings] = await tx
    .select()
    .from(merchantAlertSettings)
    .where(eq(merchantAlertSettings.customerId, customerId))
    .for('update');
  if (!settings?.lowBalanceAlertedAt || settings.lowBalanceUsdUnits === null) return;
  const wallet = await findCustomerWallet(tx, customerId);
  const balance = wallet === null ? 0 : await accountBalance(tx, wallet);
  if (balance < settings.lowBalanceUsdUnits) return;
  await tx
    .update(merchantAlertSettings)
    .set({ lowBalanceAlertedAt: null, lowBalanceAlertedPosition: null })
    .where(eq(merchantAlertSettings.customerId, customerId));
}

/**
 * S21 after a merchant's wallet purchase (a purchase, a checkout, a paid reservation, an order on
 * their behalf), in its transaction: the level recomputation queued (LV4) and the low-balance
 * alert (AL5). Nothing for a customer.
 */
export async function afterMerchantPurchase(
  tx: Transaction,
  jobs: JobSender,
  customer: { id: string; accountType: 'customer' | 'merchant' },
): Promise<void> {
  if (customer.accountType !== 'merchant') return;
  await queueMerchantLevel(tx, jobs, customer.id);
  await checkLowBalance(tx, jobs, customer.id);
}
