import { useQuery } from '@tanstack/react-query';
import type { CatalogImage } from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Field,
  FieldLabel,
  Input,
  Skeleton,
  ToggleGroup,
  ToggleGroupItem,
} from '@vertex-digital/ui';
import { ImageIcon } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { purchaseGamesQuery } from '../orders/orders.queries';
import { findGames, type SaleGame, topGames } from '../orders/sale-picker-rules';

/*
 * The game picker of "شراء من اللوحة" and "مصفوفة الأسعار": a live search by name and search terms
 * with arrow keys and Enter, the most-sold row, category chips over a grid of covers.
 */

const ALL = 'all';

function Cover({ cover, className }: { cover: CatalogImage | null; className: string }) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted ${className}`}
    >
      {cover ? (
        <img src={cover.url} alt="" loading="lazy" className="size-full object-cover" />
      ) : (
        <ImageIcon className="size-5 text-muted-foreground" aria-hidden="true" />
      )}
    </span>
  );
}

/** The chosen game as a compact bar, with "تغيير". */
export function ChosenGame({
  game,
  onChange,
}: {
  game: Pick<SaleGame, 'cover' | 'nameAr' | 'nameEn' | 'status'>;
  onChange: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3 rounded-lg border border-primary bg-muted p-2">
      <Cover cover={game.cover} className="size-12" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2 font-bold">
          <bdi className="truncate">{game.nameAr}</bdi>
          {game.status !== 'active' && (
            <Badge tone="neutral">{t(`catalog.statuses.${game.status}`)}</Badge>
          )}
        </span>
        <span dir="ltr" className="truncate text-end text-sm text-muted-foreground">
          {game.nameEn}
        </span>
      </span>
      <Button type="button" variant="outline" onClick={onChange}>
        {t('orders.buy.picker.change')}
      </Button>
    </div>
  );
}

/** The game step: search (focused when `focus` turns true), the most-sold row, then categories. */
export function GamePicker({
  focus,
  onPick,
  onCancel,
}: {
  focus: boolean;
  onPick: (id: string) => void;
  /** Back to the game chosen before "تغيير"; absent with none. */
  onCancel?: () => void;
}) {
  const { t } = useTranslation();
  const games = useQuery(purchaseGamesQuery);
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const [category, setCategory] = useState(ALL);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    if (focus) input.current?.focus();
  }, [focus]);

  const items = games.data?.games ?? [];
  const found = findGames(items, text);
  const searching = text.trim() !== '';
  const top = topGames(items, games.data?.lastGameId ?? null);
  const browsed = category === ALL ? items : items.filter((game) => game.categoryId === category);
  const categoryName =
    games.data?.categories.find((item) => item.id === category)?.nameAr ??
    t('orders.buy.picker.all');

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (found.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((active + step + found.length) % found.length);
    } else if (event.key === 'Enter') {
      // Enter picks the highlighted game and never submits the form.
      event.preventDefault();
      const game = found[active];
      if (game) onPick(game.id);
    } else if (event.key === 'Escape' && text !== '') {
      // Typed text goes first, as a dialog keeps what was typed in it; only then Escape leaves.
      event.preventDefault();
      setText('');
    } else if (event.key === 'Escape' && onCancel) {
      event.preventDefault();
      onCancel();
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-2">
        <Field className="min-w-64 flex-1">
          <FieldLabel>{t('orders.buy.picker.search')}</FieldLabel>
          <Input
            ref={input}
            type="search"
            autoComplete="off"
            maxLength={60}
            placeholder={t('orders.buy.picker.searchPlaceholder')}
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
        </Field>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        )}
      </div>

      {games.isPending && <Skeleton className="h-40 w-full" aria-hidden="true" />}
      {games.isError && (
        <div className="flex flex-col gap-2">
          <FormAlert>{errorMessage(t, games.error)}</FormAlert>
          <Button
            type="button"
            variant="outline"
            className="self-start"
            onClick={() => void games.refetch()}
          >
            {t('common.retry')}
          </Button>
        </div>
      )}

      {games.isSuccess && searching && found.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('orders.buy.picker.noGames')}</p>
      )}
      {games.isSuccess && searching && found.length > 0 && (
        <div
          id={listId}
          role="listbox"
          aria-label={t('orders.buy.picker.results')}
          className="flex flex-col gap-1"
        >
          {found.map((game, index) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the combobox's arrows and Enter pick it.
            <div
              key={game.id}
              id={`${listId}-${game.id}`}
              role="option"
              tabIndex={-1}
              aria-selected={index === active}
              className="flex cursor-pointer items-center gap-3 rounded-md border border-border p-2 aria-selected:border-primary aria-selected:bg-muted"
              onMouseEnter={() => setActive(index)}
              onClick={() => onPick(game.id)}
            >
              <GameLine game={game} />
            </div>
          ))}
        </div>
      )}

      {games.isSuccess && !searching && (
        <>
          {top.length > 0 && (
            <section className="flex flex-col gap-2" aria-labelledby={`${listId}-top`}>
              <h3 id={`${listId}-top`} className="text-sm font-medium text-muted-foreground">
                {t('orders.buy.picker.topSold')}
              </h3>
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
                {top.map((game) => (
                  <li key={game.id}>
                    <CoverButton game={game} large onPick={onPick} />
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="flex flex-col gap-2">
            <div className="-mx-1 overflow-x-auto px-1 pb-1">
              <ToggleGroup
                aria-label={t('orders.buy.picker.categories')}
                value={[category]}
                onValueChange={(value) => setCategory(value[0] ?? ALL)}
              >
                <ToggleGroupItem value={ALL}>{t('orders.buy.picker.all')}</ToggleGroupItem>
                {(games.data?.categories ?? []).map((item) => (
                  <ToggleGroupItem key={item.id} value={item.id}>
                    {item.nameAr}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
            {browsed.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('orders.buy.picker.noGames')}</p>
            ) : (
              <ul
                aria-label={categoryName}
                className="grid max-h-96 grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-5 xl:grid-cols-8"
              >
                {browsed.map((game) => (
                  <li key={game.id}>
                    <CoverButton game={game} onPick={onPick} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function GameLine({ game }: { game: SaleGame }) {
  const { t } = useTranslation();
  return (
    <>
      <Cover cover={game.cover} className="size-10" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2 font-medium">
          <bdi className="truncate">{game.nameAr}</bdi>
          {game.status !== 'active' && (
            <Badge tone="neutral">{t(`catalog.statuses.${game.status}`)}</Badge>
          )}
        </span>
        <span dir="ltr" className="truncate text-end text-sm text-muted-foreground">
          {game.nameEn}
        </span>
      </span>
    </>
  );
}

function CoverButton({
  game,
  large = false,
  onPick,
}: {
  game: SaleGame;
  large?: boolean;
  onPick: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={() => onPick(game.id)}
      className="flex w-full flex-col items-stretch gap-1 rounded-lg border border-border p-1.5 text-start transition-colors hover:border-primary focus-visible:outline-2 focus-visible:outline-ring"
    >
      <Cover cover={game.cover} className="aspect-square w-full" />
      <span className={`line-clamp-2 ${large ? 'text-sm font-medium' : 'text-xs'}`}>
        <bdi>{game.nameAr}</bdi>
      </span>
      {game.status !== 'active' && (
        <span className="text-xs text-muted-foreground">
          {t(`catalog.statuses.${game.status}`)}
        </span>
      )}
    </button>
  );
}
