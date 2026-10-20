import { PageHeader } from '@vertex-digital/ui/components/page-header';
import type { Metadata } from 'next';
import { MerchantPage } from '@/features/merchant/merchant-page';
import { t } from '@/lib/i18n';

export const metadata: Metadata = {
  title: t('merchant.title'),
  robots: { index: false },
};

/** S20: read in the browser with the session cookie; nothing about the customer is rendered here. */
export default function MerchantRoute() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-10 md:py-16">
      <PageHeader title={t('merchant.title')} description={t('merchant.subtitle')} />
      <MerchantPage />
    </div>
  );
}
