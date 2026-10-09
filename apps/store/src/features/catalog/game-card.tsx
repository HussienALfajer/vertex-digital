import type { Storefront } from '@vertex-digital/contracts';
import { Gamepad2Icon } from 'lucide-react';
import Link from 'next/link';
import type { CSSProperties } from 'react';
import { CatalogPicture } from './catalog-picture';
import { GameStatusChip } from './service-status';

export type StoreGameCard = Storefront['categories'][number]['games'][number];

/**
 * A game's accent (brand/identity.md §6) as the `--game-accent` variable, for the border on
 * hover, its chips and the selected pack's outline; the sand accent when the game has none.
 */
export function accentStyle(accentColor: string | null): CSSProperties {
  return { '--game-accent': accentColor ?? 'var(--color-accent)' } as CSSProperties;
}

/**
 * A game on the home page (S09 screens): the cover in the brand frame, the Arabic name, the
 * English name muted and the status chip; the accent on the border on hover. An `unavailable`
 * game is greyed, still linked: its page says why.
 */
export function GameCard({ game }: { game: StoreGameCard }) {
  const unavailable = game.status === 'unavailable';
  return (
    <Link
      href={`/games/${game.slug}`}
      style={accentStyle(game.accentColor)}
      className={`group flex h-full flex-col gap-3 rounded-lg border border-border bg-surface p-2 transition-colors duration-150 hover:border-(--game-accent) focus-visible:border-(--game-accent) ${unavailable ? 'opacity-60' : ''}`}
    >
      {game.cover ? (
        <CatalogPicture
          image={game.cover}
          sizes="(min-width: 64rem) 220px, (min-width: 40rem) 30vw, 45vw"
          className="aspect-square w-full"
        />
      ) : (
        <span
          aria-hidden="true"
          className="flex aspect-square w-full items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground"
        >
          <Gamepad2Icon className="size-8" />
        </span>
      )}
      <span className="flex flex-col gap-1 px-1 pb-1">
        <span className="font-bold break-words">{game.nameAr}</span>
        <span dir="ltr" className="text-end text-xs text-muted-foreground">
          {game.nameEn}
        </span>
        <GameStatusChip status={game.status} />
      </span>
    </Link>
  );
}
