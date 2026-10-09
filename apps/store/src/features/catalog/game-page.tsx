import type { StoreGame } from '@vertex-digital/contracts';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { Gamepad2Icon } from 'lucide-react';
import { notFound } from 'next/navigation';
import { t } from '@/lib/i18n';
import { CatalogPicture } from './catalog-picture';
import { getGame } from './data';
import { accentStyle } from './game-card';
import { GameShop } from './game-shop';
import { IdGuidePanel } from './id-guide-panel';
import { PackContent } from './pack-card';
import { GameStatusChip } from './service-status';

/** A slug the API could answer (S06 `slugSchema`); anything else is not found without a call. */
export const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export async function gameOf(slug: string): Promise<StoreGame | null> {
  return slug.length <= 48 && SLUG.test(slug) ? getGame(slug) : null;
}

/**
 * A game page (S09 screens): the hero with the accent as a flat band, the cover, the names, the
 * status chip and the region notes; "أين أجد المعرّف؟"; the packs, the calculator and the buy box.
 * Unknown, archived and paused games are not found (rule SF1).
 */
export async function GamePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const data = await gameOf(slug);
  if (!data) notFound();
  const { game } = data;
  return (
    <div style={accentStyle(game.accentColor)} className="flex flex-col">
      <div aria-hidden="true" className="h-2 bg-(--game-accent)" />
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 md:py-10">
        <header className="flex items-start gap-4">
          {game.cover ? (
            <CatalogPicture
              image={game.cover}
              sizes="(min-width: 48rem) 128px, 96px"
              priority
              className="size-24 shrink-0 md:size-32"
            />
          ) : (
            <span className="flex size-24 shrink-0 items-center justify-center rounded-lg border border-border bg-muted md:size-32">
              <Gamepad2Icon className="size-8 text-muted-foreground" aria-hidden="true" />
            </span>
          )}
          <div className="flex min-w-0 flex-col gap-2">
            <h1 className="text-2xl font-bold break-words md:text-3xl">
              {t('game.title', { name: game.nameAr })}
            </h1>
            <p dir="ltr" className="text-end text-sm text-muted-foreground">
              {game.nameEn}
            </p>
            <GameStatusChip status={game.status} />
            {game.regionNotesAr && (
              <p className="text-sm whitespace-pre-line text-muted-foreground">
                {game.regionNotesAr}
              </p>
            )}
          </div>
        </header>
        {game.idGuide && (
          <IdGuidePanel>
            <CatalogPicture
              image={game.idGuide}
              sizes="(min-width: 48rem) 40rem, 92vw"
              alt={t('purchase.idGuideAlt', { game: game.nameAr })}
              className="h-auto w-full max-w-2xl"
            />
          </IdGuidePanel>
        )}
        <GameShop
          data={data}
          cards={Object.fromEntries(
            data.products.map((product) => [
              product.id,
              <PackContent key={product.id} product={product} />,
            ]),
          )}
        />
      </div>
    </div>
  );
}

export function GameSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8" aria-hidden="true">
      <div className="flex gap-4">
        <Skeleton className="size-24 md:size-32" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-4 w-1/3" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {['a', 'b', 'c', 'd', 'e', 'f'].map((key) => (
          <Skeleton key={key} className="h-32 w-full" />
        ))}
      </div>
    </div>
  );
}
