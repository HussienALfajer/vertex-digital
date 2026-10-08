import type { Currency } from '@vertex-digital/contracts';
import type { Transaction } from '../client.js';
import { postJournal } from './post-journal.js';
import { ensureCustomerWallet, ensureSystemAccount, walletBalanceAfter } from './wallet.js';

/*
 * The credit of an approved deposit (S03 money flows M1–M3, ADR 0017): the only journal a deposit
 * posts. Sham Cash pounds stay in the books: `sham_cash_receipts:SYP` holds what the store
 * received, and the `currency_exchange` pair is its conversion position.
 */

export interface DepositCredit {
  depositId: string;
  customerId: string;
  /** What reached the store's Sham Cash account. */
  receivedCurrency: Currency;
  receivedAmountUnits: number;
  /** Whole cents: the received USD, or the pounds converted with rule FX6. */
  creditedUsdUnits: number;
}

export interface PostedDepositCredit {
  journalId: string;
  walletAccountId: string;
  balanceAfterUnits: number;
}

/**
 * Posts the deposit's credit inside the approval's transaction (rule RV7, step 5). The journal key
 * is `deposit:<id>`: a deposit is credited once. USD received is two postings (M1); SYP received
 * is four, balanced per currency (M2): the fraction of a cent the credit drops stays as pounds in
 * `currency_exchange:SYP` (M3).
 */
export async function postDepositCredit(
  tx: Transaction,
  credit: DepositCredit,
): Promise<PostedDepositCredit> {
  const wallet = await ensureCustomerWallet(tx, credit.customerId);
  const system = (kind: 'sham_cash_receipts' | 'currency_exchange', currency: Currency) =>
    ensureSystemAccount(tx, { code: `${kind}:${currency}`, kind, currency });
  const postings =
    credit.receivedCurrency === 'USD'
      ? [
          { accountId: wallet, amountUnits: credit.creditedUsdUnits },
          {
            accountId: await system('sham_cash_receipts', 'USD'),
            amountUnits: -credit.creditedUsdUnits,
          },
        ]
      : [
          {
            accountId: await system('sham_cash_receipts', 'SYP'),
            amountUnits: -credit.receivedAmountUnits,
          },
          {
            accountId: await system('currency_exchange', 'SYP'),
            amountUnits: credit.receivedAmountUnits,
          },
          {
            accountId: await system('currency_exchange', 'USD'),
            amountUnits: -credit.creditedUsdUnits,
          },
          { accountId: wallet, amountUnits: credit.creditedUsdUnits },
        ];
  const { journalId } = await postJournal(tx, {
    idempotencyKey: `deposit:${credit.depositId}`,
    kind: 'deposit',
    postings,
  });
  return {
    journalId,
    walletAccountId: wallet,
    balanceAfterUnits: await walletBalanceAfter(tx, wallet, journalId),
  };
}
