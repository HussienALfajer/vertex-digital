import {
  infiniteQueryOptions,
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  CreateSupplierCorrection,
  CreateTreasuryMovement,
  ExplainResult,
  ReconciliationOverview,
  ReconciliationSettings,
  ReverseTreasuryMovement,
  ShamCashCount,
  TreasuryPlace,
} from '@vertex-digital/contracts';
import { useEffect, useRef } from 'react';
import { api, BACKGROUND_REQUEST, call } from '../../lib/api/client';
import { useReauthentication } from '../account/reauthentication';

/*
 * The books as the admin checks them (S13, F20): the reconciliation's overview, runs, counts,
 * explanations and settings, and the treasury's money places, movements, supplier corrections and
 * reversals. Keys start with `reconciliation`; the treasury's sit under it, since every movement
 * changes what the overview and the places show.
 */

/** The navigation badge reads the open mismatches every minute in the background. */
const COUNTS_REFRESH_MS = 60_000;
/** While a run is running (or waits for its recheck), the overview is read again this often. */
const RUNNING_REFRESH_MS = 10_000;

export const reconciliationCountsQuery = queryOptions({
  queryKey: ['reconciliation', 'counts'],
  queryFn: () => call(api.GET('/api/admin/reconciliation/counts', { headers: BACKGROUND_REQUEST })),
  refetchInterval: COUNTS_REFRESH_MS,
});

const running = (overview: ReconciliationOverview | undefined) => !!overview?.running;

/**
 * The state of the books; read again in the background while a run is running or waits for its
 * recheck (not the admin's activity, rule D4), so its result shows when it ends.
 */
export const overviewQuery = queryOptions({
  queryKey: ['reconciliation', 'overview'],
  queryFn: ({ client, queryKey }) =>
    call(
      api.GET('/api/admin/reconciliation', {
        headers: running(client.getQueryData<ReconciliationOverview>(queryKey))
          ? BACKGROUND_REQUEST
          : undefined,
      }),
    ),
  refetchInterval: (query) => (running(query.state.data) ? RUNNING_REFRESH_MS : false),
});

export const placesQuery = queryOptions({
  queryKey: ['reconciliation', 'places'],
  queryFn: () => call(api.GET('/api/admin/treasury/places')),
});

export const movementsQuery = (place: TreasuryPlace | undefined) =>
  infiniteQueryOptions({
    queryKey: ['reconciliation', 'movements', place ?? 'all'],
    queryFn: ({ pageParam }) =>
      call(
        api.GET('/api/admin/treasury/movements', {
          params: { query: { place, cursor: pageParam } },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

export const runsQuery = infiniteQueryOptions({
  queryKey: ['reconciliation', 'runs'],
  queryFn: ({ pageParam }) =>
    call(api.GET('/api/admin/reconciliation/runs', { params: { query: { cursor: pageParam } } })),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (page) => page.nextCursor ?? undefined,
});

export const runQuery = (id: string) =>
  queryOptions({
    queryKey: ['reconciliation', 'run', id],
    queryFn: ({ client, queryKey }) =>
      call(
        api.GET('/api/admin/reconciliation/runs/{id}', {
          params: { path: { id } },
          headers:
            client.getQueryData<{ status: string }>(queryKey)?.status === 'running'
              ? BACKGROUND_REQUEST
              : undefined,
        }),
      ),
    // A run still running is read again until it ends (audit A09-36).
    refetchInterval: (query) =>
      query.state.data?.status === 'running' ? RUNNING_REFRESH_MS : false,
  });

export const settingsQuery = queryOptions({
  queryKey: ['reconciliation', 'settings'],
  queryFn: () => call(api.GET('/api/admin/reconciliation/settings')),
});

/** Every change here moves the overview, the places, the movements or the runs. */
const invalidateBooks = (queryClient: ReturnType<typeof useQueryClient>) =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: ['reconciliation'] }),
    // The dashboard's attention items name open mismatches and a count due.
    queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
  ]);

/**
 * When the overview sees a run end, the places, runs, badge and dashboard are read again: they
 * changed with the run, after the start's own invalidation (audit A09-29).
 */
export function useAfterRunEnds(overview: ReconciliationOverview | undefined) {
  const queryClient = useQueryClient();
  const runningId = overview ? (overview.running?.id ?? null) : undefined;
  const previous = useRef(runningId);
  useEffect(() => {
    if (previous.current && runningId === null) {
      void Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['reconciliation'],
          predicate: (query) => query.queryKey[1] !== 'overview',
        }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
    }
    if (runningId !== undefined) previous.current = runningId;
  }, [queryClient, runningId]);
}

/**
 * Rule RN2: a manual run, run by the worker (`202`). Not sensitive today (S13 Access), but
 * through the re-authentication as every admin mutation, so a later rule needs no change here.
 */
export function useStartRun() {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: () => withReauthentication(() => call(api.POST('/api/admin/reconciliation/runs'))),
    onSettled: () => invalidateBooks(queryClient),
  });
}

/** Rule RN8: a note on an open mismatch, once. */
export function useExplainResult() {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ExplainResult }) =>
      withReauthentication(() =>
        call(
          api.POST('/api/admin/reconciliation/results/{id}/explanation', {
            params: { path: { id } },
            body,
          }),
        ),
      ),
    onSettled: () => invalidateBooks(queryClient),
  });
}

/** Rules RN6, E4: a Sham Cash count, checked at once; the key replays it. */
export function useShamCashCount() {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: ({ body, key }: { body: ShamCashCount; key: string }) =>
      withReauthentication(() =>
        call(
          api.POST('/api/admin/reconciliation/sham-cash-counts', {
            params: { header: { 'Idempotency-Key': key } },
            body,
          }),
        ),
      ),
    onSettled: () => invalidateBooks(queryClient),
  });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: (body: ReconciliationSettings) =>
      withReauthentication(() => call(api.PUT('/api/admin/reconciliation/settings', { body }))),
    onSettled: () => invalidateBooks(queryClient),
  });
}

/**
 * Rules T2–T8: re-authentication when the API asks for it, retried with the same
 * `Idempotency-Key`, so a retry after a lost answer returns the first movement.
 */
export function useCreateMovement() {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: ({ body, key }: { body: CreateTreasuryMovement; key: string }) =>
      withReauthentication(() =>
        call(
          api.POST('/api/admin/treasury/movements', {
            params: { header: { 'Idempotency-Key': key } },
            // The API reads the schema's output: the switch is always sent.
            body: { ...body, openingBalance: body.openingBalance ?? false },
          }),
        ),
      ),
    onSettled: () => invalidateBooks(queryClient),
  });
}

/** Rule T5: the same rules as a movement. */
export function useCreateCorrection() {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: ({ body, key }: { body: CreateSupplierCorrection; key: string }) =>
      withReauthentication(() =>
        call(
          api.POST('/api/admin/treasury/supplier-corrections', {
            params: { header: { 'Idempotency-Key': key } },
            body,
          }),
        ),
      ),
    onSettled: () => invalidateBooks(queryClient),
  });
}

/** Rule T9: the mirror of a movement, once. */
export function useReverseMovement() {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: ({ id, body, key }: { id: string; body: ReverseTreasuryMovement; key: string }) =>
      withReauthentication(() =>
        call(
          api.POST('/api/admin/treasury/movements/{id}/reverse', {
            params: { path: { id }, header: { 'Idempotency-Key': key } },
            body,
          }),
        ),
      ),
    onSettled: () => invalidateBooks(queryClient),
  });
}
