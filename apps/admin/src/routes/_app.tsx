import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { AppShell } from '../components/app-shell';
import { ReauthenticationProvider } from '../features/account/reauthentication';
import { sessionQuery, setupStep } from '../lib/auth';

/** Everything inside the shell requires a session; the API enforces it again on every call. */
export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ context, location }) => {
    const session = await context.queryClient.ensureQueryData(sessionQuery);
    if (!session) throw redirect({ to: '/login', search: { redirect: location.href } });
    // The admin sees nothing else until the CLI-issued password is changed and TOTP is set up
    // (rule D1, ADR 0007).
    const step = setupStep(session);
    if (step) throw redirect({ to: step });
    return { session };
  },
  component: AppLayout,
});

function AppLayout() {
  return (
    <ReauthenticationProvider>
      <AppShell>
        <Outlet />
      </AppShell>
    </ReauthenticationProvider>
  );
}
