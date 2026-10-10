'use client';

import { maskFieldValue, type SavedPlayer, type StoreField } from '@vertex-digital/contracts';
import { Button } from '@vertex-digital/ui/components/button';
import { PlusIcon, TriangleAlertIcon } from 'lucide-react';
import { t } from '@/lib/i18n';

/** The first of the game's fields the saved ID holds a value for: what its chip shows, masked. */
export function mainValue(player: SavedPlayer, fields: readonly StoreField[]): string | null {
  for (const field of fields) {
    const value = player.fields[field.key];
    if (value) return maskFieldValue(value);
  }
  const first = Object.values(player.fields)[0];
  return first ? maskFieldValue(first) : null;
}

/**
 * The customer's saved IDs for the game as chips (rules SP3, SP6, SP7), newest used first: the
 * label, the masked main value and the last checked name. A rejected ID warns; an incomplete one
 * fills what still applies. "معرّف جديد" types another one.
 */
export function SavedChips({
  players,
  fields,
  chosenId,
  onPick,
  onNew,
}: {
  players: SavedPlayer[];
  fields: readonly StoreField[];
  chosenId: string | null;
  onPick: (player: SavedPlayer) => void;
  onNew: () => void;
}) {
  const chosen = players.find((player) => player.id === chosenId) ?? null;
  return (
    <section aria-label={t('purchase.saved.title')} className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">{t('purchase.saved.title')}</p>
      <div className="flex flex-wrap gap-2">
        {players.map((player) => {
          const value = mainValue(player, fields);
          const pressed = player.id === chosenId;
          return (
            <Button
              key={player.id}
              variant={pressed ? 'primary' : 'outline'}
              aria-pressed={pressed}
              className="h-auto min-h-11 flex-col items-start gap-0 px-3 py-1.5 text-start"
              onClick={() => onPick(player)}
            >
              <span className="flex items-center gap-1 font-bold">
                {player.rejected && (
                  <TriangleAlertIcon
                    className="size-4 text-status-warning-foreground"
                    aria-label={t('purchase.saved.rejectedShort')}
                  />
                )}
                <bdi>{player.label}</bdi>
              </span>
              <span className="text-xs font-normal opacity-80">
                {value && <bdi dir="ltr">{value}</bdi>}
                {player.playerName && (
                  <>
                    {value && ' · '}
                    <bdi>{player.playerName}</bdi>
                  </>
                )}
              </span>
            </Button>
          );
        })}
        <Button
          variant={chosenId === null ? 'secondary' : 'ghost'}
          aria-pressed={chosenId === null}
          className="min-h-11"
          onClick={onNew}
        >
          <PlusIcon aria-hidden="true" />
          {t('purchase.saved.new')}
        </Button>
      </div>
      {chosen?.rejected && (
        <p className="text-sm text-status-warning-foreground">{t('purchase.saved.rejected')}</p>
      )}
      {chosen && !chosen.complete && (
        <p className="text-sm text-muted-foreground">{t('purchase.saved.incomplete')}</p>
      )}
    </section>
  );
}
