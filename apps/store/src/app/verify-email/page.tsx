import { PageHeader } from '@vertex-digital/ui/components/page-header';
import type { Metadata } from 'next';
import { VerifyEmailPanel } from '@/features/auth/verify-email-panel';
import { t } from '@/lib/i18n';

export const metadata: Metadata = {
  title: t('verifyEmail.title'),
  robots: { index: false },
};

export default function VerifyEmailPage() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-8 px-4 py-10 md:py-16">
      <PageHeader title={t('verifyEmail.title')} />
      <VerifyEmailPanel />
    </div>
  );
}
