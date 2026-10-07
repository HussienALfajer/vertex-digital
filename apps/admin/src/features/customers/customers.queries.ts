import { infiniteQueryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateTestCustomer } from '@vertex-digital/contracts';
import { api, call } from '../../lib/api/client';
import { useReauthentication } from '../account/reauthentication';

/*
 * Customers as the admin sees them. S01 has test customers only (rules T1–T4), under
 * `/api/admin/test-customers`. Keys start with `customers`.
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
