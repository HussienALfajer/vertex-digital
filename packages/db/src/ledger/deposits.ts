import type { Currency, UsdtMethod } from '@vertex-digital/contracts';
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

export interface UsdtDepositCredit {
  depositId: string;
  customerId: string;
  /** The network the transfer arrived on: its receipts account takes the money (rule U15). */
  transferMethod: UsdtMethod;
  /** Exactly what arrived, in USD units, sub-cent included. */
  receivedUnits: number;
  /** Whole cents, at most `receivedUnits`: the declared amount, or the received one floored. */
  creditedUsdUnits: number;
}

/**
 * Posts a USDT deposit's credit (S04 money flow M1) inside the credit's transaction: the network's
 * receipts account gives the exact amount received, the wallet gets the whole cents, and
 * `deposit_rounding:USD` keeps the rest when there is any (M2). Key `deposit:<id>`, as S03.
 */
export async function postUsdtDepositCredit(
  tx: Transaction,
  credit: UsdtDepositCredit,
): Promise<PostedDepositCredit> {
  const rounding = credit.receivedUnits - credit.creditedUsdUnits;
  if (rounding < 0) throw new RangeError('A USDT credit cannot exceed what was received');
  const wallet = await ensureCustomerWallet(tx, credit.customerId);
  const receipts = await ensureSystemAccount(tx, {
    code: `usdt_receipts:${credit.transferMethod}`,
    kind: 'usdt_receipts',
    currency: 'USD',
  });
  const postings = [
    { accountId: receipts, amountUnits: -credit.receivedUnits },
    { accountId: wallet, amountUnits: credit.creditedUsdUnits },
  ];
  if (rounding > 0) {
    const roundingAccount = await ensureSystemAccount(tx, {
      code: 'deposit_rounding:USD',
      kind: 'deposit_rounding',
      currency: 'USD',
    });
    postings.push({ accountId: roundingAccount, amountUnits: rounding });
  }
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
