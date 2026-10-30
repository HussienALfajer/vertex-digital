'use client';

import { Button } from '@vertex-digital/ui/components/button';
import { AscentBar } from '@vertex-digital/ui/components/page-header';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { useCallback } from 'react';
import { GameCard } from '@/features/catalog/game-card';
import { SCROLLER } from '@/features/catalog/scroller';
import { getSearchIndex } from '@/features/search/requests';
import { tm } from './i18n';
import { useMerchantRead } from './merchant-state';
import { getMerchantGames, getWatches } from './requests';

/** How many games the row shows, as a category's row does; the search reaches the others. */
const ROW_GAMES = 10;

/**
 * PS1: followed games first, then by the merchant's 30-day units, then the store's order; each with
 * its cover from the public search index (a game in early access is not in it, and shows its name).
 */
async function saleGames() {
  const [games, watches, index] = await Promise.all([
    getMerchantGames(),
    getWatches(),
    getSearchIndex(),
  ]);
  if (!games.ok) return games;
  const followed = new Set(watches.ok ? watches.data.games.map((game) => game.gameId) : []);
  const cards = new Map(index.ok ? index.data.games.map((game) => [game.id, game]) : []);
  const items = [...games.data.items]
    .sort(
      (a, b) =>
        Number(followed.has(b.id)) - Number(followed.has(a.id)) || b.recentUnits - a.recentUnits,
    )
    .slice(0, ROW_GAMES)
    .map((game) => {
      const card = cards.get(game.id);
      return {
        id: game.id,
        slug: game.slug,
        nameAr: game.nameAr,
        nameEn: card?.nameEn ?? '',
        cover: card?.cover ?? null,
        accentColor: null,
        status: card?.status ?? ('normal' as const),
      };
    });
  return { ok: true as const, data: items };
}

/** "ألعابك" (S21 PS1): the counter's way to its games, in place of the old game bar. */
export function SaleGamesRow() {
  const read = useCallback(() => saleGames(), []);
  const { state, reload } = useMerchantRead(read);
  if (state.status === 'not_merchant') return null;
  return (
    <section
      aria-labelledby="sale-games-title"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 pt-6"
    >
      <h2 id="sale-games-title" className="flex items-center gap-2 text-lg font-bold">
        <AscentBar className="h-5 w-1" />
        {tm('sale.yourGames')}
      </h2>
      {state.status === 'loading' && <Skeleton className="h-52 w-full" aria-hidden="true" />}
      {state.status === 'failed' && (
        <div className="flex flex-col items-start gap-2" role="alert">
          <p className="text-sm">{tm('sale.gamesFailed')}</p>
          <Button variant="outline" size="xl" onClick={() => void reload()}>
            {tm('common.retry')}
          </Button>
        </div>
      )}
      {state.status === 'ready' && (
        <ul className={`${SCROLLER} sm:grid-cols-3 lg:grid-cols-5`}>
          {state.data.map((game) => (
            <li key={game.id} className="w-36 shrink-0 snap-start sm:w-auto">
              <GameCard
                game={game}
                sizes="(min-width: 64rem) 220px, (min-width: 40rem) 30vw, 144px"
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
