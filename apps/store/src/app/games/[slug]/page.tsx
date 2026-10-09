import type { Metadata } from 'next';
import { Suspense } from 'react';
import { GamePage, GameSkeleton, gameOf } from '@/features/catalog/game-page';
import { t } from '@/lib/i18n';
import { storeUrl } from '@/lib/server-env';

type Props = { params: Promise<{ slug: string }> };

/** Rule SF6: "شحن <name> | VERTEX DIGITAL", a description from the names and notes, the cover. */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const data = await gameOf(slug);
  if (!data) return { title: t('notFound.title'), robots: { index: false } };
  const { game } = data;
  const description = [
    t('game.description', { name: game.nameAr, english: game.nameEn }),
    game.regionNotesAr,
  ]
    .filter(Boolean)
    .join(' ');
  return {
    title: { absolute: t('game.metaTitle', { name: game.nameAr }) },
    description,
    openGraph: {
      title: t('game.metaTitle', { name: game.nameAr }),
      description,
      ...(game.cover && {
        images: [{ url: `${storeUrl()}${game.cover.url}?w=640`, alt: game.nameAr }],
      }),
    },
  };
}

/** A game page: the slug is known at request time, the data comes from the `catalog` cache. */
export default function GameRoute({ params }: Props) {
  return (
    <Suspense fallback={<GameSkeleton />}>
      <GamePage params={params} />
    </Suspense>
  );
}
