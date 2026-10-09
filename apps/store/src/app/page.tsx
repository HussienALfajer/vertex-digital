import { Suspense } from 'react';
import { HomeHero, StorefrontSections, StorefrontSkeleton } from '@/features/catalog/home-page';

/** The storefront (S09 rule SF1): a static hero, then the cached catalog. */
export default function HomePage() {
  return (
    <>
      <HomeHero />
      <Suspense fallback={<StorefrontSkeleton />}>
        <StorefrontSections />
      </Suspense>
    </>
  );
}
