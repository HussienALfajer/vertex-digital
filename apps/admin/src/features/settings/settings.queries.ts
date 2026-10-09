import {
  infiniteQueryOptions,
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import type { ChangeSwitch, StoreSwitch } from '@vertex-digital/contracts';
import { api, BACKGROUND_REQUEST, call } from '../../lib/api/client';
import { useReauthentication } from '../account/reauthentication';

/*
 * The store switches (S05, F26): their values, history and changes (rules SW1–SW3, SW10). Keys
 * start with `settings`.
 */

/** How often the switches banner reads the switches again on its own. */
const BANNER_REFRESH_MS = 60 * 1000;

/** The switches banner on every page (rule SW10): read in the background, not as activity. */
export const switchesBannerQuery = queryOptions({
  queryKey: ['settings', 'switches', 'banner'],
  queryFn: () => call(api.GET('/api/admin/switches', { headers: BACKGROUND_REQUEST })),
  refetchInterval: BANNER_REFRESH_MS,
});

export const switchesQuery = queryOptions({
  queryKey: ['settings', 'switches', 'page'],
  queryFn: () => call(api.GET('/api/admin/switches')),
});

/** The history, newest first, one switch or all. */
export const switchHistoryQuery = (filter: StoreSwitch | undefined) =>
  infiniteQueryOptions({
    queryKey: ['settings', 'history', filter ?? 'all'],
    queryFn: ({ pageParam }) =>
      call(
        api.GET('/api/admin/switches/history', {
          params: { query: { switch: filter, cursor: pageParam } },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

/**
 * Rules SW2, SW3: a change after re-authentication, in both directions. A supplier's pause
 * reprices its routed products (S07 rule SP3), so the suppliers, catalog and reviews read again.
 */
export function useChangeSwitch() {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: (body: ChangeSwitch) =>
      withReauthentication(() => call(api.POST('/api/admin/switches', { body }))),
    onSuccess: () =>
      Promise.all(
        ['settings', 'suppliers', 'catalog', 'pricing'].map((key) =>
          queryClient.invalidateQueries({ queryKey: [key] }),
        ),
      ),
  });
}
