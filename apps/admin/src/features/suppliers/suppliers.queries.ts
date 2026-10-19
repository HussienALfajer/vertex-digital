import {
  keepPreviousData,
  type QueryClient,
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  CoverFromSupplier,
  CreateRoute,
  ImportCategory,
  ImportOffers,
  LinkCategory,
  SetSupplierCredentials,
  SupplierCategoryState,
  SupplierCode,
  SupplierDetail,
  SupplierPolicy,
  SupplierSummary,
  UpdateRoute,
  UpdateSupplier,
  ValidationQuota,
} from '@vertex-digital/contracts';
import { ApiError, api, BACKGROUND_REQUEST, call } from '../../lib/api/client';
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

const running = (detail: Pick<SupplierSummary, 'lastRun'> | undefined) =>
  detail?.lastRun?.status === 'running';

const anyRunning = (list: SupplierSummary[] | undefined) => !!list?.some(running);

/**
 * The supplier cards; read again in the background while a run is `running` (after "مزامنة
 * الآن"), so each card shows its result and counts when the run ends.
 */
export const suppliersQuery = queryOptions({
  queryKey: ['suppliers', 'list'],
  queryFn: ({ client, queryKey }) =>
    call(
      api.GET('/api/admin/suppliers', {
        headers: anyRunning(client.getQueryData<SupplierSummary[]>(queryKey))
          ? BACKGROUND_REQUEST
          : undefined,
      }),
    ),
  refetchInterval: (query) => (anyRunning(query.state.data) ? RUNNING_REFRESH_MS : false),
});

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
              categoryId: search.categoryId,
              supported: search.supported,
              ignored: search.ignored,
              lowStock: search.lowStock,
              discounted: search.discounted,
              page: search.page ?? 1,
              pageSize: LIST_PAGE_SIZE,
            },
          },
        }),
      ),
    placeholderData: keepPreviousData,
  });

/** S18: one supplier category with its path, counts, state and game (the category page). */
export const categoryQuery = (code: SupplierCode, categoryId: string) =>
  queryOptions({
    queryKey: ['suppliers', 'category', code, categoryId],
    queryFn: () =>
      call(
        api.GET('/api/admin/suppliers/{code}/categories/{categoryId}', {
          params: { path: { code, categoryId } },
        }),
      ),
  });

/** S18 FK3: the supplier's recorded calls, newest first; `error` for the failures. */
export const callsQuery = (code: SupplierCode, page: number, result?: 'ok' | 'refused' | 'error') =>
  queryOptions({
    queryKey: ['suppliers', 'calls', code, result ?? 'all', page],
    queryFn: () =>
      call(
        api.GET('/api/admin/suppliers/{code}/calls', {
          params: { path: { code }, query: { page, pageSize: LIST_PAGE_SIZE, result } },
        }),
      ),
    placeholderData: keepPreviousData,
  });

/** S18: the store packs an offer may be linked to, suggested first, or found by `q`. */
export const linkCandidatesQuery = (offerId: string, q?: string) =>
  queryOptions({
    queryKey: ['suppliers', 'link-candidates', offerId, q ?? null],
    queryFn: () =>
      call(
        api.GET('/api/admin/suppliers/offers/{id}/link-candidates', {
          params: { path: { id: offerId }, query: q ? { q } : {} },
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

// Supplier catalog (S16) -----------------------------------------------------------------------

/** One level or one search of the category tree: 100 nodes a page (rule SC4 allows 200). */
export const CATEGORY_PAGE_SIZE = 100;

/** How often the navigation badge and the cards read the new packs count (rule SC11). */
const NEW_PACKS_REFRESH_MS = 60_000;

/** Rule SF5: the API caches the supplier's status a minute; the panel keeps it as long. */
const PLATFORM_STATUS_STALE_MS = 60_000;

export interface CategoryQuery {
  /** A level under this node; absent for the roots. */
  parentId?: string;
  state?: SupplierCategoryState;
  kind?: 'direct' | 'code';
  q?: string;
  page: number;
}

export const categoriesQuery = (code: SupplierCode, query: CategoryQuery) =>
  queryOptions({
    queryKey: ['suppliers', 'categories', code, query],
    queryFn: () =>
      call(
        api.GET('/api/admin/suppliers/{code}/categories', {
          params: { path: { code }, query: { ...query, pageSize: CATEGORY_PAGE_SIZE } },
        }),
      ),
    placeholderData: keepPreviousData,
  });

/** Rule IM1: the thumbnail through the API, on the panel's own origin (its CSP is unchanged). */
export const categoryImageUrl = (code: SupplierCode, categoryId: string) =>
  `/api/admin/suppliers/${code}/categories/${encodeURIComponent(categoryId)}/image`;

/** The import draft, or with `gameId` the link draft (rules SC7, SC8, SC12–SC14). */
export const importDraftQuery = (code: SupplierCode, categoryId: string, gameId?: string) =>
  queryOptions({
    queryKey: ['suppliers', 'draft', code, categoryId, gameId ?? null],
    queryFn: () =>
      call(
        api.GET('/api/admin/suppliers/{code}/categories/{categoryId}/import-draft', {
          params: { path: { code, categoryId }, query: gameId ? { gameId } : {} },
        }),
      ),
    staleTime: 0,
    gcTime: 0,
  });

/** The new packs count for the navigation badge (rule SC11), read in the background. */
export const newPacksQuery = queryOptions({
  queryKey: ['suppliers', 'new-packs'],
  queryFn: () => call(api.GET('/api/admin/suppliers', { headers: BACKGROUND_REQUEST })),
  select: (list: SupplierSummary[]) => list.reduce((sum, item) => sum + item.newOfferCount, 0),
  refetchInterval: NEW_PACKS_REFRESH_MS,
});

/** Rule SF5: the supplier's own status, read on the page's request, cached a minute. */
export const platformStatusQuery = (code: SupplierCode) =>
  queryOptions({
    queryKey: ['suppliers', 'platform', code],
    queryFn: () =>
      call(api.GET('/api/admin/suppliers/{code}/platform-status', { params: { path: { code } } })),
    staleTime: PLATFORM_STATUS_STALE_MS,
    retry: false,
  });

/**
 * S18 ST3: a statement read refused by the API's 5-second limit waits it out and reads again
 * (twice at most); any other failure is shown at once.
 */
const statementRetry = {
  retry: (count: number, error: Error) =>
    count < 2 && error instanceof ApiError && error.code === 'RATE_LIMITED',
  retryDelay: 5_000,
};

/** Rule SF3: one page of the supplier's orders, read live (5 s limit, S18 ST3). */
export const statementOrdersQuery = (code: SupplierCode, page: number) =>
  queryOptions({
    queryKey: ['suppliers', 'statement', code, 'orders', page],
    queryFn: () =>
      call(
        api.GET('/api/admin/suppliers/{code}/statement/orders', {
          params: { path: { code }, query: { page } },
        }),
      ),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    ...statementRetry,
  });

/** Rule SF3: one page of the supplier's wallet movements, read live (S18 ST3). */
export const statementTransactionsQuery = (code: SupplierCode, page: number) =>
  queryOptions({
    queryKey: ['suppliers', 'statement', code, 'transactions', page],
    queryFn: () =>
      call(
        api.GET('/api/admin/suppliers/{code}/statement/transactions', {
          params: { path: { code }, query: { page } },
        }),
      ),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    ...statementRetry,
  });

/** The supplier categories linked to a game (its page: SC9, IM3). */
export const gameCategoriesQuery = (gameId: string) =>
  queryOptions({
    queryKey: ['suppliers', 'game-categories', gameId],
    queryFn: () =>
      call(
        api.GET('/api/admin/catalog/games/{id}/supplier-categories', {
          params: { path: { id: gameId } },
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
function useSuppliersMutation<Input, Output>(
  request: (input: Input) => Promise<Output>,
  options: { gcTime?: number } = {},
) {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: (input: Input) => withReauthentication(() => request(input)),
    onSettled: () => invalidateRouting(queryClient),
    ...options,
  });
}

// Suppliers -------------------------------------------------------------------------------------

/**
 * Rule SP2: every field, after re-authentication; the API then runs the connection test. The
 * values leave the mutation cache as soon as it settles.
 */
export const useSetCredentials = (code: SupplierCode) =>
  useSuppliersMutation(
    (body: SetSupplierCredentials) =>
      call(
        api.PUT('/api/admin/suppliers/{code}/credentials', { params: { path: { code } }, body }),
      ),
    { gcTime: 0 },
  );

/** The low-balance threshold (A07), after re-authentication. */
export const useUpdateSupplier = (code: SupplierCode) =>
  useSuppliersMutation((body: UpdateSupplier) =>
    call(api.PATCH('/api/admin/suppliers/{code}', { params: { path: { code } }, body })),
  );

/** S09 rule AD2: the daily player-validation quota; 0 turns validation off for this supplier. */
export const useSetValidationQuota = (code: SupplierCode) =>
  useSuppliersMutation((body: ValidationQuota) =>
    call(
      api.PUT('/api/admin/suppliers/{code}/validation-quota', { params: { path: { code } }, body }),
    ),
  );

/**
 * S18 CS1: one live balance read (10 s apart); its answer is the result. The supplier and its
 * calls are read again.
 */
export function useTestConnection(code: SupplierCode) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      call(api.POST('/api/admin/suppliers/{code}/test', { params: { path: { code } } })),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['suppliers', 'detail', code] }),
        queryClient.invalidateQueries({ queryKey: ['suppliers', 'calls', code] }),
      ]),
  });
}

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

// Supplier catalog changes (S16) ---------------------------------------------------------------

/** Rule SC7: all or nothing; refused rows in `details.rows`. */
export const useImportCategory = (code: SupplierCode, categoryId: string) =>
  useSuppliersMutation((body: ImportCategory) =>
    call(
      api.POST('/api/admin/suppliers/{code}/categories/{categoryId}/import', {
        params: { path: { code, categoryId } },
        body: body as never,
      }),
    ),
  );

/** Rule SC8: all or nothing; refused rows in `details.rows`. */
export const useLinkCategory = (code: SupplierCode, categoryId: string) =>
  useSuppliersMutation((body: LinkCategory) =>
    call(
      api.POST('/api/admin/suppliers/{code}/categories/{categoryId}/link', {
        params: { path: { code, categoryId } },
        body: body as never,
      }),
    ),
  );

export type CategoryChange = 'unlink' | 'ignore' | 'unignore';

/** Rules SC6, SC9: unlink, ignore or unignore a node. */
export const useCategoryChange = (code: SupplierCode) =>
  useSuppliersMutation(({ categoryId, change }: { categoryId: string; change: CategoryChange }) => {
    const params = { params: { path: { code, categoryId } } };
    return call(
      change === 'unlink'
        ? api.POST('/api/admin/suppliers/{code}/categories/{categoryId}/unlink', params)
        : change === 'ignore'
          ? api.POST('/api/admin/suppliers/{code}/categories/{categoryId}/ignore', params)
          : api.POST('/api/admin/suppliers/{code}/categories/{categoryId}/unignore', params),
    );
  });

/** Rule SC6: one offer no longer counts as new, or counts again. */
export const useOfferIgnored = () =>
  useSuppliersMutation(({ id, ignored }: { id: string; ignored: boolean }) =>
    call(
      ignored
        ? api.POST('/api/admin/suppliers/offers/{id}/ignore', { params: { path: { id } } })
        : api.POST('/api/admin/suppliers/offers/{id}/unignore', { params: { path: { id } } }),
    ),
  );

/** Rule SC10: the game and every paused pack that can serve, with the skipped ones. */
export const useActivateAll = (gameId: string) =>
  useSuppliersMutation(() =>
    call(
      api.POST('/api/admin/catalog/games/{id}/activate-all', { params: { path: { id: gameId } } }),
    ),
  );

/** Rule IM3: the linked category's image, downloaded again, as the cover. */
export const useCoverFromSupplier = (gameId: string) =>
  useSuppliersMutation((body: CoverFromSupplier) =>
    call(
      api.POST('/api/admin/catalog/games/{id}/cover/from-supplier', {
        params: { path: { id: gameId } },
        body,
      }),
    ),
  );
