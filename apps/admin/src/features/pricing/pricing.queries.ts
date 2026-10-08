import { keepPreviousData, queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { PricingPreviewRequest, SetMarginRule } from '@vertex-digital/contracts';
import { api, call } from '../../lib/api/client';
import { useReauthentication } from '../account/reauthentication';

/*
 * The pricing engine (S06, F10): the live margin rules, their changes (re-authentication, rule
 * PR9) and the preview (rule PR10). Keys start with `pricing`.
 */

export const rulesQuery = queryOptions({
  queryKey: ['pricing', 'rules'],
  queryFn: () => call(api.GET('/api/admin/pricing/rules')),
});

/**
 * PR3–PR8 for a cost and a target's rule or draft values; writes nothing, so it is a read here.
 * The previous answer stays on screen while the next one loads.
 */
export const previewQuery = (body: PricingPreviewRequest | null) =>
  queryOptions({
    queryKey: ['pricing', 'preview', body],
    queryFn: () => call(api.POST('/api/admin/pricing/preview', { body: body as never })),
    enabled: body !== null,
    placeholderData: keepPreviousData,
  });

/** Rule PR9: the live rule of the target, created or replaced, after re-authentication. */
export function useSetRule() {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: (body: SetMarginRule) =>
      withReauthentication(() =>
        call(api.PUT('/api/admin/pricing/rules', { body: body as never })),
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['pricing'] }),
  });
}

/** The target falls back to its parent's rule; the global rule is refused (rule PR2). */
export function useArchiveRule() {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: (id: string) =>
      withReauthentication(() =>
        call(api.POST('/api/admin/pricing/rules/{id}/archive', { params: { path: { id } } })),
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['pricing'] }),
  });
}
