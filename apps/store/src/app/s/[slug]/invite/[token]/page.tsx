import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ShopInvite } from '@/features/shop/auth-forms';
import { ts } from '@/features/shop/i18n';
import { ShopPageSkeleton, ShopWithData } from '@/features/shop/shop-route';

type Params = Promise<{ slug: string; token: string }>;

/** CA1: a token page: never indexed, never sent on as a referrer. */
export const metadata: Metadata = {
  title: ts('auth.inviteDescription'),
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function ShopInviteRoute({ params }: { params: Params }) {
  return (
    <Suspense fallback={<ShopPageSkeleton />}>
      <Invite params={params} />
    </Suspense>
  );
}

async function Invite({ params }: { params: Params }) {
  const { token } = await params;
  return (
    <ShopWithData
      params={params}
      render={(shop) => <ShopInvite slug={shop.slug} name={shop.name} token={token} />}
    />
  );
}
