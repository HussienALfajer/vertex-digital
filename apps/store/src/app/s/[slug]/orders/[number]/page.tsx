import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ts } from '@/features/shop/i18n';
import { ShopOrderPage } from '@/features/shop/order-page';
import { ShopPageSkeleton } from '@/features/shop/shop-route';

type Params = Promise<{ slug: string; number: string }>;

export const metadata: Metadata = { title: ts('orders.title') };

export default function ShopOrderRoute({ params }: { params: Params }) {
  return (
    <Suspense fallback={<ShopPageSkeleton />}>
      <Order params={params} />
    </Suspense>
  );
}

async function Order({ params }: { params: Params }) {
  const { slug, number } = await params;
  return <ShopOrderPage slug={slug} number={decodeURIComponent(number)} />;
}
