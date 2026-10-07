import {
  infiniteQueryOptions,
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import type { CreateAdjustment, ReverseAdjustment } from '@vertex-digital/contracts';
import { api, call } from '../../lib/api/client';
import { useReauthentication } from '../account/reauthentication';

/*
 * Customer wallets as the admin sees them (S02): search, one wallet and its timeline, the ledger
 * summary, and the adjustments and reversals (rules J1–J10, R1–R5). Keys start with `wallet`.
 */

export const ledgerSummaryQuery = queryOptions({
  queryKey: ['wallet', 'summary'],
  queryFn: () => call(api.GET('/api/admin/ledger/summary')),
});

/** Email or phone prefix, or part of the name; 3 characters at least. */
export const walletSearchQuery = (q: string) =>
  infiniteQueryOptions({
    queryKey: ['wallet', 'search', q],
    queryFn: ({ pageParam }) =>
      call(api.GET('/api/admin/wallets', { params: { query: { q, cursor: pageParam } } })),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

export const walletQuery = (customerId: string) =>
  queryOptions({
    queryKey: ['wallet', 'customer', customerId],
    queryFn: () =>
      call(api.GET('/api/admin/wallets/{customerId}', { params: { path: { customerId } } })),
  });

export const walletEntriesQuery = (customerId: string) =>
  infiniteQueryOptions({
    queryKey: ['wallet', 'customer', customerId, 'entries'],
    queryFn: ({ pageParam }) =>
      call(
        api.GET('/api/admin/wallets/{customerId}/entries', {
          params: { path: { customerId }, query: { cursor: pageParam } },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

/** Every wallet view: the summary, the search results and the wallet pages show balances. */
const invalidateWallets = (queryClient: ReturnType<typeof useQueryClient>) =>
  queryClient.invalidateQueries({ queryKey: ['wallet'] });

/**
 * Rules J1–J10: re-authentication when the API asks for it, retried with the same
 * `Idempotency-Key`, so a retry after a lost answer returns the first adjustment (rule J9).
 */
export function useCreateAdjustment(customerId: string) {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: ({ body, key }: { body: CreateAdjustment; key: string }) =>
      withReauthentication(() =>
        call(
          api.POST('/api/admin/wallets/{customerId}/adjustments', {
            params: { path: { customerId }, header: { 'Idempotency-Key': key } },
            body,
          }),
        ),
      ),
    onSettled: () => invalidateWallets(queryClient),
  });
}

/** Rules R1–R5: the opposite of the original, once; the same re-authentication and key rules. */
export function useReverseAdjustment() {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: ({ id, body, key }: { id: string; body: ReverseAdjustment; key: string }) =>
      withReauthentication(() =>
        call(
          api.POST('/api/admin/wallet-adjustments/{id}/reverse', {
            params: { path: { id }, header: { 'Idempotency-Key': key } },
            body,
          }),
        ),
      ),
    onSettled: () => invalidateWallets(queryClient),
  });
}
