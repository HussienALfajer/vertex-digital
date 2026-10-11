import { Suspense } from 'react';
import { HomeHero, StorefrontSections, StorefrontSkeleton } from '@/features/catalog/home-page';
import { HomeBanners } from '@/features/content/home-banners';

/** The storefront (S09 rule SF1): a static hero, the live banners (S14 SL2), then the cached catalog. */
export default function HomePage() {
  return (
    <>
      <HomeHero />
      <Suspense fallback={null}>
        <HomeBanners />
      </Suspense>
      <Suspense fallback={<StorefrontSkeleton />}>
        <StorefrontSections />
      </Suspense>
    </>
  );
}
