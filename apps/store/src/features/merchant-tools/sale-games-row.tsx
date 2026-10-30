'use client';

import { PINNED_GAMES_MAX, type YourGameSource, yourGames } from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui/components/badge';
import { Button } from '@vertex-digital/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@vertex-digital/ui/components/dialog';
import { AscentBar } from '@vertex-digital/ui/components/page-header';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon, StarIcon, XIcon } from 'lucide-react';
import { useCallback, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { GameCard, type StoreGameCard } from '@/features/catalog/game-card';
import { SCROLLER } from '@/features/catalog/scroller';
import { getSearchIndex } from '@/features/search/requests';
import { tm } from './i18n';
import { useMerchantRead } from './merchant-state';
import { loadPinnedGames, movePinned, setPinnedGames, usePinnedGames } from './pinned-games';
import { getMerchantGames, getWatches } from './requests';

/**
 * The store's games for the merchant, each with its card from the public search index (a game in
 * early access is not in it and shows its name), and the followed games.
 */
async function rowData() {
  const [games, watches, index] = await Promise.all([
    getMerchantGames(),
    getWatches(),
    getSearchIndex(),
  ]);
  if (!games.ok) return games;
  const cards = new Map(index.ok ? index.data.games.map((game) => [game.id, game]) : []);
  return {
    ok: true as const,
    data: {
      games: games.data.items.map((game) => {
        const card = cards.get(game.id);
        const shown: StoreGameCard = {
          id: game.id,
          slug: game.slug,
          nameAr: game.nameAr,
          nameEn: card?.nameEn ?? '',
          cover: card?.cover ?? null,
          accentColor: null,
          status: card?.status ?? 'normal',
        };
        return { ...shown, recentUnits: game.recentUnits };
      }),
      followed: new Set(watches.ok ? watches.data.games.map((game) => game.gameId) : []),
    },
  };
}

/**
 * "ألعابك" (owner, 2026-10-30): the games the merchant pinned with the star, in their order, then,
 * while fewer than 10 are pinned, suggestions from the followed games and the last 30 days' units
 * marked "مقترحة". "ترتيب" moves the pinned ones up and down.
 */
export function SaleGamesRow() {
  const read = useCallback(() => rowData(), []);
  const { state, reload } = useMerchantRead(read);
  const pinned = usePinnedGames();
  const [arranging, setArranging] = useState(false);
  if (state.status === 'not_merchant') return null;
  const loading = state.status === 'loading' || pinned.status === 'loading';
  const failed = state.status === 'failed' || pinned.status === 'failed';
  const shown =
    state.status === 'ready' && pinned.status === 'ready'
      ? yourGames(state.data.games, pinned.ids, state.data.followed)
      : [];
  const names = new Map(
    state.status === 'ready' ? state.data.games.map((game) => [game.id, game.nameAr]) : [],
  );
  const pinnedIds =
    pinned.status === 'ready' ? pinned.ids.filter((id) => names.has(id)) : ([] as string[]);
  return (
    <section
      aria-labelledby="sale-games-title"
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 pt-6"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id="sale-games-title" className="flex items-center gap-2 text-lg font-bold">
          <AscentBar className="h-5 w-1" />
          {tm('sale.yourGames')}
        </h2>
        {pinnedIds.length > 0 && (
          <Button variant="ghost" size="xl" onClick={() => setArranging(true)}>
            <ArrowUpDownIcon aria-hidden="true" />
            {tm('pins.arrange')}
          </Button>
        )}
      </div>
      {loading && <Skeleton className="h-52 w-full" aria-hidden="true" />}
      {!loading && failed && (
        <div className="flex flex-col items-start gap-2" role="alert">
          <p className="text-sm">{tm('sale.gamesFailed')}</p>
          <Button
            variant="outline"
            size="xl"
            onClick={() => {
              void reload();
              void loadPinnedGames(true);
            }}
          >
            {tm('common.retry')}
          </Button>
        </div>
      )}
      {pinned.status === 'ready' && pinned.error && <FormAlert>{tm('pins.saveFailed')}</FormAlert>}
      {!loading && !failed && shown.length === 0 && (
        <div className="flex items-start gap-3 rounded-lg border border-dashed border-border p-4">
          <StarIcon className="mt-0.5 size-5 shrink-0 text-accent-text" aria-hidden="true" />
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">{tm('pins.empty')}</p>
            <p className="text-xs text-muted-foreground">{tm('pins.emptyHint')}</p>
          </div>
        </div>
      )}
      {shown.length > 0 && (
        <ul className={`${SCROLLER} sm:grid-cols-3 lg:grid-cols-5`}>
          {shown.map(({ game, source }) => (
            <li key={game.id} className="relative w-36 shrink-0 snap-start sm:w-auto">
              <GameCard
                game={game}
                sizes="(min-width: 64rem) 220px, (min-width: 40rem) 30vw, 144px"
              />
              <SourceBadge source={source} />
            </li>
          ))}
        </ul>
      )}
      <ArrangeDialog
        open={arranging}
        onOpenChange={setArranging}
        ids={pinnedIds}
        names={names}
        saving={pinned.status === 'ready' && pinned.saving}
      />
    </section>
  );
}

/** "مقترحة" over a suggested game's cover, at the start corner (the star holds the end one). */
function SourceBadge({ source }: { source: YourGameSource }) {
  if (source !== 'suggested') return null;
  return (
    <Badge tone="neutral" className="pointer-events-none absolute top-3 start-3">
      {tm('pins.suggested')}
    </Badge>
  );
}

/** "ترتيب": the pinned games with move up, move down and remove, each saved at once. */
function ArrangeDialog({
  open,
  onOpenChange,
  ids,
  names,
  saving,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ids: readonly string[];
  names: ReadonlyMap<string, string>;
  saving: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={tm('common.close')}>
        <DialogHeader>
          <DialogTitle>{tm('pins.arrangeTitle')}</DialogTitle>
          <DialogDescription>{tm('pins.arrangeBody')}</DialogDescription>
        </DialogHeader>
        <p className="text-xs text-muted-foreground tabular-nums">
          {tm('pins.count', { count: ids.length, max: PINNED_GAMES_MAX })}
        </p>
        {ids.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tm('pins.arrangeEmpty')}</p>
        ) : (
          <ol className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {ids.map((id, index) => {
              const name = names.get(id) ?? '';
              return (
                <li key={id} className="flex items-center gap-2 px-3 py-1">
                  <span className="w-6 shrink-0 text-xs text-muted-foreground tabular-nums">
                    {index + 1}
                  </span>
                  <bdi className="min-w-0 flex-1 truncate text-sm font-medium">{name}</bdi>
                  <fieldset aria-label={name} className="flex shrink-0 gap-1" disabled={saving}>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={tm('pins.moveUp', { name })}
                      disabled={index === 0}
                      onClick={() => void setPinnedGames(movePinned(ids, index, -1))}
                    >
                      <ArrowUpIcon aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={tm('pins.moveDown', { name })}
                      disabled={index === ids.length - 1}
                      onClick={() => void setPinnedGames(movePinned(ids, index, 1))}
                    >
                      <ArrowDownIcon aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={tm('pins.remove', { name })}
                      onClick={() => void setPinnedGames(ids.filter((other) => other !== id))}
                    >
                      <XIcon aria-hidden="true" />
                    </Button>
                  </fieldset>
                </li>
              );
            })}
          </ol>
        )}
        <Button size="xl" className="self-end" onClick={() => onOpenChange(false)}>
          {tm('pins.done')}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
