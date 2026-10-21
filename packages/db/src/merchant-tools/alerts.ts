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
 * above it. "Back above" is read from the wallet's running balance since the alert, so a deposit,
 * a refund or an adjustment clears it whatever path posted it; the hourly job also clears it.
 */

/** The highest running balance of the wallet after `since` (null without a posting since). */
async function highestBalanceSince(
  db: Executor,
  walletId: string,
  since: Date,
): Promise<number | null> {
  const result = await db.execute<{ highest: string | null }>(sql`
    select max(running)::text as highest from (
      select j.created_at, sum(p.amount_units) over (order by p.position) as running
      from ledger_postings p join ledger_journals j on j.id = p.journal_id
      where p.account_id = ${walletId}
    ) t where t.created_at > ${since}`);
  const highest = result.rows[0]?.highest ?? null;
  return highest === null ? null : Number(highest);
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
  if (settings.lowBalanceAlertedAt !== null) {
    const highest = await highestBalanceSince(tx, wallet, settings.lowBalanceAlertedAt);
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
      .set({ lowBalanceAlertedAt: due ? sql`now()` : null })
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
    .set({ lowBalanceAlertedAt: null })
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
