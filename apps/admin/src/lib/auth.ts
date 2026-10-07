import { type QueryClient, queryOptions, useQuery } from '@tanstack/react-query';
import { useRouteContext } from '@tanstack/react-router';
import type { StaffRole } from '@vertex-digital/contracts';
import { createAuthClient } from 'better-auth/client';
import { inferAdditionalFields, twoFactorClient } from 'better-auth/client/plugins';

/**
 * The staff Better Auth instance (ADR 0007), served by the API at /api/admin/auth on the panel's
 * own origin (the Vite proxy locally, nginx in production).
 */
export const authClient = createAuthClient({
  baseURL: window.location.origin,
  basePath: '/api/admin/auth',
  plugins: [
    // The sign-in screen handles the two-factor step itself.
    twoFactorClient(),
    inferAdditionalFields({ user: { role: { type: 'string', required: true, input: false } } }),
  ],
});

export interface StaffSession {
  user: {
    id: string;
    name: string;
    email: string;
    role: StaffRole;
    twoFactorEnabled: boolean;
  };
}

/** The signed-in staff member, or null without a session. */
async function fetchSession(): Promise<StaffSession | null> {
  const { data, error } = await authClient.getSession();
  if (error) throw new Error(`Loading the session failed with HTTP ${error.status}`);
  if (!data) return null;
  const { id, name, email, role, twoFactorEnabled } = data.user;
  return {
    user: { id, name, email, role: role as StaffRole, twoFactorEnabled: !!twoFactorEnabled },
  };
}

export const sessionQuery = queryOptions({
  queryKey: ['session'],
  queryFn: fetchSession,
  staleTime: 60_000,
  // A role can change or the session end while the tab is open.
  refetchOnWindowFocus: 'always',
  retry: false,
});

/** The signed-in staff member inside the app shell. */
export function useSession(): StaffSession {
  const { session } = useRouteContext({ from: '/_app' });
  const { data } = useQuery(sessionQuery);
  return data ?? session;
}

/** TOTP is mandatory for staff (ADR 0007): nothing else is reachable until it is set up. */
export function needsTwoFactorSetup(session: StaffSession): boolean {
  return !session.user.twoFactorEnabled;
}

/**
 * Leaves the signed-in state after sign-out or an expired session: stops running requests, marks
 * the session gone, runs `navigate` (to the sign-in page), then drops every cached answer, so the
 * next staff member never sees the previous one's data.
 */
export async function leaveSession(
  queryClient: QueryClient,
  navigate: () => Promise<void>,
): Promise<void> {
  await queryClient.cancelQueries();
  queryClient.setQueryData(sessionQuery.queryKey, null);
  await navigate();
  queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'session' });
}
