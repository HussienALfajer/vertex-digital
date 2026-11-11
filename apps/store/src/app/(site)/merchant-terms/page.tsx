import type { Metadata } from 'next';
import { Suspense } from 'react';
import {
  ContentPageSkeleton,
  ContentPageView,
  contentPageMetadata,
} from '@/features/content/content-page';

export function generateMetadata(): Promise<Metadata> {
  return contentPageMetadata('merchant_terms');
}

/** S20 MT1: the newest published merchant terms, from the `content` cache; 404 while unpublished. */
export default function MerchantTermsRoute() {
  return (
    <Suspense fallback={<ContentPageSkeleton />}>
      <ContentPageView page="merchant_terms" />
    </Suspense>
  );
}
