import { createFileRoute, redirect } from '@tanstack/react-router';
import { LoginPage } from '../features/account/login-page';
import { needsTwoFactorSetup, sessionQuery } from '../lib/auth';
import { safeRedirect } from '../lib/safe-redirect';

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search.redirect === 'string' ? { redirect: safeRedirect(search.redirect) } : {},
  beforeLoad: async ({ context, search }) => {
    const session = await context.queryClient.ensureQueryData(sessionQuery);
    if (session && needsTwoFactorSetup(session)) throw redirect({ to: '/setup-two-factor' });
    if (session) throw redirect({ href: safeRedirect(search.redirect) });
  },
  component: LoginRoute,
});

function LoginRoute() {
  const { redirect: target } = Route.useSearch();
  return <LoginPage redirect={target} />;
}
