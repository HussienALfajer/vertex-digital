'use client';

import { Button } from '@vertex-digital/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@vertex-digital/ui/components/dialog';
import { Input } from '@vertex-digital/ui/components/input';
import { ToggleGroup, ToggleGroupItem } from '@vertex-digital/ui/components/toggle-group';
import { CheckIcon, Gamepad2Icon } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useId, useState } from 'react';
import { CatalogPicture } from '@/features/catalog/catalog-picture';
import { getSearchIndex } from '@/features/search/requests';
import type { Result } from '@/lib/api';
import {
  findPickerGames,
  type PickerGame,
  pickerCategories,
  pickerGames,
  topPickerGames,
} from './game-picker-rules';
import { tm } from './i18n';
import { getMerchantGames } from './requests';

const ALL = 'all';

/** The picker's games: the merchant's, with their public covers (the index may fail: names only). */
export async function readPickerGames(): Promise<Result<PickerGame[]>> {
  const [games, index] = await Promise.all([getMerchantGames(), getSearchIndex()]);
  if (!games.ok) return games;
  return { ok: true, data: pickerGames(games.data.items, index.ok ? index.data : null) };
}

function Cover({ game, className }: { game: Pick<PickerGame, 'cover'>; className: string }) {
  return game.cover ? (
    <CatalogPicture image={game.cover} sizes="96px" className={`aspect-square ${className}`} />
  ) : (
    <span
      aria-hidden="true"
      className={`flex aspect-square shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground ${className}`}
    >
      <Gamepad2Icon className="size-5" />
    </span>
  );
}

/**
 * The chosen game as a compact bar with "تغيير" (owner, 2026-10-30), or, for several, their
 * count with the first covers. Opens the picker.
 */
export function ChosenGames({ games, onChange }: { games: PickerGame[]; onChange: () => void }) {
  const [first] = games;
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-surface p-2">
      {games.length <= 1 ? (
        first ? (
          <Cover game={first} className="size-12 shrink-0" />
        ) : null
      ) : (
        <span className="flex shrink-0 -space-x-3 rtl:space-x-reverse">
          {games.slice(0, 3).map((game) => (
            <Cover key={game.id} game={game} className="size-10 bg-surface" />
          ))}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        {games.length === 1 && first ? (
          <>
            <bdi className="truncate font-bold">{first.nameAr}</bdi>
            {first.nameEn && (
              <span dir="ltr" className="truncate text-end text-xs text-muted-foreground">
                {first.nameEn}
              </span>
            )}
          </>
        ) : games.length === 0 ? (
          <span className="text-sm text-muted-foreground">{tm('picker.none')}</span>
        ) : (
          <>
            <span className="font-bold">{tm('picker.chosenCount', { count: games.length })}</span>
            <span className="truncate text-xs text-muted-foreground">
              {games.map((game) => game.nameAr).join('، ')}
            </span>
          </>
        )}
      </span>
      <Button type="button" variant="outline" size="xl" onClick={onChange}>
        {games.length === 0 ? tm('picker.choose') : tm('picker.change')}
      </Button>
    </div>
  );
}

/**
 * The game picker (owner, 2026-10-30), adapted from the admin panel's: a live search in Arabic and
 * English with the arrow keys and Enter, then "ألعابك", the merchant's best sellers, category chips
 * and a grid of covers. `single`: a game picks and closes. `multiple`: games toggle, "تم" closes.
 */
export function GamePickerDialog({
  open,
  onOpenChange,
  games,
  pinned,
  selected,
  multiple = false,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  games: readonly PickerGame[];
  pinned: readonly string[];
  selected: readonly string[];
  multiple?: boolean;
  /** `single`: the game chosen. `multiple`: the new selection. */
  onPick: (ids: string[]) => void;
}) {
  return (
    // Typing is the point here, and the close button stays: a search typed never holds it open.
    <Dialog open={open} onOpenChange={onOpenChange} guardTyped={false}>
      <DialogContent closeLabel={tm('common.close')} className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{multiple ? tm('picker.titleMany') : tm('picker.title')}</DialogTitle>
          <DialogDescription>{tm('picker.body')}</DialogDescription>
        </DialogHeader>
        {open && (
          <PickerBody
            games={games}
            pinned={pinned}
            selected={selected}
            multiple={multiple}
            onPick={(ids) => {
              onPick(ids);
              if (!multiple) onOpenChange(false);
            }}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function PickerBody({
  games,
  pinned,
  selected,
  multiple,
  onPick,
  onDone,
}: {
  games: readonly PickerGame[];
  pinned: readonly string[];
  selected: readonly string[];
  multiple: boolean;
  onPick: (ids: string[]) => void;
  onDone: () => void;
}) {
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const [category, setCategory] = useState(ALL);
  const listId = useId();
  const found = findPickerGames(games, text);
  const searching = text.trim() !== '';
  const byId = new Map(games.map((game) => [game.id, game]));
  const yours = pinned.flatMap((id) => byId.get(id) ?? []);
  const top = topPickerGames(games).filter((game) => !pinned.includes(game.id));
  const categories = pickerCategories(games);
  const browsed = category === ALL ? games : games.filter((game) => game.categoryId === category);

  function pick(id: string) {
    if (!multiple) return onPick([id]);
    onPick(selected.includes(id) ? selected.filter((other) => other !== id) : [...selected, id]);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (found.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((active + step + found.length) % found.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const game = found[active];
      if (game) pick(game.id);
    } else if (event.key === 'Escape' && text !== '') {
      // Typed text goes first; only then Escape closes the dialog.
      event.preventDefault();
      event.stopPropagation();
      setText('');
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Input
        autoFocus
        type="search"
        autoComplete="off"
        maxLength={60}
        className="h-11 text-md"
        aria-label={tm('picker.search')}
        placeholder={tm('picker.search')}
        role="combobox"
        aria-expanded={searching && found.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          searching && found[active] ? `${listId}-${found[active].id}` : undefined
        }
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
      />
      {games.length === 0 && (
        <p className="text-sm text-muted-foreground">{tm('picker.noGames')}</p>
      )}
      {searching && found.length === 0 && (
        <p className="text-sm text-muted-foreground">{tm('picker.noMatch')}</p>
      )}
      {searching && found.length > 0 && (
        <div
          id={listId}
          role="listbox"
          aria-label={tm('picker.results')}
          aria-multiselectable={multiple || undefined}
          className="flex flex-col gap-1"
        >
          {found.map((game, index) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the combobox's arrows and Enter pick it.
            <div
              key={game.id}
              id={`${listId}-${game.id}`}
              role="option"
              tabIndex={-1}
              aria-selected={multiple ? selected.includes(game.id) : index === active}
              data-active={index === active || undefined}
              className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-border p-2 data-active:border-primary data-active:bg-muted"
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(game.id)}
            >
              <Cover game={game} className="size-10 shrink-0" />
              <span className="flex min-w-0 flex-1 flex-col">
                <bdi className="truncate font-medium">{game.nameAr}</bdi>
                <span className="truncate text-xs text-muted-foreground">
                  {game.categoryNameAr}
                </span>
              </span>
              {selected.includes(game.id) && (
                <CheckIcon className="size-5 text-primary" aria-hidden="true" />
              )}
            </div>
          ))}
        </div>
      )}
      {!searching && games.length > 0 && (
        <>
          {yours.length > 0 && (
            <CoverRow title={tm('sale.yourGames')}>
              {yours.map((game) => (
                <CoverButton
                  key={game.id}
                  game={game}
                  chosen={selected.includes(game.id)}
                  onPick={pick}
                />
              ))}
            </CoverRow>
          )}
          {top.length > 0 && (
            <CoverRow title={tm('picker.topSold')}>
              {top.map((game) => (
                <CoverButton
                  key={game.id}
                  game={game}
                  chosen={selected.includes(game.id)}
                  onPick={pick}
                />
              ))}
            </CoverRow>
          )}
          <section className="flex min-w-0 flex-col gap-2">
            <div className="-mx-1 overflow-x-auto px-1 pb-1">
              <ToggleGroup
                aria-label={tm('picker.categories')}
                value={[category]}
                onValueChange={(value) => setCategory(value[0] ?? ALL)}
              >
                <ToggleGroupItem value={ALL} className="h-11 shrink-0 px-4">
                  {tm('picker.all')}
                </ToggleGroupItem>
                {categories.map((item) => (
                  <ToggleGroupItem key={item.id} value={item.id} className="h-11 shrink-0 px-4">
                    {item.nameAr}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
            <ul className="grid max-h-80 grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-5">
              {browsed.map((game) => (
                <li key={game.id}>
                  <CoverButton game={game} chosen={selected.includes(game.id)} onPick={pick} />
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
      {multiple && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          <span className="text-sm text-muted-foreground tabular-nums">
            {tm('picker.chosenCount', { count: selected.length })}
          </span>
          <Button size="xl" onClick={onDone}>
            {tm('picker.done')}
          </Button>
        </div>
      )}
    </div>
  );
}

function CoverRow({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
      <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [&>*]:w-24 [&>*]:shrink-0">
        {children}
      </div>
    </section>
  );
}

function CoverButton({
  game,
  chosen,
  onPick,
}: {
  game: PickerGame;
  chosen: boolean;
  onPick: (id: string) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={chosen}
      onClick={() => onPick(game.id)}
      className="relative flex w-full flex-col items-stretch gap-1 rounded-lg border border-border p-1.5 text-start transition-colors duration-150 hover:border-primary focus-visible:outline-2 focus-visible:outline-ring aria-pressed:border-primary aria-pressed:bg-muted"
    >
      <Cover game={game} className="w-full" />
      <span className="line-clamp-2 text-xs font-medium">
        <bdi>{game.nameAr}</bdi>
      </span>
      {chosen && (
        <span className="absolute top-2 end-2 flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <CheckIcon className="size-4" aria-hidden="true" />
        </span>
      )}
    </button>
  );
}
