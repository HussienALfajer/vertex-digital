import type { Metadata } from 'next';
import { Suspense } from 'react';
import { getShopGame } from '@/features/shop/data';
import { ShopGamePage, ShopGameSkeleton } from '@/features/shop/game-page';
import { ts } from '@/features/shop/i18n';

type Props = { params: Promise<{ slug: string; game: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug, game } = await params;
  const read = await getShopGame(slug, game).catch(() => null);
  if (read?.status !== 'found') return { title: ts('notFound.title') };
  return { title: ts('game.title', { name: read.data.game.nameAr }) };
}

/** A shop's game (S26): from the shop's cache, read at request time. */
export default function ShopGameRoute({ params }: Props) {
  return (
    <Suspense fallback={<ShopGameSkeleton />}>
      <ShopGamePage params={params} />
    </Suspense>
  );
}
