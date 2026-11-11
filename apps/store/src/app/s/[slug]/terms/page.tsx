import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ContentPageSkeleton, ContentPageView } from '@/features/content/content-page';
import { getPublishedPage } from '@/features/content/data';
import { ts } from '@/features/shop/i18n';
import { shopPath } from '@/features/shop/paths';

export const metadata: Metadata = { title: ts('footer.terms') };

type Params = Promise<{ slug: string }>;

/**
 * CA5: the merchant shops' terms (`shop_terms`) in the shop's frame, back to the shop; the
 * store's terms while no shop terms are published (what a sign-up then records).
 */
export default function ShopTermsRoute({ params }: { params: Params }) {
  return (
    <Suspense fallback={<ContentPageSkeleton />}>
      <Page params={params} />
    </Suspense>
  );
}

async function Page({ params }: { params: Params }) {
  const { slug } = await params;
  const shopTerms = await getPublishedPage('shop_terms');
  return (
    <ContentPageView
      page={shopTerms ? 'shop_terms' : 'terms'}
      back={{ href: shopPath(slug), label: ts('back.home') }}
    />
  );
}
