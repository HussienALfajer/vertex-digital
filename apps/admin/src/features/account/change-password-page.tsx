import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { Button, toast } from '@vertex-digital/ui';
import { LogOutIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AuthHeading, AuthLayout } from '../../components/auth-layout';
import { authClient, leaveSession, sessionQuery, setupStep } from '../../lib/auth';
import { ChangePasswordForm } from './change-password-form';

/**
 * The forced change of a CLI-issued password (rule D1), before TOTP enrolment and before anything
 * else in the panel.
 */
export function ChangePasswordPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();

  async function signOut() {
    await authClient.signOut();
    await leaveSession(queryClient, () => router.navigate({ to: '/login' }));
  }

  return (
    <AuthLayout>
      <AuthHeading title={t('changePassword.title')} subtitle={t('changePassword.subtitle')} />
      <ChangePasswordForm
        submitClassName="w-full"
        onChanged={async () => {
          toast.add({ title: t('changePassword.changed'), type: 'success' });
          const session = await queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 });
          const step = session && setupStep(session);
          await router.navigate({ to: step ?? '/', replace: true });
        }}
      />
      <div className="border-t border-border pt-4">
        <Button variant="ghost" size="sm" onClick={signOut}>
          <LogOutIcon className="rtl:-scale-x-100" />
          {t('changePassword.signOut')}
        </Button>
      </div>
    </AuthLayout>
  );
}
