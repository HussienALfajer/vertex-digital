import type { Metadata } from 'next';
import { AuthFrame } from '@/components/auth-frame';
import { SignInForm } from '@/features/auth/sign-in-form';
import { t } from '@/lib/i18n';

export const metadata: Metadata = {
  title: t('signIn.title'),
  robots: { index: false },
};

export default function SignInPage() {
  return (
    <AuthFrame title={t('signIn.title')} description={t('signIn.subtitle')}>
      <SignInForm />
    </AuthFrame>
  );
}
