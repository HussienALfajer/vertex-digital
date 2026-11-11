import type { ShopPublic } from '@vertex-digital/contracts';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { type ReactNode, Suspense } from 'react';
import { getShopStorefront } from './data';

type Params = Promise<{ slug: string }>;

/**
 * A shop customer's page route: the slug is known at request time, the page is a static client
 * shell that reads its data in the browser.
 */
export function ShopRoute({
  params,
  render,
}: {
  params: Params;
  render: (slug: string) => ReactNode;
}) {
  return (
    <Suspense fallback={<ShopPageSkeleton />}>
      <WithSlug params={params} render={render} />
    </Suspense>
  );
}

async function WithSlug({
  params,
  render,
}: {
  params: Params;
  render: (slug: string) => ReactNode;
}) {
  const { slug } = await params;
  return render(slug);
}

/** A route that needs the shop itself (its name, its state): the cached storefront's shop. */
export function ShopWithData({
  params,
  render,
}: {
  params: Params;
  render: (shop: ShopPublic) => ReactNode;
}) {
  return (
    <Suspense fallback={<ShopPageSkeleton />}>
      <WithShop params={params} render={render} />
    </Suspense>
  );
}

async function WithShop({
  params,
  render,
}: {
  params: Params;
  render: (shop: ShopPublic) => ReactNode;
}) {
  const { slug } = await params;
  await connection();
  const read = await getShopStorefront(slug);
  // The layout redirects a moved shop and answers a missing one; this only waits for it.
  if (read?.status !== 'found') notFound();
  return render(read.data.shop);
}

export function ShopPageSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6" aria-hidden="true">
      <Skeleton className="h-9 w-40" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}
