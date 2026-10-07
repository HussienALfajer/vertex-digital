import { PageHeader } from '@vertex-digital/ui/components/page-header';
import type { Metadata } from 'next';
import { ForgotPasswordPanel } from '@/features/auth/forgot-password-panel';
import { t } from '@/lib/i18n';

export const metadata: Metadata = {
  title: t('forgotPassword.title'),
  robots: { index: false },
};

export default function ForgotPasswordPage() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-8 px-4 py-10 md:py-16">
      <PageHeader title={t('forgotPassword.title')} description={t('forgotPassword.subtitle')} />
      <ForgotPasswordPanel />
    </div>
  );
}
