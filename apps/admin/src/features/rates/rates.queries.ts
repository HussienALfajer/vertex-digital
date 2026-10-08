import {
  infiniteQueryOptions,
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import type { ChangeRate } from '@vertex-digital/contracts';
import { api, BACKGROUND_REQUEST, call } from '../../lib/api/client';
import { useReauthentication } from '../account/reauthentication';

/*
 * The exchange rate (S03, F04): the current rate, its staleness and history, and the change
 * (rules FX1–FX3, FX7). Keys start with `rates`.
 */

/** How often the stale-rate banner reads the rate again on its own. */
const BANNER_REFRESH_MS = 5 * 60 * 1000;

/** The stale-rate banner on every page (rule FX7): read in the background, not as activity. */
export const rateBannerQuery = queryOptions({
  queryKey: ['rates', 'banner'],
  queryFn: () => call(api.GET('/api/admin/rates', { headers: BACKGROUND_REQUEST })),
  refetchInterval: BANNER_REFRESH_MS,
});

/** The rates page: the first page holds the current rate; the history pages follow. */
export const ratesQuery = infiniteQueryOptions({
  queryKey: ['rates', 'list'],
  queryFn: ({ pageParam }) =>
    call(api.GET('/api/admin/rates', { params: { query: { cursor: pageParam } } })),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (page) => page.history.nextCursor ?? undefined,
});

/**
 * Rule FX1: a new rate, after re-authentication. Every SYP display reads it, so the wallets and
 * the deposits are read again too.
 */
export function useChangeRate() {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: (body: ChangeRate) =>
      withReauthentication(() => call(api.POST('/api/admin/rates', { body }))),
    onSuccess: () =>
      Promise.all(
        ['rates', 'wallet', 'deposits'].map((key) =>
          queryClient.invalidateQueries({ queryKey: [key] }),
        ),
      ),
  });
}
