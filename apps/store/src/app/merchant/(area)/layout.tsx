import { PageHeader } from '@vertex-digital/ui/components/page-header';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { PageBackLink } from '@/components/page-back-link';
import { tm } from '@/features/merchant-tools/i18n';
import { MerchantNav } from '@/features/merchant-tools/merchant-nav';
import { MerchantTierProvider } from '@/features/merchant-tools/tier-state';
import { t } from '@/lib/i18n';

// A title of its own here would cut the root template from the tools pages: they keep the
// store name after their own (audit A06-55).
export const metadata: Metadata = {
  title: { default: tm('title'), template: `%s · ${t('app.name')}` },
  robots: { index: false },
};

/**
 * S21: the merchant area's frame; everything about the merchant loads in the browser. The sections
 * sit between the title and the page on a phone, and beside both on a wide screen. S23 ID2, ID4:
 * the tier's badge beside the sections, and the celebration after a rise on any page of it.
 */
export default function MerchantLayout({ children }: { children: ReactNode }) {
  return (
    <MerchantTierProvider>
      <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-6 px-4 py-10 md:py-16 lg:grid-cols-[15rem_minmax(0,1fr)] lg:grid-rows-[auto_1fr] lg:gap-x-8">
        <PageHeader
          className="lg:col-start-2 lg:row-start-1"
          back={<PageBackLink href="/account">{t('back.account')}</PageBackLink>}
          title={tm('title')}
          description={tm('subtitle')}
        />
        <MerchantNav />
        <div className="min-w-0 lg:col-start-2 lg:row-start-2">{children}</div>
      </div>
    </MerchantTierProvider>
  );
}
