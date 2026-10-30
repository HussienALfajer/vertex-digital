import {
  ACCENT_LIGHT_SURFACE,
  ACCENT_MIN_CONTRAST,
  contrastRatio,
  type Storefront,
} from '@vertex-digital/contracts';
import { Gamepad2Icon } from 'lucide-react';
import Link from 'next/link';
import type { CSSProperties } from 'react';
import { CatalogPicture } from './catalog-picture';
import { GameStatusChip } from './service-status';

export type StoreCategory = Storefront['categories'][number];
export type StoreGameCard = StoreCategory['games'][number];

/**
 * A game's accent (brand/identity.md §6) as the `--game-accent` variable, for the border on
 * hover, its chips and the selected pack's outline; the sand accent when the game has none. Rule
 * CT6 checks an accent against the dark surface only, so `--game-accent-light` is the accent the
 * light theme may outline with: the game's own when it reaches 3:1 against white, else the
 * primary color, so a selected pack never loses its outline there (audit A8).
 */
export function accentStyle(accentColor: string | null): CSSProperties {
  const readableOnLight =
    accentColor !== null && contrastRatio(accentColor, ACCENT_LIGHT_SURFACE) >= ACCENT_MIN_CONTRAST;
  return {
    '--game-accent': accentColor ?? 'var(--color-accent)',
    '--game-accent-light': readableOnLight ? accentColor : 'var(--color-primary)',
  } as CSSProperties;
}

/**
 * A game on the home page (S09 screens): the cover in the brand frame, the Arabic name, the
 * English name muted and the status chip; the accent on the border on hover. An `unavailable`
 * game is greyed, still linked: its page says why.
 */
export function GameCard({
  game,
  priority = false,
  sizes = '(min-width: 64rem) 220px, (min-width: 40rem) 30vw, 45vw',
}: {
  game: StoreGameCard;
  priority?: boolean;
  sizes?: string;
}) {
  const unavailable = game.status === 'unavailable';
  return (
    <Link
      href={`/games/${game.slug}`}
      style={accentStyle(game.accentColor)}
      className={`group flex h-full flex-col gap-3 rounded-lg border border-border bg-surface p-2 transition-colors duration-150 hover:border-(--game-accent-light) focus-visible:border-(--game-accent-light) dark:hover:border-(--game-accent) dark:focus-visible:border-(--game-accent) ${unavailable ? 'opacity-60' : ''}`}
    >
      {game.cover ? (
        <CatalogPicture
          image={game.cover}
          sizes={sizes}
          priority={priority}
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
