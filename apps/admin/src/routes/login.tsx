import { createFileRoute, redirect } from '@tanstack/react-router';
import { LoginPage } from '../features/account/login-page';
import { sessionQuery, setupStep } from '../lib/auth';
import { safeRedirect } from '../lib/safe-redirect';

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): { redirect?: string; reason?: 'idle' } => ({
    ...(typeof search.redirect === 'string' ? { redirect: safeRedirect(search.redirect) } : {}),
    // Why the previous session ended, for the notice above the form (rule D4).
    ...(search.reason === 'idle' ? { reason: 'idle' as const } : {}),
  }),
  beforeLoad: async ({ context, search }) => {
    const session = await context.queryClient.ensureQueryData(sessionQuery);
    if (!session) return;
    const step = setupStep(session);
    throw step ? redirect({ to: step }) : redirect({ href: safeRedirect(search.redirect) });
  },
  component: LoginRoute,
});

function LoginRoute() {
  const { redirect: target, reason } = Route.useSearch();
  return <LoginPage redirect={target} idle={reason === 'idle'} />;
}
