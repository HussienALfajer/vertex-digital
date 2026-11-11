import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ContentPageSkeleton, ContentPageView } from '@/features/content/content-page';
import { ts } from '@/features/shop/i18n';
import { shopPath } from '@/features/shop/paths';

export const metadata: Metadata = { title: ts('footer.privacy') };

type Params = Promise<{ slug: string }>;

/** The store's privacy page in the shop's frame, back to the shop. */
export default function ShopPrivacyRoute({ params }: { params: Params }) {
  return (
    <Suspense fallback={<ContentPageSkeleton />}>
      <Page params={params} />
    </Suspense>
  );
}

async function Page({ params }: { params: Params }) {
  const { slug } = await params;
  return <ContentPageView page="privacy" back={{ href: shopPath(slug), label: ts('back.home') }} />;
}
