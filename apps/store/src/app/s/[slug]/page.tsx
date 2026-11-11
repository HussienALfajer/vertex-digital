import { Suspense } from 'react';
import { ShopHome, ShopHomeSkeleton } from '@/features/shop/home-page';

type Props = { params: Promise<{ slug: string }> };

/** A shop's home (S26): from the shop's cache, read at request time. */
export default function ShopHomeRoute({ params }: Props) {
  return (
    <Suspense fallback={<ShopHomeSkeleton />}>
      <ShopHome params={params} />
    </Suspense>
  );
}
