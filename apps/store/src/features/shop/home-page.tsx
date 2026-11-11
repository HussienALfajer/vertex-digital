import type { ShopStorefront } from '@vertex-digital/contracts';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { AscentBar } from '@vertex-digital/ui/components/page-header';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { MegaphoneIcon, StoreIcon } from 'lucide-react';
import { notFound, permanentRedirect } from 'next/navigation';
import { connection } from 'next/server';
import { GameCard } from '@/features/catalog/game-card';
import { getShopStorefront } from './data';
import { ts } from './i18n';
import { shopPath } from './paths';
import { ReturnRequestCard } from './return-request-card';
import { ShopSearch } from './shop-search';
import { ShopStateBanner } from './state-banner';

type Game = ShopStorefront['pinned'][number];

/**
 * A shop's home (S26 screens, PR1): the announcement, the state banner, the pending return
 * request, search, the merchant's pinned games, then the store's categories, hidden games left
 * out by the API. Read at request time from the shop's cache.
 */
export async function ShopHome({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  await connection();
  const read = await getShopStorefront(slug);
  if (!read) notFound();
  if (read.status === 'moved') permanentRedirect(shopPath(read.slug));
  const { shop, pinned, categories } = read.data;
  const shown = categories.filter((category) => category.games.length > 0);
  const games = uniqueGames([...pinned, ...shown.flatMap((category) => category.games)]);
  const card = (game: Game, index: number) => (
    <li key={game.id}>
      <GameCard
        game={game}
        priority={index < 4}
        href={shopPath(shop.slug, `/games/${game.slug}`)}
      />
    </li>
  );
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6">
      <h1 className="sr-only">{shop.name}</h1>
      <ShopStateBanner shop={shop} />
      {shop.announcement && (
        <aside
          aria-label={ts('home.announcement')}
          className="flex items-start gap-3 rounded-xl border border-(--shop-brand) bg-surface p-4"
        >
          <MegaphoneIcon
            className="mt-0.5 size-5 shrink-0 text-(--shop-brand)"
            aria-hidden="true"
          />
          <p className="text-base whitespace-pre-line break-words">{shop.announcement}</p>
        </aside>
      )}
      <ReturnRequestCard slug={shop.slug} />
      {games.length === 0 ? (
        <EmptyState
          icon={<StoreIcon />}
          title={ts('home.empty')}
          description={ts('home.emptyBody')}
        />
      ) : (
        <>
          <ShopSearch
            slug={shop.slug}
            games={games.map(({ slug: game, nameAr, nameEn }) => ({ slug: game, nameAr, nameEn }))}
          />
          {pinned.length > 0 && (
            <section aria-labelledby="pinned-title" className="flex flex-col gap-3">
              <h2 id="pinned-title" className="flex items-center gap-2 text-lg font-bold">
                <AscentBar className="h-5 w-1 bg-(--shop-brand)" />
                {ts('home.pinned')}
              </h2>
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                {pinned.map(card)}
              </ul>
            </section>
          )}
          {shown.map((category) => (
            <section
              key={category.slug}
              aria-labelledby={`category-${category.slug}`}
              className="flex flex-col gap-3"
            >
              <h2
                id={`category-${category.slug}`}
                className="flex items-center gap-2 text-lg font-bold"
              >
                <AscentBar className="h-5 w-1 bg-(--shop-brand)" />
                {category.nameAr}
              </h2>
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                {category.games.map((game, index) => card(game, pinned.length + index))}
              </ul>
            </section>
          ))}
        </>
      )}
    </div>
  );
}

function uniqueGames(games: Game[]): Game[] {
  const seen = new Set<string>();
  return games.filter((game) => !seen.has(game.id) && seen.add(game.id));
}

export function ShopHomeSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6" aria-hidden="true">
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-6 w-40" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {['a', 'b', 'c', 'd', 'e', 'f'].map((key) => (
          <Skeleton key={key} className="aspect-square w-full" />
        ))}
      </div>
    </div>
  );
}
