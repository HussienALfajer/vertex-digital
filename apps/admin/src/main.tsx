import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { DirectionProvider, Toaster } from '@vertex-digital/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import i18n from './i18n';
import { ApiError } from './lib/api/client';
import { leaveSession } from './lib/auth';
import { accessEventOf, onAccess, reportAccess } from './lib/session-events';
import { routeTree } from './routeTree.gen';
import './styles.css';
// The Madani Arabic faces, when the licensed files exist at build time (vite.config.ts).
import 'virtual:madani-fonts';

/**
 * Reacts to access changes found by any request: an admin who must change the CLI-issued password
 * or set up TOTP goes to that page; a session ended by inactivity goes to sign-in with a notice;
 * any other 401 means the session ended. A sensitive action waiting for re-authentication is the
 * dialog's (features/account/reauthentication.tsx).
 */
function onApiError(error: Error) {
  if (!(error instanceof ApiError)) return;
  const event = accessEventOf(error.code);
  if (event) return reportAccess(event);
  if (error.status === 403 && error.code === 'TWO_FACTOR_REQUIRED') {
    void router.navigate({ to: '/setup-two-factor' });
  } else if (error.status === 401) {
    endSession();
  }
}

/** Several requests fail with 401 at once when a session ends: handle it once. */
let sessionEnding = false;

/** Back to the same page after signing in again; the cache goes with the session. */
function endSession(reason?: 'idle') {
  if (sessionEnding) return;
  sessionEnding = true;
  const location = router.state.location;
  const redirect = location.pathname === '/login' ? undefined : location.href;
  void leaveSession(queryClient, () =>
    router.navigate({ to: '/login', search: { ...(redirect ? { redirect } : {}), reason } }),
  ).finally(() => {
    sessionEnding = false;
  });
}

onAccess('idle-expired', () => endSession('idle'));
onAccess('password-change-required', () => void router.navigate({ to: '/change-password' }));

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onApiError }),
  mutationCache: new MutationCache({ onError: onApiError }),
  defaultOptions: {
    queries: {
      // Only what the admin does reads the API: a refetch on its own would count as activity and
      // keep an unattended panel signed in (rule D4). Polling, when it comes, sends
      // `X-Background-Request`.
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      // Do not retry what the server refused on purpose.
      retry: (failureCount, error) =>
        !(error instanceof ApiError && error.status < 500) && failureCount < 2,
    },
  },
});

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

document.title = i18n.t('app.name');

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <DirectionProvider direction="rtl">
      <QueryClientProvider client={queryClient}>
        <Toaster closeLabel={i18n.t('common.close')}>
          <RouterProvider router={router} />
        </Toaster>
      </QueryClientProvider>
    </DirectionProvider>
  </StrictMode>,
);
