import {
  keepPreviousData,
  type QueryClient,
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  CatalogImage,
  CreateCategory,
  CreateGame,
  CreateInputField,
  CreateProduct,
  UpdateGame,
  UpdateInputField,
  UpdateProduct,
} from '@vertex-digital/contracts';
import { api, call } from '../../lib/api/client';
import { useReauthentication } from '../account/reauthentication';
import type { CatalogSearch } from './catalog-search';

/*
 * The catalog (S06, F08): categories, games and apps, their input fields and products, and the
 * catalog images. Keys start with `catalog`. A change can move counts and orders anywhere in the
 * catalog, and the pricing page names its targets, so every mutation reads both again.
 */

/** Every game of a category in one page: reorder takes the full list (rule CT5). */
const GAMES_PAGE_SIZE = 100;

export const categoriesQuery = (archived = false) =>
  queryOptions({
    queryKey: ['catalog', 'categories', { archived }],
    queryFn: () =>
      call(
        api.GET('/api/admin/catalog/categories', {
          params: { query: { archived: archived ? 'true' : undefined } },
        }),
      ),
  });

/** The games of one category, in their order, with the page's filters. */
export const gamesQuery = (categoryId: string, search: CatalogSearch) =>
  queryOptions({
    queryKey: ['catalog', 'games', categoryId, search],
    queryFn: () =>
      call(
        api.GET('/api/admin/catalog/games', {
          params: {
            query: {
              categoryId,
              status: search.status,
              archived: search.archived ? 'true' : undefined,
              q: search.q,
              pageSize: GAMES_PAGE_SIZE,
            },
          },
        }),
      ),
    placeholderData: keepPreviousData,
  });

/** Every unarchived game, for the pricing calculator's target picker. */
export const allGamesQuery = queryOptions({
  queryKey: ['catalog', 'games', 'all'],
  queryFn: () =>
    call(api.GET('/api/admin/catalog/games', { params: { query: { pageSize: GAMES_PAGE_SIZE } } })),
});

export const gameQuery = (id: string) =>
  queryOptions({
    queryKey: ['catalog', 'game', id],
    queryFn: () => call(api.GET('/api/admin/catalog/games/{id}', { params: { path: { id } } })),
  });

const invalidateCatalog = (queryClient: QueryClient) =>
  Promise.all(
    ['catalog', 'pricing'].map((key) => queryClient.invalidateQueries({ queryKey: [key] })),
  );

/**
 * A catalog change through the re-authentication wrapper (rule D5), reading the catalog and the
 * pricing page again once it settled: a refusal may come from data that changed meanwhile (a
 * stale reorder list, edge case 2).
 */
function useCatalogMutation<Input, Output>(request: (input: Input) => Promise<Output>) {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: (input: Input) => withReauthentication(() => request(input)),
    onSettled: () => invalidateCatalog(queryClient),
  });
}

/** Rule CT10: the API re-encodes it to WebP; the game form saves the returned id. */
export function useUploadImage() {
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: (file: File) =>
      withReauthentication(() => {
        const body = new FormData();
        body.append('file', file);
        // openapi-fetch sends a FormData body as it is, with its multipart boundary.
        return call<CatalogImage>(api.POST('/api/admin/catalog/images', { body: body as never }));
      }),
  });
}

// Categories ------------------------------------------------------------------------------------

export const useCreateCategory = () =>
  useCatalogMutation((body: CreateCategory) =>
    call(api.POST('/api/admin/catalog/categories', { body })),
  );

export const useRenameCategory = () =>
  useCatalogMutation(({ id, nameAr }: { id: string; nameAr: string }) =>
    call(
      api.PATCH('/api/admin/catalog/categories/{id}', {
        params: { path: { id } },
        body: { nameAr },
      }),
    ),
  );

export const useReorderCategories = () =>
  useCatalogMutation((ids: string[]) =>
    call(api.PUT('/api/admin/catalog/categories/order', { body: { ids } })),
  );

export const useArchiveCategory = () =>
  useCatalogMutation(({ id, archive }: { id: string; archive: boolean }) =>
    call(
      archive
        ? api.POST('/api/admin/catalog/categories/{id}/archive', { params: { path: { id } } })
        : api.POST('/api/admin/catalog/categories/{id}/restore', { params: { path: { id } } }),
    ),
  );

// Games -----------------------------------------------------------------------------------------

export const useCreateGame = () =>
  useCatalogMutation((body: CreateGame) => call(api.POST('/api/admin/catalog/games', { body })));

export const useUpdateGame = (id: string) =>
  useCatalogMutation((body: UpdateGame) =>
    call(api.PATCH('/api/admin/catalog/games/{id}', { params: { path: { id } }, body })),
  );

export const useArchiveGame = (id: string) =>
  useCatalogMutation((archive: boolean) =>
    call(
      archive
        ? api.POST('/api/admin/catalog/games/{id}/archive', { params: { path: { id } } })
        : api.POST('/api/admin/catalog/games/{id}/restore', { params: { path: { id } } }),
    ),
  );

export const useReorderGames = (categoryId: string) =>
  useCatalogMutation((ids: string[]) =>
    call(
      api.PUT('/api/admin/catalog/categories/{id}/games/order', {
        params: { path: { id: categoryId } },
        body: { ids },
      }),
    ),
  );

// Input fields ----------------------------------------------------------------------------------

export const useCreateField = (gameId: string) =>
  useCatalogMutation((body: CreateInputField) =>
    call(
      api.POST('/api/admin/catalog/games/{id}/fields', {
        params: { path: { id: gameId } },
        body: body as never,
      }),
    ),
  );

export const useUpdateField = () =>
  useCatalogMutation(({ id, body }: { id: string; body: UpdateInputField }) =>
    call(api.PATCH('/api/admin/catalog/fields/{id}', { params: { path: { id } }, body })),
  );

export const useArchiveField = () =>
  useCatalogMutation(({ id, archive }: { id: string; archive: boolean }) =>
    call(
      archive
        ? api.POST('/api/admin/catalog/fields/{id}/archive', { params: { path: { id } } })
        : api.POST('/api/admin/catalog/fields/{id}/restore', { params: { path: { id } } }),
    ),
  );

export const useReorderFields = (gameId: string) =>
  useCatalogMutation((ids: string[]) =>
    call(
      api.PUT('/api/admin/catalog/games/{id}/fields/order', {
        params: { path: { id: gameId } },
        body: { ids },
      }),
    ),
  );

// Products --------------------------------------------------------------------------------------

export const useCreateProduct = (gameId: string) =>
  useCatalogMutation((body: CreateProduct) =>
    call(
      api.POST('/api/admin/catalog/games/{id}/products', {
        params: { path: { id: gameId } },
        body: body as never,
      }),
    ),
  );

export const useUpdateProduct = () =>
  useCatalogMutation(({ id, body }: { id: string; body: UpdateProduct }) =>
    call(api.PATCH('/api/admin/catalog/products/{id}', { params: { path: { id } }, body })),
  );

export const useArchiveProduct = () =>
  useCatalogMutation(({ id, archive }: { id: string; archive: boolean }) =>
    call(
      archive
        ? api.POST('/api/admin/catalog/products/{id}/archive', { params: { path: { id } } })
        : api.POST('/api/admin/catalog/products/{id}/restore', { params: { path: { id } } }),
    ),
  );

export const useReorderProducts = (gameId: string) =>
  useCatalogMutation((ids: string[]) =>
    call(
      api.PUT('/api/admin/catalog/games/{id}/products/order', {
        params: { path: { id: gameId } },
        body: { ids },
      }),
    ),
  );
