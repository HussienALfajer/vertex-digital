import { createFileRoute, redirect } from '@tanstack/react-router';
import { TwoFactorSetupPage } from '../features/account/two-factor-setup-page';
import { sessionQuery } from '../lib/auth';

/** Outside the shell: the admin without TOTP sees nothing else until they set it up (ADR 0007). */
export const Route = createFileRoute('/setup-two-factor')({
  beforeLoad: async ({ context, location, cause }) => {
    const session = await context.queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 });
    if (!session) throw redirect({ to: '/login', search: { redirect: location.href } });
    // The CLI-issued password is changed before TOTP is enrolled (rule D1).
    if (session.user.mustChangePassword) throw redirect({ to: '/change-password' });
    // 2FA turns on before the backup codes show: only a fresh visit leaves for the panel, not a
    // reload of the route while the codes are on screen (a cancelled "leave").
    if (session.user.twoFactorEnabled && cause !== 'stay') throw redirect({ to: '/' });
  },
  component: TwoFactorSetupPage,
});
