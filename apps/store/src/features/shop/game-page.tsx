import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { Gamepad2Icon } from 'lucide-react';
import { notFound, permanentRedirect } from 'next/navigation';
import { connection } from 'next/server';
import type { CSSProperties } from 'react';
import { PageBackLink } from '@/components/page-back-link';
import { CatalogPicture } from '@/features/catalog/catalog-picture';
import { IdGuidePanel } from '@/features/catalog/id-guide-panel';
import { t } from '@/lib/i18n';
import { getShopGame } from './data';
import { ShopGameShop } from './game-shop';
import { ts } from './i18n';
import { ShopPackContent } from './pack-content';
import { shopPath } from './paths';
import { ShopStateBanner } from './state-banner';

type Params = Promise<{ slug: string; game: string }>;

export async function shopGameOf(params: Params) {
  const { slug, game } = await params;
  await connection();
  return getShopGame(slug, game);
}

/**
 * A shop's game page (S26 screens, PR1–PR5): the cover and names, "أين أجد المعرّف؟", the packs
 * at the selling prices and the buy box. A hidden game, a game the merchant cannot buy, or one of
 * another shop is not found; an old slug redirects to the same game under the new one.
 */
export async function ShopGamePage({ params }: { params: Params }) {
  const read = await shopGameOf(params);
  if (!read) notFound();
  if (read.status === 'moved') {
    const { game } = await params;
    permanentRedirect(shopPath(read.slug, `/games/${game}`));
  }
  const data = read.data;
  const { shop, game } = data;
  // The shop's color marks the chosen pack (ST1 keeps it readable in both themes).
  const accent = { '--game-accent': shop.brandColor, '--game-accent-light': shop.brandColor };
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 md:py-10">
      <PageBackLink href={shopPath(shop.slug)}>{ts('back.home')}</PageBackLink>
      <ShopStateBanner shop={shop} />
      <header className="flex flex-wrap items-start gap-4">
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
            {ts('game.title', { name: game.nameAr })}
          </h1>
          <p dir="ltr" className="text-end text-sm text-muted-foreground">
            {game.nameEn}
          </p>
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
      <div style={accent as CSSProperties}>
        <ShopGameShop
          data={data}
          cards={Object.fromEntries(
            data.products.map((product) => [
              product.id,
              <ShopPackContent key={product.id} product={product} />,
            ]),
          )}
        />
      </div>
    </div>
  );
}

export function ShopGameSkeleton() {
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
