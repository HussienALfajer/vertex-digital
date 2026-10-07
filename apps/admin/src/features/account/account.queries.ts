import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { AdminChangePassword, Reauthenticate } from '@vertex-digital/contracts';
import { api, call } from '../../lib/api/client';
import { authClient } from '../../lib/auth';
import { useReauthentication } from './reauthentication';

/*
 * The admin's own account (rules D5, D7): password, re-authentication and sessions, under
 * `/api/admin/me` and `/api/admin/auth`. Keys start with `account`.
 */

export const accountSessionsQuery = queryOptions({
  queryKey: ['account', 'sessions'],
  queryFn: () => call(api.GET('/api/admin/me/sessions')),
});

/** Rule D7: the current password; every other session is signed out. */
export function useChangePassword() {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: (body: AdminChangePassword) =>
      withReauthentication(() => call(api.POST('/api/admin/auth/change-password', { body }))),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['account', 'sessions'] }),
  });
}

/** Rule D5: password and TOTP open sensitive routes for 5 minutes. */
export function reauthenticate(body: Reauthenticate) {
  return call(api.POST('/api/admin/me/reauthenticate', { body }));
}

export function useRevokeSession() {
  const queryClient = useQueryClient();
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: (id: string) =>
      withReauthentication(() =>
        call(api.DELETE('/api/admin/me/sessions/{id}', { params: { path: { id } } })),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['account', 'sessions'] }),
  });
}

/** Rule D7: new backup codes need the password; the previous ones stop working. */
export function useGenerateBackupCodes() {
  const withReauthentication = useReauthentication();
  return useMutation({
    mutationFn: (password: string) =>
      withReauthentication(async () => {
        const { data, error } = await authClient.twoFactor.generateBackupCodes({ password });
        if (error || !data) throw error;
        return data.backupCodes;
      }),
  });
}
