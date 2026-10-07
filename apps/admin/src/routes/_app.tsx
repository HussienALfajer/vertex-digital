import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { AppShell } from '../components/app-shell';
import { needsTwoFactorSetup, sessionQuery } from '../lib/auth';

/** Everything inside the shell requires a session; the API enforces it again on every call. */
export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ context, location }) => {
    const session = await context.queryClient.ensureQueryData(sessionQuery);
    if (!session) throw redirect({ to: '/login', search: { redirect: location.href } });
    // The admin sees nothing else until TOTP is set up (ADR 0007).
    if (needsTwoFactorSetup(session)) throw redirect({ to: '/setup-two-factor' });
    return { session };
  },
  component: AppLayout,
});

function AppLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
