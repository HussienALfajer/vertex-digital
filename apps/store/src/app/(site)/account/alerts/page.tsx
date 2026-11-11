import { PageHeader } from '@vertex-digital/ui/components/page-header';
import type { Metadata } from 'next';
import { PageBackLink } from '@/components/page-back-link';
import { AlertsPage } from '@/features/product-alerts/alerts-page';
import { ta } from '@/features/product-alerts/i18n';
import { t } from '@/lib/i18n';

export const metadata: Metadata = {
  title: ta('page.title'),
  robots: { index: false },
};

/** "تنبيهاتي" (S22 PA7): read in the browser with the session cookie, never cached. */
export default function AlertsRoute() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-10 md:py-16">
      <PageHeader
        back={<PageBackLink href="/account">{t('back.account')}</PageBackLink>}
        title={ta('page.title')}
        description={ta('page.subtitle')}
      />
      <AlertsPage />
    </div>
  );
}
