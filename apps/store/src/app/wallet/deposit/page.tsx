import { PageHeader } from '@vertex-digital/ui/components/page-header';
import type { Metadata } from 'next';
import { DepositFormPage } from '@/features/deposits/deposit-form';
import { t } from '@/lib/i18n';

export const metadata: Metadata = {
  title: t('deposits.form.title'),
  robots: { index: false },
};

/** Read in the browser with the session cookie and never cached (rule SC15). */
export default function DepositRoute() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-10 md:py-16">
      <PageHeader title={t('deposits.form.title')} description={t('deposits.form.subtitle')} />
      <DepositFormPage />
    </div>
  );
}
