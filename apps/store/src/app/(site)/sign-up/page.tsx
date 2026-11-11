import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AuthFrame } from '@/components/auth-frame';
import { SignUpPanel } from '@/features/auth/sign-up-panel';
import { TermsAgreement } from '@/features/content/site-links';
import { t } from '@/lib/i18n';

export const metadata: Metadata = {
  title: t('signUp.title'),
  robots: { index: false },
};

export default function SignUpPage() {
  return (
    <AuthFrame title={t('signUp.title')} description={t('signUp.subtitle')}>
      <SignUpPanel
        terms={
          <Suspense fallback={null}>
            <TermsAgreement />
          </Suspense>
        }
      />
    </AuthFrame>
  );
}
