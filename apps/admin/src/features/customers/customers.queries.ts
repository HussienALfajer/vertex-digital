import {
  infiniteQueryOptions,
  keepPreviousData,
  queryOptions,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  CreateCustomerNote,
  CreateTestCustomer,
  CustomerStateChange,
  SetCustomerPriceList,
  UpdateCustomerLimits,
} from '@vertex-digital/contracts';
import { api, call } from '../../lib/api/client';
import { useReauthentication } from '../account/reauthentication';
import type { CustomerSearch } from './customer-search';

/*
 * Customers as the admin sees them. S01: test customers (rules T1–T4), under
 * `/api/admin/test-customers`. S12 (F19): the search, the profile and its tabs, the state changes
 * (CF, LM, AR, SN1) and the notes (SN2). Keys start with `customers`.
 */

export const testCustomersQuery = infiniteQueryOptions({
  queryKey: ['customers', 'test'],
  queryFn: ({ pageParam }) =>
    call(api.GET('/api/admin/test-customers', { params: { query: { cursor: pageParam } } })),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: (page) => page.nextCursor ?? undefined,
});

/** Rule T1: verified at once; the generated password comes back once. */
export function useCreateTestCustomer() {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: (body: CreateTestCustomer) =>
      withReauthentication(() => call(api.POST('/api/admin/test-customers', { body }))),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['customers'] }),
  });
}

/** Rule T2: a new generated password, shown once; every session of the customer signed out. */
export function useResetTestCustomerPassword() {
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: (id: string) =>
      withReauthentication(() =>
        call(
          api.POST('/api/admin/test-customers/{id}/reset-password', {
            params: { path: { id } },
          }),
        ),
      ),
  });
}

/* S12 ------------------------------------------------------------------------------------- */

/** Rule CS1: newest first, 25 a page; the search and the status tab are in the URL. */
export const customerListQuery = (search: CustomerSearch) =>
  infiniteQueryOptions({
    queryKey: ['customers', 'list', search],
    queryFn: ({ pageParam }) =>
      call(
        api.GET('/api/admin/customers', {
          params: {
            query: { q: search.q, status: search.status ?? 'all', cursor: pageParam } as never,
          },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });

/** Rule CS3: the profile, with the limits, the pinned note, the counts and the signals. */
export const customerQuery = (id: string) =>
  queryOptions({
    queryKey: ['customers', 'customer', id],
    queryFn: () => call(api.GET('/api/admin/customers/{id}', { params: { path: { id } } })),
  });

/** CS4 "الأجهزة": the active sessions. */
export const customerSessionsQuery = (id: string) =>
  queryOptions({
    queryKey: ['customers', 'sessions', id],
    queryFn: () =>
      call(api.GET('/api/admin/customers/{id}/sessions', { params: { path: { id } } })),
  });

/** CS4 "الأجهزة": the sign-in log, 50 a page (the first page is the last 50 sign-ins). */
export const customerSignInsQuery = (id: string) =>
  infiniteQueryOptions({
    queryKey: ['customers', 'sign-ins', id],
    queryFn: ({ pageParam }) =>
      call(
        api.GET('/api/admin/customers/{id}/sign-ins', {
          params: { path: { id }, query: { cursor: pageParam } as never },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

/** Rule SN2: newest first; the archived notes only when asked. */
export const customerNotesQuery = (id: string, archived: boolean) =>
  infiniteQueryOptions({
    queryKey: ['customers', 'notes', id, archived],
    queryFn: ({ pageParam }) =>
      call(
        api.GET('/api/admin/customers/{id}/notes', {
          params: { path: { id }, query: { archived, cursor: pageParam } as never },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

/** CS4 "السجل": the audit entries of the customer, its orders, deposits and tickets. */
export const customerHistoryQuery = (id: string) =>
  infiniteQueryOptions({
    queryKey: ['customers', 'history', id],
    queryFn: ({ pageParam }) =>
      call(
        api.GET('/api/admin/customers/{id}/history', {
          params: { path: { id }, query: { cursor: pageParam } as never },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

/** CS4 "الطلبات": the S08 admin list filtered to the customer, 25 a page. */
export const customerOrdersQuery = (customerId: string) =>
  infiniteQueryOptions({
    queryKey: ['customers', 'orders', customerId],
    queryFn: ({ pageParam }) =>
      call(
        api.GET('/api/admin/orders', {
          params: { query: { customerId, page: pageParam, pageSize: 25 } as never },
        }),
      ),
    initialPageParam: 1,
    getNextPageParam: (page) =>
      page.page * page.pageSize < page.total ? page.page + 1 : undefined,
  });

/** CS4 "الإيداعات": the S03 list filtered to the customer, both methods, every status. */
export const customerDepositsQuery = (customerId: string) =>
  infiniteQueryOptions({
    queryKey: ['customers', 'deposits', customerId],
    queryFn: ({ pageParam }) =>
      call(
        api.GET('/api/admin/deposits', {
          params: { query: { customerId, status: 'all', cursor: pageParam } as never },
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

/**
 * A customer change also shows on the orders (a freeze cancels reservations, CF1), the deposit
 * and order panels (CS6), the tickets (an archive closes them, AR2) and the audit log.
 */
function useCustomersMutation<Input, Output>(request: (input: Input) => Promise<Output>) {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: (input: Input) => withReauthentication(() => request(input)),
    onSettled: () =>
      Promise.all(
        ['customers', 'orders', 'deposits', 'support', 'wallet', 'audit', 'pricing'].map((key) =>
          queryClient.invalidateQueries({ queryKey: [key] }),
        ),
      ),
  });
}

/** CF1, CF6, AR1, AR3, SN1: each with its reason and re-authentication. */
export const CUSTOMER_STATE_ACTIONS = [
  'freeze',
  'unfreeze',
  'archive',
  'unarchive',
  'revoke',
] as const;

export type CustomerStateAction = (typeof CUSTOMER_STATE_ACTIONS)[number];

export const useCustomerStateChange = (id: string) =>
  useCustomersMutation(
    ({ action, body }: { action: CustomerStateAction; body: CustomerStateChange }) => {
      const params = { params: { path: { id } }, body };
      switch (action) {
        case 'freeze':
          return call(api.POST('/api/admin/customers/{id}/freeze', params));
        case 'unfreeze':
          return call(api.POST('/api/admin/customers/{id}/unfreeze', params));
        case 'archive':
          return call(api.POST('/api/admin/customers/{id}/archive', params));
        case 'unarchive':
          return call(api.POST('/api/admin/customers/{id}/unarchive', params));
        case 'revoke':
          return call(api.POST('/api/admin/customers/{id}/sessions/revoke', params));
      }
    },
  );

/**
 * S20 AT2, AT3: the account's list; null returns it to its type's default. Its reservations are
 * cancelled, so the orders are read again too.
 */
export const useSetCustomerPriceList = (id: string) =>
  useCustomersMutation((body: SetCustomerPriceList) =>
    call(api.PUT('/api/admin/customers/{id}/price-list', { params: { path: { id } }, body })),
  );

/** Rule LM5: null clears an override. */
export const useUpdateCustomerLimits = (id: string) =>
  useCustomersMutation((body: UpdateCustomerLimits) =>
    call(api.PUT('/api/admin/customers/{id}/limits', { params: { path: { id } }, body })),
  );

/** Rule SN2: a pinned note unpins the current one. */
export const useAddCustomerNote = (id: string) =>
  useCustomersMutation((body: CreateCustomerNote) =>
    call(
      api.POST('/api/admin/customers/{id}/notes', {
        params: { path: { id } },
        body: body as never,
      }),
    ),
  );

export type NoteAction = 'pin' | 'unpin' | 'archive';

export const useNoteAction = (id: string) =>
  useCustomersMutation(({ noteId, action }: { noteId: string; action: NoteAction }) => {
    const params = { params: { path: { id, noteId } } };
    switch (action) {
      case 'pin':
        return call(api.POST('/api/admin/customers/{id}/notes/{noteId}/pin', params));
      case 'unpin':
        return call(api.POST('/api/admin/customers/{id}/notes/{noteId}/unpin', params));
      case 'archive':
        return call(api.POST('/api/admin/customers/{id}/notes/{noteId}/archive', params));
    }
  });
