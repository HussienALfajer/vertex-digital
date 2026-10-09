import { keepPreviousData, queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  OrderPolicy,
  PollAttempt,
  RefundOrder,
  ResolveAttempt,
} from '@vertex-digital/contracts';
import { api, BACKGROUND_REQUEST, call } from '../../lib/api/client';
import { useReauthentication } from '../account/reauthentication';
import { listQuery, type OrderSearch } from './order-search';

/*
 * Orders as the admin works them (S08): the list with its tabs, the navigation badge, one order
 * with its attempts, the decisions (rules D1–D5), code reveals (C3) and the policy. Keys start
 * with `orders`.
 */

/** The navigation badge reads its counts every minute in the background (S08 screens). */
const COUNTS_REFRESH_MS = 60_000;

export const orderCountsQuery = queryOptions({
  queryKey: ['orders', 'counts'],
  queryFn: () => call(api.GET('/api/admin/orders/counts', { headers: BACKGROUND_REQUEST })),
  refetchInterval: COUNTS_REFRESH_MS,
});

export const orderListQuery = (search: OrderSearch) =>
  queryOptions({
    queryKey: ['orders', 'list', search],
    queryFn: () =>
      call(api.GET('/api/admin/orders', { params: { query: listQuery(search) as never } })),
    placeholderData: keepPreviousData,
  });

export const orderQuery = (id: string) =>
  queryOptions({
    queryKey: ['orders', 'order', id],
    queryFn: () => call(api.GET('/api/admin/orders/{id}', { params: { path: { id } } })),
  });

export const orderPolicyQuery = queryOptions({
  queryKey: ['orders', 'policy'],
  queryFn: () => call(api.GET('/api/admin/orders/policy')),
});

/** A decision changes the order, the lists, the badge, the customer's wallet and the audit log. */
function useOrdersMutation<Input, Output>(
  request: (input: Input) => Promise<Output>,
  options: { gcTime?: number } = {},
) {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: (input: Input) => withReauthentication(() => request(input)),
    onSettled: () =>
      Promise.all(
        ['orders', 'wallet', 'audit'].map((key) =>
          queryClient.invalidateQueries({ queryKey: [key] }),
        ),
      ),
    ...options,
  });
}

/** Rule D4: polls the held attempt now; nothing changes until a result comes. */
export const usePollAttempt = (orderId: string) =>
  useOrdersMutation(({ attemptId, body }: { attemptId: string; body: PollAttempt }) =>
    call(
      api.POST('/api/admin/orders/{id}/attempts/{attemptId}/poll', {
        params: { path: { id: orderId, attemptId } },
        body,
      }),
    ),
  );

/**
 * Rules D2, D3: delivered (units, codes) or failed, with the attempt's `Idempotency-Key`. The
 * codes typed leave the mutation cache as soon as it settles (rule C1).
 */
export const useResolveAttempt = (orderId: string) =>
  useOrdersMutation(
    ({ attemptId, body, key }: { attemptId: string; body: ResolveAttempt; key: string }) =>
      call(
        api.POST('/api/admin/orders/{id}/attempts/{attemptId}/resolve', {
          params: { path: { id: orderId, attemptId }, header: { 'Idempotency-Key': key } },
          body: body as never,
        }),
      ),
    { gcTime: 0 },
  );

/** Rule D5: the remaining units back to the customer's wallet. */
export const useRefundOrder = (orderId: string) =>
  useOrdersMutation(({ body, key }: { body: RefundOrder; key: string }) =>
    call(
      api.POST('/api/admin/orders/{id}/refund', {
        params: { path: { id: orderId }, header: { 'Idempotency-Key': key } },
        body,
      }),
    ),
  );

/** Rule C3: a code's value, re-authenticated and logged; never kept in the mutation cache. */
export const useRevealCode = (orderId: string) =>
  useOrdersMutation(
    (codeId: string) =>
      call(
        api.POST('/api/admin/orders/{id}/codes/{codeId}/reveal', {
          params: { path: { id: orderId, codeId } },
        }),
      ),
    { gcTime: 0 },
  );

export const useSetOrderPolicy = () =>
  useOrdersMutation((body: OrderPolicy) => call(api.PUT('/api/admin/orders/policy', { body })));
