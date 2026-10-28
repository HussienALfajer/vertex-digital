import {
  infiniteQueryOptions,
  keepPreviousData,
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  GrantMerchant,
  MerchantLevelInput,
  MerchantSettingsInput,
  RemoveMerchantLogo,
  RevokeMerchant,
} from '@vertex-digital/contracts';
import { api, BACKGROUND_REQUEST, call } from '../../lib/api/client';
import { useReauthentication } from '../account/reauthentication';
import { type ApplicationsSearch, type MerchantsSearch, statusOf, tabOf } from './merchants-search';

/*
 * Merchants as the admin works them (S20 F28): the applications queue and one application with
 * its decisions (MA4–MA8), the direct grant and the revocation from the customer's profile or the
 * merchants list (MA6, MA7), the merchants list and the merchant settings. Keys start with
 * `merchants`.
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
              levelId: search.levelId,
              cursor: pageParam,
            },
          },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });

/** S21 LV1: the levels with their merchants, live first by threshold. */
export const merchantLevelsQuery = queryOptions({
  queryKey: ['merchants', 'levels'],
  queryFn: () => call(api.GET('/api/admin/merchant-levels')),
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

export const useRevokeMerchant = (customerId: string) =>
  useMerchantsMutation((body: RevokeMerchant) =>
    call(
      api.POST('/api/admin/customers/{id}/merchant/revoke', {
        params: { path: { id: customerId } },
        body,
      }),
    ),
  );

/** S21 LV1, LV6: a level's change requeues every merchant; re-authenticated. */
export const useCreateMerchantLevel = () =>
  useMerchantsMutation((body: MerchantLevelInput) =>
    call(api.POST('/api/admin/merchant-levels', { body })),
  );

export const useUpdateMerchantLevel = (id: string) =>
  useMerchantsMutation((body: MerchantLevelInput) =>
    call(api.PATCH('/api/admin/merchant-levels/{id}', { params: { path: { id } }, body })),
  );

export const useArchiveMerchantLevel = () =>
  useMerchantsMutation((id: string) =>
    call(api.POST('/api/admin/merchant-levels/{id}/archive', { params: { path: { id } } })),
  );

export const useSaveMerchantSettings = () =>
  useMerchantsMutation((body: MerchantSettingsInput) =>
    call(api.PUT('/api/admin/merchant-settings', { body })),
  );
