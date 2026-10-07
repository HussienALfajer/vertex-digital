import { type QueryClient, queryOptions, useQuery } from '@tanstack/react-query';
import { useRouteContext } from '@tanstack/react-router';
import { createAuthClient } from 'better-auth/client';
import { twoFactorClient } from 'better-auth/client/plugins';
import { accessEventOf, reportAccess } from './session-events';

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
  fetchOptions: {
    // An idle session or a pending password change ends the screen, whichever call finds it.
    onError: ({ error }) => {
      const event = accessEventOf((error as { code?: string }).code);
      if (event) reportAccess(event);
    },
  },
});

export interface AdminSession {
  user: {
    id: string;
    name: string;
    email: string;
    twoFactorEnabled: boolean;
    /** Set by `admin:create` and `admin:reset-password` (rule D1). */
    mustChangePassword: boolean;
  };
}

/** The signed-in admin, or null without a session. */
async function fetchSession(): Promise<AdminSession | null> {
  const { data, error } = await authClient.getSession();
  if (error) throw new Error(`Loading the session failed with HTTP ${error.status}`);
  if (!data) return null;
  const { id, name, email, twoFactorEnabled } = data.user;
  const mustChangePassword = !!(data.user as { mustChangePassword?: boolean }).mustChangePassword;
  return { user: { id, name, email, twoFactorEnabled: !!twoFactorEnabled, mustChangePassword } };
}

export const sessionQuery = queryOptions({
  queryKey: ['session'],
  queryFn: fetchSession,
  staleTime: 60_000,
  // Not read again on focus: Better Auth's get-session deletes an idle session and answers "no
  // session", so the panel would lose the reason. The next action the admin takes finds a session
  // that ended (sign-out elsewhere, a reset on the server) or went idle, and says which (rule D4).
  retry: false,
});

/** The signed-in admin inside the app shell. */
export function useSession(): AdminSession {
  const { session } = useRouteContext({ from: '/_app' });
  const { data } = useQuery(sessionQuery);
  return data ?? session;
}

/**
 * Where an admin who is signed in must go before the panel: the CLI-issued password is changed
 * first (rule D1), then TOTP is set up (ADR 0007). Null when the panel is open to them.
 */
export function setupStep(session: AdminSession): '/change-password' | '/setup-two-factor' | null {
  if (session.user.mustChangePassword) return '/change-password';
  if (needsTwoFactorSetup(session)) return '/setup-two-factor';
  return null;
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
