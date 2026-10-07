import { createFileRoute, redirect } from '@tanstack/react-router';
import { ChangePasswordPage } from '../features/account/change-password-page';
import { sessionQuery } from '../lib/auth';

/** Outside the shell: a CLI-issued password is changed before anything else (rule D1). */
export const Route = createFileRoute('/change-password')({
  beforeLoad: async ({ context, location }) => {
    const session = await context.queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 });
    if (!session) throw redirect({ to: '/login', search: { redirect: location.href } });
    if (!session.user.mustChangePassword) throw redirect({ to: '/' });
  },
  component: ChangePasswordPage,
});
