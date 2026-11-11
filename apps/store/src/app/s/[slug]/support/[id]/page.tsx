import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ts } from '@/features/shop/i18n';
import { ShopPageSkeleton } from '@/features/shop/shop-route';
import { ShopTicketPage } from '@/features/shop/support-pages';

type Params = Promise<{ slug: string; id: string }>;

export const metadata: Metadata = { title: ts('support.title') };

export default function ShopTicketRoute({ params }: { params: Params }) {
  return (
    <Suspense fallback={<ShopPageSkeleton />}>
      <Ticket params={params} />
    </Suspense>
  );
}

async function Ticket({ params }: { params: Params }) {
  const { slug, id } = await params;
  return <ShopTicketPage slug={slug} id={id} />;
}
