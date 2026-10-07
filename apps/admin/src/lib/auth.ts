import { type QueryClient, queryOptions, useQuery } from '@tanstack/react-query';
import { useRouteContext } from '@tanstack/react-router';
import { createAuthClient } from 'better-auth/client';
import { twoFactorClient } from 'better-auth/client/plugins';

/**
 * The admin Better Auth instance (ADR 0007, 0016), served by the API at /api/admin/auth on the panel's
 * own origin (the Vite proxy locally, nginx in production).
 */
export const authClient = createAuthClient({
  baseURL: window.location.origin,
  basePath: '/api/admin/auth',
  plugins: [
    // The sign-in screen handles the two-factor step itself.
    twoFactorClient(),
  ],
});

export interface AdminSession {
  user: {
    id: string;
    name: string;
    email: string;
    twoFactorEnabled: boolean;
  };
}

/** The signed-in admin, or null without a session. */
async function fetchSession(): Promise<AdminSession | null> {
  const { data, error } = await authClient.getSession();
  if (error) throw new Error(`Loading the session failed with HTTP ${error.status}`);
  if (!data) return null;
  const { id, name, email, twoFactorEnabled } = data.user;
  return { user: { id, name, email, twoFactorEnabled: !!twoFactorEnabled } };
}

export const sessionQuery = queryOptions({
  queryKey: ['session'],
  queryFn: fetchSession,
  staleTime: 60_000,
  // The session can end (sign-out elsewhere, a reset on the server) while the tab is open.
  refetchOnWindowFocus: 'always',
  retry: false,
});

/** The signed-in admin inside the app shell. */
export function useSession(): AdminSession {
  const { session } = useRouteContext({ from: '/_app' });
  const { data } = useQuery(sessionQuery);
  return data ?? session;
}

/** TOTP is mandatory for the admin (ADR 0007): nothing else is reachable until it is set up. */
export function needsTwoFactorSetup(session: AdminSession): boolean {
  return !session.user.twoFactorEnabled;
}

/**
 * Leaves the signed-in state after sign-out or an expired session: stops running requests, marks
 * the session gone, runs `navigate` (to the sign-in page), then drops every cached answer, so no
 * later session ever sees the previous one's data.
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
