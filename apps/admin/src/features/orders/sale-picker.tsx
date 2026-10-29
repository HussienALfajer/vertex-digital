import { useQuery } from '@tanstack/react-query';
import {
  type CatalogImage,
  formatSyp,
  formatUsd,
  type GameDetail,
  marginBasisPoints,
  type Product,
} from '@vertex-digital/contracts';
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
import { ImageIcon, SearchIcon } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { formatPercentBp } from '../pricing/pricing-format';
import { StockChip } from '../suppliers/offer-cells';
import { purchaseGamesQuery } from './orders.queries';
import { filterPacks, findGames, type SaleGame, sortPacks, topGames } from './sale-picker-rules';

/*
 * The sale picker of "شراء من اللوحة" (S16 screens; owner, 2026-10-29): a live game search, the
 * most-sold row, category chips over a grid of covers; then the game's packs as cards by quantity
 * with the admin's cost, margin and availability, and a quick filter.
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
export function ChosenGame({ game, onChange }: { game: GameDetail; onChange: () => void }) {
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

/** A pack the mode may buy (rule AP5): available, or paused by the admin for an owner-funded one. */
function packChoice(product: Product, ownerFunded: boolean): 'buyable' | 'trial' | 'unavailable' {
  if (product.archivedAt !== null || product.priceUsdUnits === null) return 'unavailable';
  if (product.availability === 'available') return 'buyable';
  return product.availability === 'paused' && ownerFunded ? 'trial' : 'unavailable';
}

/**
 * Rule AP5: the game's packs as cards by quantity, with the price, the admin's cost and margin,
 * the availability, supplier and stock; paused packs selectable only for owner-funded modes. The
 * quick filter's Enter picks the first pack it leaves that the mode may buy.
 */
export function PackCards({
  game,
  ownerFunded,
  productId,
  invalid,
  focus,
  onPick,
}: {
  game: GameDetail;
  ownerFunded: boolean;
  productId: string | null;
  invalid: boolean;
  /** Right after the game was picked: the filter takes the focus. */
  focus: boolean;
  onPick: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const filter = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focus) filter.current?.focus();
  }, [focus]);

  const products = sortPacks(game.products.filter((item) => item.archivedAt === null));
  if (products.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('orders.buy.noPacks')}</p>;
  }
  const shown = filterPacks(products, text);
  return (
    <div className="flex flex-col gap-3">
      <Field className="max-w-64">
        <FieldLabel>{t('orders.buy.picker.packFilter')}</FieldLabel>
        <Input
          ref={filter}
          type="search"
          autoComplete="off"
          maxLength={40}
          placeholder={t('orders.buy.picker.packFilterPlaceholder')}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            const first = shown.find((item) => packChoice(item, ownerFunded) !== 'unavailable');
            if (first) onPick(first.id);
          }}
        />
      </Field>
      {shown.length === 0 && (
        <p className="text-sm text-muted-foreground">
          <SearchIcon className="me-1 inline size-4" aria-hidden="true" />
          {t('orders.buy.picker.noPackMatch')}
        </p>
      )}
      <fieldset
        className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        data-invalid={invalid ? '' : undefined}
      >
        <legend className="sr-only">{t('orders.buy.pack')}</legend>
        {shown.map((item) => (
          <PackCard
            key={item.id}
            item={item}
            choice={packChoice(item, ownerFunded)}
            checked={productId === item.id}
            onPick={onPick}
          />
        ))}
      </fieldset>
    </div>
  );
}

function PackCard({
  item,
  choice,
  checked,
  onPick,
}: {
  item: Product;
  choice: ReturnType<typeof packChoice>;
  checked: boolean;
  onPick: (id: string) => void;
}) {
  const { t } = useTranslation();
  const price = item.priceUsdUnits;
  const cost = item.basisCostUsdUnits;
  return (
    <label className="flex cursor-pointer flex-col gap-2 rounded-lg border border-border p-3 has-checked:border-primary has-checked:bg-muted has-disabled:cursor-not-allowed has-disabled:opacity-60">
      <span className="flex items-start gap-2 font-medium">
        <input
          type="radio"
          name="product"
          className="mt-1 size-4 shrink-0 accent-primary"
          value={item.id}
          disabled={choice === 'unavailable'}
          checked={checked}
          onChange={() => onPick(item.id)}
        />
        <bdi className="flex-1">{item.nameAr}</bdi>
      </span>
      <span className="flex flex-wrap items-baseline gap-x-2 tabular-nums">
        {price === null ? (
          <span className="text-sm">{t('orders.buy.noPrice')}</span>
        ) : (
          <>
            <bdi dir="ltr" className="text-lg font-bold">
              {formatUsd(price)}
            </bdi>
            {item.priceSypUnits !== null && (
              <span className="text-sm text-muted-foreground">
                {t('catalog.products.syp', { amount: formatSyp(item.priceSypUnits) })}
              </span>
            )}
          </>
        )}
      </span>
      {cost !== null && (
        <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground tabular-nums">
          <span>
            {t('orders.buy.picker.cost')} <bdi dir="ltr">{formatUsd(cost)}</bdi>
          </span>
          {price !== null && (
            <span className={price - cost <= 0 ? 'text-destructive-text' : undefined}>
              {t('orders.buy.picker.margin')}{' '}
              <bdi dir="ltr">
                {formatUsd(price - cost)}
                {price - cost > 0 && ` (${formatPercentBp(marginBasisPoints(price, cost))}%)`}
              </bdi>
            </span>
          )}
        </span>
      )}
      <span className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        {choice === 'buyable' && (
          <Badge tone="success">{t('catalog.availability.available')}</Badge>
        )}
        {choice === 'trial' && <Badge tone="gold">{t('orders.buy.trial')}</Badge>}
        {choice === 'unavailable' && (
          <Badge tone="neutral">{t(`catalog.availability.${item.availability}`)}</Badge>
        )}
        {item.basisSupplierNameAr && t('orders.buy.basis', { supplier: item.basisSupplierNameAr })}
        {item.basisStockLevel && <StockChip level={item.basisStockLevel} quiet />}
      </span>
    </label>
  );
}
