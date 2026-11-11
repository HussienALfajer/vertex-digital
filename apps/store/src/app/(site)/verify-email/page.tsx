import type { Metadata } from 'next';
import { AuthFrame } from '@/components/auth-frame';
import { VerifyEmailPanel } from '@/features/auth/verify-email-panel';
import { t } from '@/lib/i18n';

export const metadata: Metadata = {
  title: t('verifyEmail.title'),
  robots: { index: false },
};

export default function VerifyEmailPage() {
  return (
    <AuthFrame backHref="/sign-in" title={t('verifyEmail.title')}>
      <VerifyEmailPanel />
    </AuthFrame>
  );
}
