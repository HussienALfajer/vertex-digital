import { PageHeader } from '@vertex-digital/ui/components/page-header';
import type { Metadata } from 'next';
import { type ReactNode, Suspense } from 'react';
import { PageBackLink } from '@/components/page-back-link';
import { tm } from '@/features/merchant-tools/i18n';
import { MerchantNav, MerchantNavLinks } from '@/features/merchant-tools/merchant-nav';
import { MerchantTierBadge, MerchantTierProvider } from '@/features/merchant-tools/tier-state';
import { t } from '@/lib/i18n';

// A title of its own here would cut the root template from the tools pages: they keep the
// store name after their own (audit A06-55).
export const metadata: Metadata = {
  title: { default: tm('title'), template: `%s · ${t('app.name')}` },
  robots: { index: false },
};

/**
 * S21: the merchant area's frame; everything about the merchant loads in the browser. S23 ID2,
 * ID4: the tier's badge beside the title, and the celebration after a rise on any page of it.
 */
export default function MerchantLayout({ children }: { children: ReactNode }) {
  return (
    <MerchantTierProvider>
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-10 md:py-16">
        <PageHeader
          back={<PageBackLink href="/account">{t('back.account')}</PageBackLink>}
          title={tm('title')}
          description={tm('subtitle')}
          actions={<MerchantTierBadge />}
        />
        {/* A dynamic page (a month's statement) knows its URL only at request time. */}
        <Suspense fallback={<MerchantNavLinks pathname={null} />}>
          <MerchantNav />
        </Suspense>
        {children}
      </div>
    </MerchantTierProvider>
  );
}
