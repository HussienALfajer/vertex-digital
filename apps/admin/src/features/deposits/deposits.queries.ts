import {
  infiniteQueryOptions,
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  ApproveDeposit,
  DepositSettingsInput,
  RejectDeposit,
  RequestReceipt,
  StoredFileRef,
} from '@vertex-digital/contracts';
import { api, BACKGROUND_REQUEST, call } from '../../lib/api/client';
import { useReauthentication } from '../account/reauthentication';
import { type DepositSearch, tabOf } from './deposit-search';

/*
 * Sham Cash deposits as the admin works them (S03, F05): the queue and its badge, one deposit,
 * the decisions (rules RV1–RV10) and the deposit settings. Keys start with `deposits`.
 */

/** How often the navigation badge reads the counts (the spec: every 30 seconds). */
const COUNTS_REFRESH_MS = 30_000;

/** The navigation badge: read in the background, so it never counts as activity (rule D4). */
export const depositCountsQuery = queryOptions({
  queryKey: ['deposits', 'counts'],
  queryFn: () => call(api.GET('/api/admin/deposits/counts', { headers: BACKGROUND_REQUEST })),
  refetchInterval: COUNTS_REFRESH_MS,
});

/** The queue and the other tabs (rule RV10 for `submitted`); the search is in the URL. */
export const depositListQuery = (search: DepositSearch) =>
  infiniteQueryOptions({
    queryKey: ['deposits', 'list', search],
    queryFn: ({ pageParam }) =>
      call(
        api.GET('/api/admin/deposits', {
          params: { query: { status: tabOf(search), q: search.q, cursor: pageParam } },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

export const depositQuery = (id: string) =>
  queryOptions({
    queryKey: ['deposits', 'deposit', id],
    queryFn: () => call(api.GET('/api/admin/deposits/{id}', { params: { path: { id } } })),
  });

/** The receipt image: served to the admin only, never cached (rule SC15). */
export const receiptUrl = (depositId: string, receiptId: string) =>
  `/api/admin/deposits/${depositId}/receipts/${receiptId}`;

export const depositSettingsQuery = queryOptions({
  queryKey: ['deposits', 'settings'],
  queryFn: () => call(api.GET('/api/admin/deposit-settings')),
});

/** A QR image of the settings, by its file id. */
export const qrUrl = (fileId: string) => `/api/admin/deposit-settings/qr/${fileId}`;

/** A decision changes the deposit, the queue, the badge, and the customer's wallet. */
function useInvalidateDecision() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      ['deposits', 'wallet', 'audit'].map((key) =>
        queryClient.invalidateQueries({ queryKey: [key] }),
      ),
    );
}

/**
 * Rules RV1–RV5, RV9: re-authentication when the API asks for it (RV4), retried with the same
 * `Idempotency-Key`, so a retry after a lost answer returns the first decision.
 */
export function useApproveDeposit(id: string) {
  const invalidate = useInvalidateDecision();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: ({ body, key }: { body: ApproveDeposit; key: string }) =>
      withReauthentication(() =>
        call(
          api.POST('/api/admin/deposits/{id}/approve', {
            params: { path: { id }, header: { 'Idempotency-Key': key } },
            body,
          }),
        ),
      ),
    onSettled: invalidate,
  });
}

/** Rule RV6: no re-authentication (no money moves); the key makes a retry a replay (RV9). */
export function useRejectDeposit(id: string) {
  const invalidate = useInvalidateDecision();
  return useMutation({
    mutationFn: ({ body, key }: { body: RejectDeposit; key: string }) =>
      call(
        api.POST('/api/admin/deposits/{id}/reject', {
          params: { path: { id }, header: { 'Idempotency-Key': key } },
          body,
        }),
      ),
    onSettled: invalidate,
  });
}

/** Rule RV8: once per deposit, back to the customer for a clearer receipt. */
export function useRequestReceipt(id: string) {
  const invalidate = useInvalidateDecision();
  return useMutation({
    mutationFn: (body: RequestReceipt) =>
      call(
        api.POST('/api/admin/deposits/{id}/request-receipt', { params: { path: { id } }, body }),
      ),
    onSettled: invalidate,
  });
}

/** Saving the settings needs re-authentication; the store's options read them per request. */
export function useSaveDepositSettings() {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: (body: DepositSettingsInput) =>
      withReauthentication(() => call(api.PUT('/api/admin/deposit-settings', { body }))),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['deposits', 'settings'] }),
  });
}

/** A QR image, re-encoded by the API; its file id goes into the settings on save. */
export function useUploadQr() {
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: (file: File) =>
      withReauthentication(() => {
        const body = new FormData();
        body.append('file', file);
        // openapi-fetch sends a FormData body as it is, with its multipart boundary.
        return call<StoredFileRef>(
          api.POST('/api/admin/deposit-settings/qr', { body: body as never }),
        );
      }),
  });
}
