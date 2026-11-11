import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { PageBackLink } from '@/components/page-back-link';
import { tm } from '@/features/merchant-tools/i18n';
import {
  MerchantPageHeader,
  MerchantPhoneBar,
  MerchantSidebar,
} from '@/features/merchant-tools/merchant-nav';
import { MerchantTierProvider } from '@/features/merchant-tools/tier-state';
import { t } from '@/lib/i18n';

// A title of its own here would cut the root template from the tools pages: they keep the
// store name after their own (audit A06-55).
export const metadata: Metadata = {
  title: { default: tm('title'), template: `%s · ${t('app.name')}` },
  robots: { index: false },
};

/**
 * S21: the merchant area's frame; everything about the merchant loads in the browser. The header
 * names the page's section (owner, 2026-10-30). The sidebar
 * on a wide screen, its button between the title and the page on a phone. S23 ID2, ID4: the tier's
 * badge, and the celebration after a rise on any page of it.
 */
export default function MerchantLayout({ children }: { children: ReactNode }) {
  return (
    <MerchantTierProvider>
      <div className="flex w-full">
        <MerchantSidebar />
        <div className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-6 px-4 py-10 md:py-16 lg:px-8">
          <MerchantPageHeader
            back={<PageBackLink href="/account">{t('back.account')}</PageBackLink>}
          />
          <MerchantPhoneBar />
          <div className="min-w-0">{children}</div>
        </div>
      </div>
    </MerchantTierProvider>
  );
}
