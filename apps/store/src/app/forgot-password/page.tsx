import type { Metadata } from 'next';
import { AuthFrame } from '@/components/auth-frame';
import { ForgotPasswordPanel } from '@/features/auth/forgot-password-panel';
import { t } from '@/lib/i18n';

export const metadata: Metadata = {
  title: t('forgotPassword.title'),
  robots: { index: false },
};

export default function ForgotPasswordPage() {
  return (
    <AuthFrame title={t('forgotPassword.title')} description={t('forgotPassword.subtitle')}>
      <ForgotPasswordPanel />
    </AuthFrame>
  );
}
