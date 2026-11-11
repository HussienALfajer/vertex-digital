import type { Metadata, Viewport } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { connection } from 'next/server';
import { type ReactNode, Suspense } from 'react';
import { getShopStorefront } from '@/features/shop/data';
import { ts } from '@/features/shop/i18n';
import { shopApi, shopPath } from '@/features/shop/paths';
import { ShopFrame, ShopFrameSkeleton } from '@/features/shop/shop-frame';

type Props = { params: Promise<{ slug: string }> };

/**
 * SP1, SP4: the shop's name as every title, its icon and its own web manifest (the installed app
 * opens the shop, scoped to it), and never indexed.
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  // The cached read only: `connection()` here would block the route's metadata.
  const read = await getShopStorefront(slug).catch(() => undefined);
  if (read?.status !== 'found') {
    return { title: { absolute: ts('notFound.title') }, robots: { index: false, follow: false } };
  }
  const { shop } = read.data;
  return {
    // `absolute`: the store's own template (`… · VERTEX DIGITAL`) never wraps a shop's title.
    title: { absolute: ts('meta.title', { name: shop.name }), template: `%s · ${shop.name}` },
    description: ts('meta.description', { name: shop.name }),
    robots: { index: false, follow: false },
    manifest: shopPath(shop.slug, '/manifest.webmanifest'),
    icons: {
      icon: shopApi(shop.slug, '/icon?size=192'),
      apple: shopApi(shop.slug, '/icon?size=192'),
    },
    appleWebApp: { capable: true, title: shop.name, statusBarStyle: 'black' },
    referrer: 'same-origin',
  };
}

export const viewport: Viewport = { colorScheme: 'dark light' };

/**
 * A merchant's shop (S26): its own frame in place of the store's. The shop is read from the
 * cached storefront; an old slug redirects to the shop's current one (SH3, edge case 16), and no
 * shop is the shop's 404 without the store's links.
 */
export default function ShopLayout({ params, children }: Props & { children: ReactNode }) {
  return (
    <Suspense fallback={<ShopFrameSkeleton />}>
      <Frame params={params}>{children}</Frame>
    </Suspense>
  );
}

async function Frame({ params, children }: Props & { children: ReactNode }) {
  const { slug } = await params;
  await connection();
  const read = await getShopStorefront(slug);
  if (!read) notFound();
  if (read.status === 'moved') permanentRedirect(shopPath(read.slug));
  return <ShopFrame shop={read.data.shop}>{children}</ShopFrame>;
}
