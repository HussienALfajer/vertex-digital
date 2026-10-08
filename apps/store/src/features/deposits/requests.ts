import type {
  CreateShamCashDeposit,
  CreateUsdtDeposit,
  Deposit,
  DepositPage,
  ShamCashOptions,
  UsdtOptions,
} from '@vertex-digital/contracts';
import { apiRequest, type Result } from '@/lib/api';
import { withAltcha } from '../auth/requests';

/*
 * The customer's deposits: Sham Cash (S03, F05) and USDT (S04, F06). The routes take no customer id: the session
 * cookie says whose deposits they are, and another customer's deposit answers `NOT_FOUND`.
 * Never cached (rule SC15).
 */

type Fetcher = typeof fetch;

/** What the wizard offers now: currencies, account, limits, rate, hours, ETA (rules SC1, SC3). */
export function getShamCashOptions(fetcher: Fetcher = fetch) {
  return apiRequest<ShamCashOptions>('/api/deposits/sham-cash/options', { fetcher });
}

/**
 * Creates a deposit (rule SC2). `key` is the attempt's `Idempotency-Key`: the same key with the
 * same body returns the first deposit, so a retry after a lost answer creates nothing new. The
 * API asks for a solved ALTCHA challenge (ADR 0008).
 */
export function createShamCashDeposit(
  body: CreateShamCashDeposit,
  key: string,
  fetcher: Fetcher = fetch,
): Promise<Result<Deposit>> {
  return withAltcha(
    (headers) =>
      apiRequest<Deposit>('/api/deposits/sham-cash', {
        method: 'POST',
        body,
        headers: { ...headers, 'idempotency-key': key },
        fetcher,
      }),
    fetcher,
  );
}

/** Per network: available or why not, the address, the limits with the USDT minimum (U1, U5). */
export function getUsdtOptions(fetcher: Fetcher = fetch) {
  return apiRequest<UsdtOptions>('/api/deposits/usdt/options', { fetcher });
}

/**
 * Creates a USDT deposit with its exact amount (rules U2, U3): the same key and ALTCHA rules as
 * Sham Cash. `DEPOSIT_AMOUNT_BUSY` means every tail of that amount is taken: the form offers the
 * amount one cent up or down.
 */
export function createUsdtDeposit(
  body: CreateUsdtDeposit,
  key: string,
  fetcher: Fetcher = fetch,
): Promise<Result<Deposit>> {
  return withAltcha(
    (headers) =>
      apiRequest<Deposit>('/api/deposits/usdt', {
        method: 'POST',
        body,
        headers: { ...headers, 'idempotency-key': key },
        fetcher,
      }),
    fetcher,
  );
}

/** Rule U8: the TXID or explorer link as pasted; the API normalizes it. */
export function submitTxid(id: string, txid: string, fetcher: Fetcher = fetch) {
  return apiRequest<Deposit>(`/api/deposits/${encodeURIComponent(id)}/txid`, {
    method: 'POST',
    body: { txid },
    fetcher,
  });
}

/** The customer's deposits, newest first; `cursor` from the previous page. */
export function listDeposits(cursor?: string, fetcher: Fetcher = fetch) {
  const query = cursor ? `?${new URLSearchParams({ cursor })}` : '';
  return apiRequest<DepositPage>(`/api/deposits${query}`, { fetcher });
}

export function getDeposit(id: string, fetcher: Fetcher = fetch) {
  return apiRequest<Deposit>(`/api/deposits/${encodeURIComponent(id)}`, { fetcher });
}

/** Rule SC10: the current rate and a new 15 minutes for a SYP deposit not yet fixed. */
export function requoteDeposit(id: string, fetcher: Fetcher = fetch) {
  return apiRequest<Deposit>(`/api/deposits/${encodeURIComponent(id)}/quote`, {
    method: 'POST',
    fetcher,
  });
}

/**
 * Rules SC8, SC9: the receipt image as multipart, with the rate the customer saw for SYP, so a
 * changed quote answers `QUOTE_EXPIRED` instead of submitting at a rate they did not see.
 */
export function submitReceipt(
  id: string,
  file: Blob,
  rateId: string | null,
  fetcher: Fetcher = fetch,
) {
  const body = new FormData();
  body.append('file', file);
  if (rateId) body.append('rateId', rateId);
  return apiRequest<Deposit>(`/api/deposits/${encodeURIComponent(id)}/receipt`, {
    method: 'POST',
    body,
    fetcher,
  });
}

/** Rule SC11: only a deposit still waiting for its receipt. */
export function cancelDeposit(id: string, fetcher: Fetcher = fetch) {
  return apiRequest<Deposit>(`/api/deposits/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    fetcher,
  });
}
