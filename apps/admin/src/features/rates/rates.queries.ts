import {
  infiniteQueryOptions,
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  ApproveRateSuggestion,
  ChangeRate,
  CreateRateSource,
  RateSettingsValues,
  TestRateSource,
  UpdateRateSource,
} from '@vertex-digital/contracts';
import { api, BACKGROUND_REQUEST, call } from '../../lib/api/client';
import { useReauthentication } from '../account/reauthentication';

/*
 * The exchange rate (S03, F04): the current rate, its staleness and history, and the change
 * (rules FX1–FX3, FX7); its automatic updates (S27, F46): sources, suggestions and settings.
 * Keys start with `rates`.
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
 * Rule FX1: a new rate, after re-authentication. SYP shows on many screens (wallets, deposits,
 * products, prices, orders, the dashboard, treasury), so every query is read again (rule FX4: a
 * change applies at once to every display).
 */
export function useChangeRate() {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: (body: ChangeRate) =>
      withReauthentication(() => call(api.POST('/api/admin/rates', { body }))),
    onSuccess: () => queryClient.invalidateQueries(),
  });
}

/** S27: the live sources with their last three reads. */
export const rateSourcesQuery = queryOptions({
  queryKey: ['rates', 'sources'],
  queryFn: () => call(api.GET('/api/admin/rate-sources')),
});

/** S27 ST1, ST2: the automatic updates' settings in force. */
export const rateSettingsQuery = queryOptions({
  queryKey: ['rates', 'settings'],
  queryFn: () => call(api.GET('/api/admin/rate-settings')),
});

/** A rate change of any kind shows on many screens (FX4): every query is read again. */
function useRateMutation<Input, Output>(request: (input: Input) => Promise<Output>) {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: (input: Input) => withReauthentication(() => request(input)),
    onSuccess: () => queryClient.invalidateQueries(),
  });
}

/** Source and settings changes touch only this module's queries. */
function useRatesMutation<Input, Output>(request: (input: Input) => Promise<Output>) {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: (input: Input) => withReauthentication(() => request(input)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['rates'] }),
  });
}

export const useCreateRateSource = () =>
  useRatesMutation((body: CreateRateSource) => call(api.POST('/api/admin/rate-sources', { body })));

export const useUpdateRateSource = () =>
  useRatesMutation(({ id, body }: { id: string; body: UpdateRateSource }) =>
    call(api.PATCH('/api/admin/rate-sources/{id}', { params: { path: { id } }, body })),
  );

export const useArchiveRateSource = () =>
  useRatesMutation((id: string) =>
    call(api.POST('/api/admin/rate-sources/{id}/archive', { params: { path: { id } } })),
  );

/** "تجربة القراءة": reads a page once and stores nothing (rate limited to 10 a minute). */
export function useTestRateSource() {
  return useMutation({
    mutationFn: (body: TestRateSource) => call(api.POST('/api/admin/rate-sources/test', { body })),
  });
}

/** SG3: the proposed value or an edit, with FX2's typed confirmation above 5%. */
export const useApproveRateSuggestion = () =>
  useRateMutation(({ id, body }: { id: string; body: ApproveRateSuggestion }) =>
    call(api.POST('/api/admin/rate-suggestions/{id}/approve', { params: { path: { id } }, body })),
  );

export const useRejectRateSuggestion = () =>
  useRatesMutation((id: string) =>
    call(api.POST('/api/admin/rate-suggestions/{id}/reject', { params: { path: { id } } })),
  );

export const useChangeRateSettings = () =>
  useRatesMutation((body: RateSettingsValues) =>
    call(api.POST('/api/admin/rate-settings', { body })),
  );
