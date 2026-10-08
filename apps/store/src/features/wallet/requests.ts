import type { Wallet, WalletEntryPage } from '@vertex-digital/contracts';
import { apiRequest } from '@/lib/api';

/*
 * The customer's own wallet (S02 rules W2–W10): the balance and the timeline. The routes take no
 * customer id: the session cookie says whose wallet it is. Never cached.
 */

type Fetcher = typeof fetch;

export function getWallet(fetcher: Fetcher = fetch) {
  return apiRequest<Wallet>('/api/wallet', { fetcher });
}

/** One page of the timeline, newest first (rule W7); `cursor` from the previous page. */
export function listWalletEntries(cursor?: string, fetcher: Fetcher = fetch) {
  const query = cursor ? `?${new URLSearchParams({ cursor })}` : '';
  return apiRequest<WalletEntryPage>(`/api/wallet/entries${query}`, { fetcher });
}
