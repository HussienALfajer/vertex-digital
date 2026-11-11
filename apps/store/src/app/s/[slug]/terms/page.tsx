import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ContentPageSkeleton, ContentPageView } from '@/features/content/content-page';
import { ts } from '@/features/shop/i18n';
import { shopPath } from '@/features/shop/paths';

export const metadata: Metadata = { title: ts('footer.terms') };

type Params = Promise<{ slug: string }>;

/** CA5: the store's terms in the shop's frame, back to the shop. */
export default function ShopTermsRoute({ params }: { params: Params }) {
  return (
    <Suspense fallback={<ContentPageSkeleton />}>
      <Page params={params} />
    </Suspense>
  );
}

async function Page({ params }: { params: Params }) {
  const { slug } = await params;
  return <ContentPageView page="terms" back={{ href: shopPath(slug), label: ts('back.home') }} />;
}
