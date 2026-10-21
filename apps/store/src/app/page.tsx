import { Suspense } from 'react';
import { HomeHero, StorefrontSections, StorefrontSkeleton } from '@/features/catalog/home-page';
import { HomeBanners } from '@/features/content/home-banners';
import { QuickBuySlot } from '@/features/quick-buy/quick-buy-slot';

/**
 * The storefront (S09 rule SF1): a static hero, the live banners (S14 SL2), the signed-in
 * customer's "اشحن مجدداً" read in the browser (S22 QB6), then the cached catalog.
 */
export default function HomePage() {
  return (
    <>
      <HomeHero />
      <Suspense fallback={null}>
        <HomeBanners />
      </Suspense>
      <QuickBuySlot />
      <Suspense fallback={<StorefrontSkeleton />}>
        <StorefrontSections />
      </Suspense>
    </>
  );
}
