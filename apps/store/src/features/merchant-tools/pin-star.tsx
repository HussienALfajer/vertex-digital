'use client';

import { PINNED_GAMES_MAX } from '@vertex-digital/contracts';
import { Button } from '@vertex-digital/ui/components/button';
import { StarIcon } from 'lucide-react';
import { errorText } from '@/lib/errors';
import { tm } from './i18n';
import { togglePinned, usePinnedGames } from './pinned-games';

/**
 * The star that pins a game to "ألعابك" (owner, 2026-10-30), a merchant's only: on a game card
 * (`card`, over its cover) and on the game page (`page`, with its words). Loaded in the browser for
 * a merchant only (`PinStarSlot`), so the cached pages never carry it.
 */
export function PinStar({
  gameId,
  gameName,
  variant,
}: {
  gameId: string;
  gameName: string;
  variant: 'card' | 'page';
}) {
  const pinned = usePinnedGames();
  if (pinned.status !== 'ready') {
    return variant === 'page' ? <span aria-hidden="true" className="block h-11 w-28" /> : null;
  }
  const on = pinned.ids.includes(gameId);
  const full = !on && pinned.ids.length >= PINNED_GAMES_MAX;
  const label = on
    ? tm('pins.unpin', { name: gameName })
    : full
      ? tm('pins.full', { max: PINNED_GAMES_MAX })
      : tm('pins.pin', { name: gameName });
  const star = (
    <StarIcon
      aria-hidden="true"
      strokeWidth={1.75}
      className={on ? 'fill-current text-accent-text' : 'text-muted-foreground'}
    />
  );
  if (variant === 'card') {
    return (
      <Button
        variant="outline"
        size="icon"
        aria-pressed={on}
        aria-label={label}
        title={label}
        disabled={full}
        className="absolute top-3 end-3 bg-surface"
        onClick={() => void togglePinned(gameId)}
      >
        {star}
      </Button>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="outline"
        size="xl"
        aria-pressed={on}
        title={full ? label : undefined}
        disabled={full}
        onClick={() => void togglePinned(gameId)}
      >
        {star}
        {on ? tm('pins.pinned') : tm('pins.pinShort')}
      </Button>
      {full && <span className="text-xs text-muted-foreground">{label}</span>}
      {pinned.error && (
        <span role="alert" className="text-xs text-status-danger-foreground">
          {errorText(pinned.error)}
        </span>
      )}
    </div>
  );
}
