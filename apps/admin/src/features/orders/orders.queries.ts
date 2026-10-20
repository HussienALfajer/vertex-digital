import { keepPreviousData, queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  AdminPlayerCheck,
  CreateAdminOrder,
  DeliveryProof,
  FulfilOrder,
  LiveBoardQuery,
  OrderPolicy,
  PollAttempt,
  RefundOrder,
  RerouteOrder,
  ResolveAttempt,
  RevokeShareLink,
  UpdateGamePlayerCheck,
} from '@vertex-digital/contracts';
import { api, BACKGROUND_REQUEST, call } from '../../lib/api/client';
import { useReauthentication } from '../account/reauthentication';
import { listQuery, type OrderSearch } from './order-search';

/*
 * Orders as the admin works them (S08): the list with its tabs, the navigation badge, one order
 * with its attempts, the decisions (rules D1–D5), code reveals (C3) and the policy. S11: the live
 * board, an order's route options, reroute, the delivery proof and the manual fulfil. Keys start
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

/**
 * S16 SF4: the supplier's orders near an attempt's send, read live on the admin's request (one
 * read per 5 seconds per supplier); never retried, never applied by itself. Its key is outside
 * `orders`, so an order decision does not read the supplier again, and a read is dropped once
 * the panel closes, so an old read never shows as current.
 */
export const nearbySupplierOrdersQuery = (orderId: string, attemptId: string) =>
  queryOptions({
    queryKey: ['supplier-orders', orderId, attemptId],
    queryFn: () =>
      call(
        api.GET('/api/admin/orders/{id}/attempts/{attemptId}/supplier-orders', {
          params: { path: { id: orderId, attemptId } },
        }),
      ),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
  });

export const orderQuery = (id: string) =>
  queryOptions({
    queryKey: ['orders', 'order', id],
    queryFn: () => call(api.GET('/api/admin/orders/{id}', { params: { path: { id } } })),
  });

/**
 * F11-6: the order read again when the admin stream names it (a worker's refund after a partial
 * delivery, a webhook), as background work that never counts as the admin's activity (rule D4).
 */
export const orderStreamRead = (id: string) =>
  queryOptions({
    queryKey: orderQuery(id).queryKey,
    queryFn: () =>
      call(
        api.GET('/api/admin/orders/{id}', {
          params: { path: { id } },
          headers: BACKGROUND_REQUEST,
        }),
      ),
    staleTime: 0,
  });

/**
 * S11 rule LR5: the live board, read when the page opens and again on stream events, on focus
 * and every minute; each of those reads is background work, never the admin's activity (rule D4).
 */
export const liveBoardQuery = (query: LiveBoardQuery) =>
  queryOptions({
    queryKey: ['orders', 'live', query],
    queryFn: () =>
      call(
        api.GET('/api/admin/orders/live', {
          params: { query: query as never },
          headers: BACKGROUND_REQUEST,
        }),
      ),
    placeholderData: keepPreviousData,
  });

/** S11 rule RR2: every route of the order's product with its eligibility, read fresh each time. */
export const rerouteOptionsQuery = (id: string) =>
  queryOptions({
    queryKey: ['orders', 'routes', id],
    queryFn: () => call(api.GET('/api/admin/orders/{id}/routes', { params: { path: { id } } })),
    staleTime: 0,
  });

/** S11 rule MF2: a proof is served to the admin only once an attempt of the order holds it. */
export const proofUrl = (orderId: string, fileId: string) =>
  `/api/admin/orders/${orderId}/proofs/${fileId}`;

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

/** S11 rule RR3: closes the open attempt and sends the remaining units to the chosen route. */
export const useRerouteOrder = (orderId: string) =>
  useOrdersMutation(({ body, key }: { body: RerouteOrder; key: string }) =>
    call(
      api.POST('/api/admin/orders/{id}/reroute', {
        params: { path: { id: orderId }, header: { 'Idempotency-Key': key } },
        body,
      }),
    ),
  );

/** S11 rule MF2: the screenshot, re-encoded by the API; the fulfil sends the returned id. */
export function useUploadProof(orderId: string) {
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: (file: File) =>
      withReauthentication(() => {
        const body = new FormData();
        body.append('file', file);
        // openapi-fetch sends a FormData body as it is, with its multipart boundary.
        return call<DeliveryProof>(
          api.POST('/api/admin/orders/{id}/proof', {
            params: { path: { id: orderId } },
            body: body as never,
          }),
        );
      }),
  });
}

/**
 * S11 rules MF1–MF5: units delivered from another source, with their cost and proof. The codes
 * typed leave the mutation cache as soon as it settles (rule C1).
 */
export const useFulfilOrder = (orderId: string) =>
  useOrdersMutation(
    ({ body, key }: { body: FulfilOrder; key: string }) =>
      call(
        api.POST('/api/admin/orders/{id}/fulfil', {
          params: { path: { id: orderId }, header: { 'Idempotency-Key': key } },
          body: body as never,
        }),
      ),
    { gcTime: 0 },
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

/** S10 rule AD1: revokes a live share link with a reason; the API writes the audit entry. */
export const useRevokeShareLink = (orderId: string) =>
  useOrdersMutation(({ linkId, body }: { linkId: string; body: RevokeShareLink }) =>
    call(
      api.POST('/api/admin/orders/{id}/share-links/{linkId}/revoke', {
        params: { path: { id: orderId, linkId } },
        body,
      }),
    ),
  );

/* S16 purchases from the panel ------------------------------------------------------------- */

/** Rules AP4, AP7, AP8: the customer's wallet, caps and saved ids, and the owner cap today. */
export const purchaseContextQuery = (customerId: string | undefined, gameId?: string) =>
  queryOptions({
    queryKey: ['orders', 'purchase-context', customerId ?? null, gameId ?? null],
    queryFn: () =>
      call(
        api.GET('/api/admin/orders/purchase-context', {
          params: { query: customerId ? { customerId, ...(gameId && { gameId }) } : {} },
        }),
      ),
    staleTime: 0,
  });

/**
 * Rules AP2–AP13: one order, re-authenticated, with the dialog's `Idempotency-Key`; the customer's
 * wallet and the owner cap change with it.
 */
export const useCreateAdminOrder = () =>
  useOrdersMutation(({ body, key }: { body: CreateAdminOrder; key: string }) =>
    call(
      api.POST('/api/admin/orders', {
        params: { header: { 'Idempotency-Key': key } },
        body: body as never,
      }),
    ),
  );

/** Rule AP8: S09's check with the admin as requester; no re-authentication, nothing cached here. */
export function useAdminPlayerCheck() {
  return useMutation({
    mutationFn: (body: AdminPlayerCheck) =>
      call(api.POST('/api/admin/player-checks', { body: body as never })),
  });
}

/** S19 PC1: a game's check provider; null until the admin sets one. */
export const gamePlayerCheckQuery = (gameId: string) =>
  queryOptions({
    queryKey: ['orders', 'player-check', gameId],
    queryFn: () =>
      call(
        api.GET('/api/admin/catalog/games/{id}/player-check', { params: { path: { id: gameId } } }),
      ),
  });

/** S19 PC1: the game's check provider saved (audited), then the row and the audit log read again. */
export function useSetGamePlayerCheck(gameId: string) {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: (body: UpdateGamePlayerCheck) =>
      withReauthentication(() =>
        call(
          api.PUT('/api/admin/catalog/games/{id}/player-check', {
            params: { path: { id: gameId } },
            body: body as never,
          }),
        ),
      ),
    onSuccess: (state) => queryClient.setQueryData(gamePlayerCheckQuery(gameId).queryKey, state),
    onSettled: () =>
      Promise.all(
        [['orders', 'player-check', gameId], ['audit']].map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      ),
  });
}

export const useSetOrderPolicy = () =>
  useOrdersMutation((body: OrderPolicy) => call(api.PUT('/api/admin/orders/policy', { body })));
