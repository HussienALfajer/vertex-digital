import { Suspense } from 'react';
import {
  CategoriesSkeleton,
  HomeHero,
  StorefrontCategories,
  StorefrontRows,
  StorefrontSkeleton,
} from '@/features/catalog/home-page';
import { HomeBanners } from '@/features/content/home-banners';
import { HomeMerchantSlot, SaleGamesSlot } from '@/features/merchant-tools/home-slot';
import { QuickBuySlot } from '@/features/quick-buy/quick-buy-slot';

/**
 * The storefront (S09 rule SF1; owner, 2026-10-30): the static hero with the search, the
 * categories, the live banners (S14 SL2), the signed-in customer's "اشحن مجدداً" read in the
 * browser (S22 QB6), then the games by category from the cached catalog. S21 PS1: a merchant's
 * sidebar and sale switch in the grid's empty cells; in the sale mode "ألعابك" follows the
 * categories and "اشحن مجدداً" steps aside, the banners stay. For anyone else the first column and
 * row stay empty, at no size.
 */
export default function HomePage() {
  return (
    <div className="lg:grid lg:grid-cols-[auto_minmax(0,1fr)]">
      <HomeMerchantSlot />
      <div className="min-w-0 lg:col-start-2">
        <HomeHero />
        <Suspense fallback={<CategoriesSkeleton />}>
          <StorefrontCategories />
        </Suspense>
        <SaleGamesSlot />
        <Suspense fallback={null}>
          <HomeBanners />
        </Suspense>
        <div className="[[data-sale-mode-hint]_&]:hidden">
          <QuickBuySlot />
        </div>
        <Suspense fallback={<StorefrontSkeleton />}>
          <StorefrontRows />
        </Suspense>
      </div>
    </div>
  );
}
