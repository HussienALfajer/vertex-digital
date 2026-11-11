import type { Metadata } from 'next';
import { Suspense } from 'react';
import {
  ContentPageSkeleton,
  ContentPageView,
  contentPageMetadata,
} from '@/features/content/content-page';

export async function generateMetadata(): Promise<Metadata> {
  // S26 SP4: the shops' terms stay out of search engines, like the shops.
  return { ...(await contentPageMetadata('shop_terms')), robots: { index: false } };
}

/** S26 CA5: the newest published shop terms (the admin's preview path); 404 while unpublished. */
export default function ShopTermsRoute() {
  return (
    <Suspense fallback={<ContentPageSkeleton />}>
      <ContentPageView page="shop_terms" />
    </Suspense>
  );
}
