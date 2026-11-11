import type { Metadata } from 'next';
import { Suspense } from 'react';
import {
  ContentPageSkeleton,
  ContentPageView,
  contentPageMetadata,
} from '@/features/content/content-page';

export function generateMetadata(): Promise<Metadata> {
  return contentPageMetadata('terms');
}

/** S14 PG2: the newest published version, from the `content` cache; 404 while unpublished. */
export default function TermsRoute() {
  return (
    <Suspense fallback={<ContentPageSkeleton />}>
      <ContentPageView page="terms" />
    </Suspense>
  );
}
