import { Suspense } from 'react';
import { HomeHero, StorefrontSections, StorefrontSkeleton } from '@/features/catalog/home-page';
import { HomeBanners } from '@/features/content/home-banners';
import { HomeMerchantSlot, SaleGamesSlot } from '@/features/merchant-tools/home-slot';
import { QuickBuySlot } from '@/features/quick-buy/quick-buy-slot';

/**
 * The storefront (S09 rule SF1): a static hero, the live banners (S14 SL2), the signed-in
 * customer's "اشحن مجدداً" read in the browser (S22 QB6), then the cached catalog. S21 PS1: a
 * merchant's sidebar and sale switch in the grid's empty cells, and in the sale mode the search,
 * "ألعابك" and the categories. For anyone else the first column and row stay empty, at no size.
 */
export default function HomePage() {
  return (
    <div className="lg:grid lg:grid-cols-[auto_minmax(0,1fr)]">
      <HomeMerchantSlot />
      <div className="min-w-0 lg:col-start-2">
        <HomeHero />
        <SaleGamesSlot />
        <div className="[[data-sale-mode-hint]_&]:hidden">
          <Suspense fallback={null}>
            <HomeBanners />
          </Suspense>
          <QuickBuySlot />
        </div>
        <Suspense fallback={<StorefrontSkeleton />}>
          <StorefrontSections />
        </Suspense>
      </div>
    </div>
  );
}
