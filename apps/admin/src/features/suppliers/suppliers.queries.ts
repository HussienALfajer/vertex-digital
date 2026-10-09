import {
  keepPreviousData,
  type QueryClient,
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  CreateRoute,
  ImportOffers,
  SetSupplierCredentials,
  SupplierCode,
  SupplierDetail,
  SupplierPolicy,
  UpdateRoute,
  UpdateSupplier,
} from '@vertex-digital/contracts';
import { api, BACKGROUND_REQUEST, call } from '../../lib/api/client';
import { useReauthentication } from '../account/reauthentication';
import type { OfferSearch } from './supplier-search';

/*
 * The suppliers (S07, F09): suppliers, their credentials, sync runs, offers and the import, the
 * policy, and a product's routes and price history. Keys start with `suppliers`. A change can
 * reprice products anywhere (rules P2, SP3), so every mutation reads the catalog and the pricing
 * reviews again too.
 */

/** How often a supplier's page reads it again while its sync runs (the connection test, SP2). */
const RUNNING_REFRESH_MS = 2_000;

/** One page of offers, runs or prices. */
export const LIST_PAGE_SIZE = 50;

/** A product's price history in the routes drawer: the newest 20 (S07 screens). */
const PRICE_HISTORY_SIZE = 20;

export const suppliersQuery = queryOptions({
  queryKey: ['suppliers', 'list'],
  queryFn: () => call(api.GET('/api/admin/suppliers')),
});

const running = (detail: SupplierDetail | undefined) => detail?.lastRun?.status === 'running';

/**
 * A supplier with its hints, health and balances; read again in the background while its last
 * run is `running` (not the admin's activity, rule D4), so the connection test's result shows
 * when it ends.
 */
export const supplierQuery = (code: SupplierCode) =>
  queryOptions({
    queryKey: ['suppliers', 'detail', code],
    queryFn: ({ client, queryKey }) =>
      call(
        api.GET('/api/admin/suppliers/{code}', {
          params: { path: { code } },
          headers: running(client.getQueryData<SupplierDetail>(queryKey))
            ? BACKGROUND_REQUEST
            : undefined,
        }),
      ),
    refetchInterval: (query) => (running(query.state.data) ? RUNNING_REFRESH_MS : false),
  });

export const runsQuery = (code: SupplierCode, page: number) =>
  queryOptions({
    queryKey: ['suppliers', 'runs', code, page],
    queryFn: () =>
      call(
        api.GET('/api/admin/suppliers/{code}/runs', {
          params: { path: { code }, query: { page, pageSize: LIST_PAGE_SIZE } },
        }),
      ),
    placeholderData: keepPreviousData,
  });

export const offersQuery = (code: SupplierCode, search: OfferSearch) =>
  queryOptions({
    queryKey: ['suppliers', 'offers', code, search],
    queryFn: () =>
      call(
        api.GET('/api/admin/suppliers/{code}/offers', {
          params: {
            path: { code },
            query: {
              q: search.q,
              group: search.group,
              mapped: search.mapped,
              missing: search.missing,
              inStock: search.inStock,
              page: search.page ?? 1,
              pageSize: LIST_PAGE_SIZE,
            },
          },
        }),
      ),
    placeholderData: keepPreviousData,
  });

/** An offer's cost changes, newest first. */
export const offerCostsQuery = (offerId: string) =>
  queryOptions({
    queryKey: ['suppliers', 'costs', offerId],
    queryFn: () =>
      call(
        api.GET('/api/admin/suppliers/offers/{id}/costs', {
          params: { path: { id: offerId }, query: { pageSize: LIST_PAGE_SIZE } },
        }),
      ),
  });

export const policyQuery = queryOptions({
  queryKey: ['suppliers', 'policy'],
  queryFn: () => call(api.GET('/api/admin/suppliers/policy')),
});

/** A product's routes, basis, price and review (the routes drawer). */
export const routingQuery = (productId: string) =>
  queryOptions({
    queryKey: ['suppliers', 'routing', productId],
    queryFn: () =>
      call(
        api.GET('/api/admin/catalog/products/{id}/routes', { params: { path: { id: productId } } }),
      ),
  });

export const priceHistoryQuery = (productId: string) =>
  queryOptions({
    queryKey: ['suppliers', 'prices', productId],
    queryFn: () =>
      call(
        api.GET('/api/admin/catalog/products/{id}/prices', {
          params: { path: { id: productId }, query: { pageSize: PRICE_HISTORY_SIZE } },
        }),
      ),
  });

const invalidateRouting = (queryClient: QueryClient) =>
  Promise.all(
    ['suppliers', 'catalog', 'pricing'].map((key) =>
      queryClient.invalidateQueries({ queryKey: [key] }),
    ),
  );

/** A suppliers change through the re-authentication wrapper (rule D5), then everything it reprices. */
function useSuppliersMutation<Input, Output>(request: (input: Input) => Promise<Output>) {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: (input: Input) => withReauthentication(() => request(input)),
    onSettled: () => invalidateRouting(queryClient),
  });
}

// Suppliers -------------------------------------------------------------------------------------

/** Rule SP2: every field, after re-authentication; the API then runs the connection test. */
export const useSetCredentials = (code: SupplierCode) =>
  useSuppliersMutation((body: SetSupplierCredentials) =>
    call(api.PUT('/api/admin/suppliers/{code}/credentials', { params: { path: { code } }, body })),
  );

/** The low-balance threshold (A07), after re-authentication. */
export const useUpdateSupplier = (code: SupplierCode) =>
  useSuppliersMutation((body: UpdateSupplier) =>
    call(api.PATCH('/api/admin/suppliers/{code}', { params: { path: { code } }, body })),
  );

/** Rule SY1: a sync now (1 a minute per supplier); answers the running run when there is one. */
export const useRequestSync = () =>
  useSuppliersMutation((code: SupplierCode) =>
    call(api.POST('/api/admin/suppliers/{code}/sync', { params: { path: { code } } })),
  );

/** Rule RT8: all or nothing; a refusal names its rows in `details.rows`. */
export const useImportOffers = (code: SupplierCode) =>
  useSuppliersMutation((body: ImportOffers) =>
    call(
      api.POST('/api/admin/suppliers/{code}/import', {
        params: { path: { code } },
        body: body as never,
      }),
    ),
  );

/** ADR 0021: the policy, after re-authentication. */
export const useSetPolicy = () =>
  useSuppliersMutation((body: SupplierPolicy) =>
    call(api.PUT('/api/admin/suppliers/policy', { body })),
  );

// Routes ----------------------------------------------------------------------------------------

export const useCreateRoute = (productId: string) =>
  useSuppliersMutation((body: CreateRoute) =>
    call(
      api.POST('/api/admin/catalog/products/{id}/routes', {
        params: { path: { id: productId } },
        body: body as never,
      }),
    ),
  );

/** Rule RT7: a manual offer at the admin's cost and its route, after re-authentication. */
export const useCreateManualRoute = (productId: string) =>
  useSuppliersMutation((costUsdUnits: number) =>
    call(
      api.POST('/api/admin/catalog/products/{id}/routes/manual', {
        params: { path: { id: productId } },
        body: { costUsdUnits },
      }),
    ),
  );

export const useUpdateRoute = () =>
  useSuppliersMutation(({ id, body }: { id: string; body: UpdateRoute }) =>
    call(api.PATCH('/api/admin/routes/{id}', { params: { path: { id } }, body })),
  );

export const useArchiveRoute = () =>
  useSuppliersMutation(({ id, archive }: { id: string; archive: boolean }) =>
    call(
      archive
        ? api.POST('/api/admin/routes/{id}/archive', { params: { path: { id } } })
        : api.POST('/api/admin/routes/{id}/restore', { params: { path: { id } } }),
    ),
  );

/** Rule RT7: a manual cost, after re-authentication; it reprices at once. */
export const useSetManualCost = () =>
  useSuppliersMutation(({ id, costUsdUnits }: { id: string; costUsdUnits: number }) =>
    call(
      api.PUT('/api/admin/routes/{id}/manual-cost', {
        params: { path: { id } },
        body: { costUsdUnits },
      }),
    ),
  );
