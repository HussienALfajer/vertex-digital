import {
  infiniteQueryOptions,
  keepPreviousData,
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  GrantMerchant,
  LevelTier,
  MerchantSettingsInput,
  MerchantTier,
  RemoveMerchantLogo,
  RemoveWelcomeText,
  RevokeMerchant,
  TierGrantEndInput,
  TierGrantInput,
  TierLevelInput,
  TierPreviewInput,
  TierSettingsInput,
} from '@vertex-digital/contracts';
import { api, BACKGROUND_REQUEST, call } from '../../lib/api/client';
import { useReauthentication } from '../account/reauthentication';
import { type ApplicationsSearch, type MerchantsSearch, statusOf, tabOf } from './merchants-search';

/*
 * Merchants as the admin works them (S20 F28): the applications queue and one application with
 * its decisions (MA4–MA8), the direct grant and the revocation from the customer's profile or the
 * merchants list (MA6, MA7), the merchants list and the merchant settings; S23: the tiers, their
 * levels and settings, the threshold preview and the manual grants. Keys start with `merchants`.
 */

/**
 * MA8: the applications under review, for the navigation badge, read every minute in the
 * background through a count of its own (audit A10-25: it read the whole dashboard).
 */
export const waitingApplicationsQuery = queryOptions({
  queryKey: ['merchants', 'applications', 'waiting'],
  queryFn: () =>
    call(api.GET('/api/admin/merchant-applications/waiting', { headers: BACKGROUND_REQUEST })),
  select: (badge) => badge.count,
  refetchInterval: 60_000,
});

/** MA8: under review oldest first, the other tabs newest first. */
export const applicationsQuery = (search: ApplicationsSearch) =>
  infiniteQueryOptions({
    queryKey: ['merchants', 'applications', search],
    queryFn: ({ pageParam }) =>
      call(
        api.GET('/api/admin/merchant-applications', {
          params: { query: { status: statusOf(tabOf(search)), cursor: pageParam } },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });

export const applicationQuery = (id: string) =>
  queryOptions({
    queryKey: ['merchants', 'application', id],
    queryFn: () =>
      call(api.GET('/api/admin/merchant-applications/{id}', { params: { path: { id } } })),
  });

/** The shop photo (MA3): served to the admin only, never cached. */
export const applicationPhotoUrl = (id: string) => `/api/admin/merchant-applications/${id}/photo`;

export const merchantsQuery = (search: MerchantsSearch) =>
  infiniteQueryOptions({
    queryKey: ['merchants', 'list', search],
    queryFn: ({ pageParam }) =>
      call(
        api.GET('/api/admin/merchants', {
          params: {
            query: {
              q: search.q,
              listId: search.listId,
              tier: search.tier,
              cursor: pageParam,
            },
          },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });

/** S23: the four tiers with their live levels, settings and merchants, Bronze first. */
export const merchantTiersQuery = queryOptions({
  queryKey: ['merchants', 'tiers'],
  queryFn: () => call(api.GET('/api/admin/merchant-tiers')),
});

/** S23 PX5: the Diamond best-sellers helper. */
export const merchantTierBestSellersQuery = queryOptions({
  queryKey: ['merchants', 'tiers', 'best-sellers'],
  queryFn: () => call(api.GET('/api/admin/merchant-tiers/best-sellers')),
});

export const merchantSettingsQuery = queryOptions({
  queryKey: ['merchants', 'settings'],
  queryFn: () => call(api.GET('/api/admin/merchant-settings')),
});

/**
 * A merchant change shows in the queue, the application, the merchants list, the customer's
 * profile, the dashboard and the audit log.
 */
function useMerchantsMutation<Input, Output>(request: (input: Input) => Promise<Output>) {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: (input: Input) => withReauthentication(() => request(input)),
    onSettled: () =>
      Promise.all(
        ['merchants', 'customers', 'dashboard', 'audit'].map((key) =>
          queryClient.invalidateQueries({ queryKey: [key] }),
        ),
      ),
  });
}

/** MA4: a request for information, shown to the customer. */
export const useRequestApplicationInfo = (id: string) =>
  useMerchantsMutation((message: string) =>
    call(
      api.POST('/api/admin/merchant-applications/{id}/request-info', {
        params: { path: { id } },
        body: { message },
      }),
    ),
  );

/** MA4: a rejection with the reason the customer reads. */
export const useRejectApplication = (id: string) =>
  useMerchantsMutation((reason: string) =>
    call(
      api.POST('/api/admin/merchant-applications/{id}/reject', {
        params: { path: { id } },
        body: { reason },
      }),
    ),
  );

/** MA5: an approval with a list (no list: wholesale), re-authenticated. */
export const useApproveApplication = (id: string) =>
  useMerchantsMutation((priceListId: string | undefined) =>
    call(
      api.POST('/api/admin/merchant-applications/{id}/approve', {
        params: { path: { id } },
        body: priceListId ? { priceListId } : {},
      }),
    ),
  );

/** MA6: the direct grant, re-authenticated. */
export const useGrantMerchant = (customerId: string) =>
  useMerchantsMutation((body: GrantMerchant) =>
    call(
      api.POST('/api/admin/customers/{id}/merchant', {
        params: { path: { id: customerId } },
        body,
      }),
    ),
  );

/** MA7: the revocation, re-authenticated. */
/** S21 BR3: removes a merchant's receipt logo, with a reason (re-authenticated, audited). */
export const useRemoveMerchantLogo = (customerId: string) =>
  useMerchantsMutation((body: RemoveMerchantLogo) =>
    call(
      api.DELETE('/api/admin/customers/{id}/merchant/logo', {
        params: { path: { id: customerId } },
        body,
      }),
    ),
  );

/** S23 RC1: removes a merchant's receipt welcome line, with a reason (re-authenticated, audited). */
export const useRemoveWelcomeText = (customerId: string) =>
  useMerchantsMutation((body: RemoveWelcomeText) =>
    call(
      api.DELETE('/api/admin/customers/{id}/merchant/welcome-text', {
        params: { path: { id: customerId } },
        body,
      }),
    ),
  );

export const useRevokeMerchant = (customerId: string) =>
  useMerchantsMutation((body: RevokeMerchant) =>
    call(
      api.POST('/api/admin/customers/{id}/merchant/revoke', {
        params: { path: { id: customerId } },
        body,
      }),
    ),
  );

export const useSaveMerchantSettings = () =>
  useMerchantsMutation((body: MerchantSettingsInput) =>
    call(api.PUT('/api/admin/merchant-settings', { body })),
  );

/** S23 TS1: a tier's threshold and list (null archives the level), re-authenticated. */
export const useSetTierLevel = (tier: LevelTier) =>
  useMerchantsMutation((body: TierLevelInput) =>
    call(api.PUT('/api/admin/merchant-tiers/{tier}/level', { params: { path: { tier } }, body })),
  );

/** S23 TS1, TS2: a tier's privileges, re-authenticated. */
export const useSaveTierSettings = (tier: MerchantTier) =>
  useMerchantsMutation((body: TierSettingsInput) =>
    call(
      api.PUT('/api/admin/merchant-tiers/{tier}/settings', { params: { path: { tier } }, body }),
    ),
  );

/** S23 AD3: who would hold each tier at proposed thresholds; reads only, so nothing to refresh. */
export const useTierPreview = () =>
  useMutation({
    mutationFn: (body: TierPreviewInput) =>
      call(api.POST('/api/admin/merchant-tiers/preview', { body })),
  });

/** S23 MG1: a manual tier until a Damascus day, with a reason, re-authenticated. */
export const useGrantTier = (customerId: string) =>
  useMerchantsMutation((body: TierGrantInput) =>
    call(
      api.POST('/api/admin/customers/{id}/merchant/tier-grant', {
        params: { path: { id: customerId } },
        body,
      }),
    ),
  );

/** S23 MG3: ends the open grant early, with a reason, re-authenticated. */
export const useEndTierGrant = (customerId: string) =>
  useMerchantsMutation((body: TierGrantEndInput) =>
    call(
      api.POST('/api/admin/customers/{id}/merchant/tier-grant/end', {
        params: { path: { id: customerId } },
        body,
      }),
    ),
  );
