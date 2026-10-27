import {
  keepPreviousData,
  type QueryClient,
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import {
  type CreatePriceList,
  type DecideReviews,
  type MarginRuleValues,
  type PricingPreviewRequest,
  ROOT_PRICE_LIST_IDS,
  type SetMarginRule,
} from '@vertex-digital/contracts';
import { api, BACKGROUND_REQUEST, call } from '../../lib/api/client';
import { useReauthentication } from '../account/reauthentication';
import type { MatrixSearch } from './matrix-search';
import type { ReviewSearch } from './review-search';

/*
 * The pricing engine (S06, F10): the live margin rules, their changes (re-authentication, rule
 * PR9) and the preview (rule PR10). S07: the price reviews and their decisions (rule P4). Keys
 * start with `pricing`. A rule change or a decision reprices products (rule P5), so they read the
 * catalog and the suppliers' routes again too. S20: the price lists, their rules and fixed prices
 * (re-authentication, LS6) and the matrix; a list change reprices every list, so it reads all of
 * `pricing` again.
 */

/** How often the navigation badge reads the open reviews again on its own. */
const REVIEW_COUNT_REFRESH_MS = 60 * 1000;

/** One page of reviews. */
export const REVIEWS_PAGE_SIZE = 50;

const invalidatePricing = (queryClient: QueryClient) =>
  Promise.all(
    ['pricing', 'catalog', 'suppliers'].map((key) =>
      queryClient.invalidateQueries({ queryKey: [key] }),
    ),
  );

/** A list's live rules (S20), retail by default. */
export const listRulesQuery = (priceListId: string = ROOT_PRICE_LIST_IDS.retail) =>
  queryOptions({
    queryKey: ['pricing', 'rules', priceListId],
    queryFn: () =>
      call(api.GET('/api/admin/pricing/rules', { params: { query: { priceListId } } })),
  });

export const rulesQuery = listRulesQuery();

/**
 * PR3–PR8 for a cost and a target's rule or draft values; writes nothing, so it is a read here.
 * The previous answer stays on screen while the next one loads.
 */
export const previewQuery = (body: PricingPreviewRequest | null) =>
  queryOptions({
    queryKey: ['pricing', 'preview', body],
    queryFn: () => call(api.POST('/api/admin/pricing/preview', { body: body as PricingPreviewRequest })),
    enabled: body !== null,
    placeholderData: keepPreviousData,
  });

/** Rule PR9: the live rule of the target, created or replaced, after re-authentication. */
export function useSetRule() {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: (body: SetMarginRule) =>
      withReauthentication(() => call(api.PUT('/api/admin/pricing/rules', { body }))),
    onSettled: () => invalidatePricing(queryClient),
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
    onSettled: () => invalidatePricing(queryClient),
  });
}

export const reviewsQuery = (search: ReviewSearch) =>
  queryOptions({
    queryKey: ['pricing', 'reviews', search],
    queryFn: () =>
      call(
        api.GET('/api/admin/pricing/reviews', {
          params: {
            query: {
              status: search.status ?? 'open',
              supplier: search.supplier,
              page: search.page ?? 1,
              pageSize: REVIEWS_PAGE_SIZE,
            },
          },
        }),
      ),
    placeholderData: keepPreviousData,
  });

/** The open reviews for the navigation badge: read in the background, not as activity. */
export const openReviewCountQuery = queryOptions({
  queryKey: ['pricing', 'reviews', 'count'],
  queryFn: async () => {
    const page = await call(
      api.GET('/api/admin/pricing/reviews', {
        params: { query: { status: 'open', pageSize: 1 } },
        headers: BACKGROUND_REQUEST,
      }),
    );
    return page.total;
  },
  refetchInterval: REVIEW_COUNT_REFRESH_MS,
});

/** Rule P4: each review decided on its own; the answer lists the result per review. */
export function useDecideReviews() {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: (body: DecideReviews) =>
      withReauthentication(() => call(api.POST('/api/admin/pricing/reviews/decide', { body }))),
    onSettled: () => invalidatePricing(queryClient),
  });
}

/** Rule P4: a product margin rule and the accept in one change, after re-authentication. */
export function useAdjustMargin() {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: ({ id, values }: { id: string; values: MarginRuleValues }) =>
      withReauthentication(() =>
        call(
          api.POST('/api/admin/pricing/reviews/{id}/adjust-margin', {
            params: { path: { id } },
            body: values,
          }),
        ),
      ),
    onSettled: () => invalidatePricing(queryClient),
  });
}

// Price lists (S20) ------------------------------------------------------------------------------

export const priceListsQuery = queryOptions({
  queryKey: ['pricing', 'lists'],
  queryFn: () => call(api.GET('/api/admin/pricing/lists')),
});

export const priceListQuery = (id: string) =>
  queryOptions({
    queryKey: ['pricing', 'lists', id],
    queryFn: () => call(api.GET('/api/admin/pricing/lists/{id}', { params: { path: { id } } })),
  });

/** The matrix of a game or a search on the chosen lists; the previous answer stays meanwhile. */
export const priceMatrixQuery = (search: MatrixSearch) =>
  queryOptions({
    queryKey: ['pricing', 'matrix', search],
    queryFn: () =>
      call(
        api.GET('/api/admin/pricing/matrix', {
          params: {
            query: {
              gameId: search.gameId,
              q: search.q,
              // Retail is always shown; naming it lets no other list ask for retail alone (A05-33).
              listIds: search.lists && [ROOT_PRICE_LIST_IDS.retail, ...search.lists],
              warnings: search.warnings ? 'true' : undefined,
            },
          },
        }),
      ),
    enabled: !!search.gameId || !!search.q,
    placeholderData: keepPreviousData,
  });

/** LS1–LS3: a custom list under a parent, priced at once. */
export function useCreatePriceList() {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: (body: CreatePriceList) =>
      withReauthentication(() => call(api.POST('/api/admin/pricing/lists', { body }))),
    onSettled: () => invalidatePricing(queryClient),
  });
}

export function useRenamePriceList() {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      withReauthentication(() =>
        call(
          api.PATCH('/api/admin/pricing/lists/{id}', {
            params: { path: { id } },
            body: { name },
          }),
        ),
      ),
    onSettled: () => invalidatePricing(queryClient),
  });
}

/** LS5: refused while an account or a list uses it (`PRICE_LIST_IN_USE` with the counts). */
export function useArchivePriceList() {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: (id: string) =>
      withReauthentication(() =>
        call(api.POST('/api/admin/pricing/lists/{id}/archive', { params: { path: { id } } })),
      ),
    onSettled: () => invalidatePricing(queryClient),
  });
}

/** LS2, LP1: a list's fixed price for a pack, answered with the list's resulting price. */
export function useSetFixedPrice() {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: ({
      listId,
      productId,
      priceUsdUnits,
    }: {
      listId: string;
      productId: string;
      priceUsdUnits: number;
    }) =>
      withReauthentication(() =>
        call(
          api.PUT('/api/admin/pricing/lists/{id}/fixed-prices/{productId}', {
            params: { path: { id: listId, productId } },
            body: { priceUsdUnits },
          }),
        ),
      ),
    onSettled: () => invalidatePricing(queryClient),
  });
}

export function useArchiveFixedPrice() {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: ({ listId, productId }: { listId: string; productId: string }) =>
      withReauthentication(() =>
        call(
          api.DELETE('/api/admin/pricing/lists/{id}/fixed-prices/{productId}', {
            params: { path: { id: listId, productId } },
          }),
        ),
      ),
    onSettled: () => invalidatePricing(queryClient),
  });
}
