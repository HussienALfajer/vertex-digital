import { PageHeader } from '@vertex-digital/ui/components/page-header';
import type { Metadata } from 'next';
import { PageBackLink } from '@/components/page-back-link';
import { WalletPage } from '@/features/wallet/wallet-page';
import { t } from '@/lib/i18n';

export const metadata: Metadata = {
  title: t('wallet.title'),
  robots: { index: false },
};

/** Read in the browser with the session cookie and never cached (rule W10). */
export default function WalletRoute() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-10 md:py-16">
      <PageHeader
        back={<PageBackLink href="/">{t('back.home')}</PageBackLink>}
        title={t('wallet.title')}
        description={t('wallet.subtitle')}
      />
      <WalletPage />
    </div>
  );
}
