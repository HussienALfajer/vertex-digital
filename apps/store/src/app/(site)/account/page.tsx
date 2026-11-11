import { PageHeader } from '@vertex-digital/ui/components/page-header';
import type { Metadata } from 'next';
import { PageBackLink } from '@/components/page-back-link';
import { AccountPage } from '@/features/account/account-page';
import { t } from '@/lib/i18n';

export const metadata: Metadata = {
  title: t('account.title'),
  robots: { index: false },
};

/** Read in the browser with the session cookie: nothing about the customer is rendered here. */
export default function AccountRoute() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-10 md:py-16">
      <PageHeader
        back={<PageBackLink href="/">{t('back.home')}</PageBackLink>}
        title={t('account.title')}
        description={t('account.subtitle')}
      />
      <AccountPage />
    </div>
  );
}
