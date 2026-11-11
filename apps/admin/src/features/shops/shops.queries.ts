import {
  infiniteQueryOptions,
  keepPreviousData,
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  ApproveShop,
  SettleShopCustomer,
  ShopCompensationRequest,
  ShopSuspendReason,
  UpdateShop,
} from '@vertex-digital/contracts';
import { api, call } from '../../lib/api/client';
import { useReauthentication } from '../account/reauthentication';
import { type ShopsSearch, statusOf } from './shops-search';

/*
 * Merchant shops as the admin works them (S26 Screens): the list with the requests first, one
 * shop with its review and states (SH1–SH8), limits and slug, its customers with freeze and the
 * settlement of a closed shop (CA7, WL9), its orders, and a shop order's compensation (PR10).
 * Keys start with `shops`.
 */

export const shopsQuery = (search: ShopsSearch) =>
  infiniteQueryOptions({
    queryKey: ['shops', 'list', search],
    queryFn: ({ pageParam }) =>
      call(
        api.GET('/api/admin/shops', {
          params: { query: { status: statusOf(search), q: search.q, cursor: pageParam } },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });

export const shopQuery = (id: string) =>
  queryOptions({
    queryKey: ['shops', 'shop', id],
    queryFn: () => call(api.GET('/api/admin/shops/{id}', { params: { path: { id } } })),
  });

export const shopCustomersQuery = (id: string, q: string | undefined) =>
  infiniteQueryOptions({
    queryKey: ['shops', 'customers', id, q ?? ''],
    queryFn: ({ pageParam }) =>
      call(
        api.GET('/api/admin/shops/{id}/customers', {
          params: { path: { id }, query: { q, cursor: pageParam } },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });

export const shopOrdersQuery = (id: string) =>
  infiniteQueryOptions({
    queryKey: ['shops', 'orders', id],
    queryFn: ({ pageParam }) =>
      call(
        api.GET('/api/admin/shops/{id}/orders', {
          params: { path: { id }, query: { cursor: pageParam } },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

/** The shop's history: its audit entries, newest first. */
export const shopHistoryQuery = (id: string) =>
  queryOptions({
    queryKey: ['shops', 'history', id],
    queryFn: () =>
      call(
        api.GET('/api/admin/audit', {
          params: { query: { entityType: 'merchant_shop', entityId: id } },
        }),
      ),
  });

/**
 * A shop change shows in the list, the shop, its customers and orders, the order page, the
 * wallets and the audit log; every one goes through re-authentication when the API asks for it.
 */
function useShopsMutation<Input, Output>(request: (input: Input) => Promise<Output>) {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: (input: Input) => withReauthentication(() => request(input)),
    onSettled: () =>
      Promise.all(
        ['shops', 'orders', 'wallet', 'support', 'audit'].map((key) =>
          queryClient.invalidateQueries({ queryKey: [key] }),
        ),
      ),
  });
}

/** SH3, SH8: approves a request with its limits, the slug edited if needed. */
export const useApproveShop = (id: string) =>
  useShopsMutation((body: ApproveShop) =>
    call(api.POST('/api/admin/shops/{id}/approve', { params: { path: { id } }, body })),
  );

export const useRejectShop = (id: string) =>
  useShopsMutation((reason: string) =>
    call(api.POST('/api/admin/shops/{id}/reject', { params: { path: { id } }, body: { reason } })),
  );

/** SH6: the category the shop shows and the admin's own note. */
export const useSuspendShop = (id: string) =>
  useShopsMutation((body: { reason: ShopSuspendReason; note: string }) =>
    call(api.POST('/api/admin/shops/{id}/suspend', { params: { path: { id } }, body })),
  );

export const useResumeShop = (id: string) =>
  useShopsMutation(() =>
    call(api.POST('/api/admin/shops/{id}/resume', { params: { path: { id } } })),
  );

/** SH7: re-authenticated; the shop keeps selling to customers with a balance until settled. */
export const useCloseShop = (id: string) =>
  useShopsMutation((reason: string) =>
    call(api.POST('/api/admin/shops/{id}/close', { params: { path: { id } }, body: { reason } })),
  );

/** SH3, SH8, ST5: limits, the slug or clearing the announcement; re-authenticated. */
export const useUpdateShop = (id: string) =>
  useShopsMutation((body: UpdateShop) =>
    call(api.PATCH('/api/admin/shops/{id}', { params: { path: { id } }, body })),
  );

/** CA7: freeze or unfreeze a shop customer, with a reason. */
export const useShopCustomerFreeze = (customerId: string) =>
  useShopsMutation(({ frozen, reason }: { frozen: boolean; reason: string }) =>
    call(
      frozen
        ? api.POST('/api/admin/shop-customers/{id}/freeze', {
            params: { path: { id: customerId } },
            body: { reason },
          })
        : api.POST('/api/admin/shop-customers/{id}/unfreeze', {
            params: { path: { id: customerId } },
            body: { reason },
          }),
    ),
  );

/** WL9: a closed shop customer's whole balance, to the merchant or as a cash refund. */
export const useSettleShopCustomer = (shopId: string, customerId: string) =>
  useShopsMutation(({ body, key }: { body: SettleShopCustomer; key: string }) =>
    call(
      api.POST('/api/admin/shops/{id}/customers/{customerId}/settle', {
        params: { path: { id: shopId, customerId }, header: { 'Idempotency-Key': key } },
        body,
      }),
    ),
  );

/** PR10: Vertex's part and the margin from the merchant, the store or nobody. */
export const useCompensateShopOrder = (orderId: string) =>
  useShopsMutation(({ body, key }: { body: ShopCompensationRequest; key: string }) =>
    call(
      api.POST('/api/admin/orders/{id}/shop-compensation', {
        params: { path: { id: orderId }, header: { 'Idempotency-Key': key } },
        body,
      }),
    ),
  );
