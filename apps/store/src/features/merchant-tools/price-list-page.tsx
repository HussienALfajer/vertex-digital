'use client';

import {
  type MerchantPriceList,
  PRICE_LIST_CURRENCIES,
  PRICE_LIST_IMAGES_PER_HOUR,
  PRICE_LIST_MODES,
} from '@vertex-digital/contracts';
import { Button } from '@vertex-digital/ui/components/button';
import { Callout } from '@vertex-digital/ui/components/callout';
import { Card } from '@vertex-digital/ui/components/card';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { Field, FieldLabel } from '@vertex-digital/ui/components/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vertex-digital/ui/components/select';
import { Switch } from '@vertex-digital/ui/components/switch';
import { ToggleGroup, ToggleGroupItem } from '@vertex-digital/ui/components/toggle-group';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  FileDownIcon,
  ImageDownIcon,
  ListIcon,
  StarIcon,
  TrendingUpIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useMemo, useRef, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { saveBlob } from './download';
import { ChosenGames, GamePickerDialog, readPickerGames } from './game-picker';
import { type PickerGame, pickerCategories, topPickerGames } from './game-picker-rules';
import { tm, tmc } from './i18n';
import { MerchantPageStatus, MerchantSkeleton, useMerchantRead } from './merchant-state';
import { usePinnedGames } from './pinned-games';
import { type PriceListCovers, PriceListDocument } from './price-list-document';
import { a4Pages } from './price-list-pages';
import {
  getPriceList,
  type PriceListOptions,
  priceListImage,
  priceListOptionsFrom,
  priceListQuery,
} from './requests';

const DEFAULTS: PriceListOptions = {
  gameIds: [],
  mode: 'selling',
  currency: 'syp',
  unavailable: false,
};

/**
 * "قائمة الأسعار" (S21 F36, PL1–PL3; owner, 2026-10-30): the settings beside the preview on a
 * wide screen (sticky), above it on a phone: the games from the picker with quick choices
 * ("ألعابك", "الأكثر مبيعًا", a whole category; none chosen: "ألعابك", else the 10 best sellers,
 * never the whole catalog), the prices, the currency and the unavailable packs; the preview as A4
 * pages; "طباعة / حفظ PDF" on the print page, and one image chosen and downloaded at a time (60
 * packs each, 20 an hour). Read live, never cached.
 */
export function PriceListPage() {
  // The options an address carries (back from the print page), else the defaults (Q27).
  const [options, setOptions] = useState<PriceListOptions>(() =>
    typeof window === 'undefined' || window.location.search === ''
      ? DEFAULTS
      : priceListOptionsFrom(new URLSearchParams(window.location.search)),
  );
  // The games are read once for the page, beside the first list; an option change reads the list
  // alone (A06-9). A failed read is forgotten, so a retry reads it again.
  const games = useRef<ReturnType<typeof readPickerGames> | null>(null);
  const read = useCallback(async () => {
    games.current ??= readPickerGames();
    const [gameList, list] = await Promise.all([games.current, getPriceList(options)]);
    if (!gameList.ok) {
      games.current = null;
      return gameList;
    }
    if (!list.ok) return list;
    return { ok: true as const, data: { games: gameList.data, list: list.data } };
  }, [options]);
  const { state, reload, refreshing } = useMerchantRead(read);

  if (state.status !== 'ready') {
    return (
      <MerchantPageStatus
        state={state}
        onRetry={() => void reload()}
        skeleton={<MerchantSkeleton rows={4} />}
      />
    );
  }
  return (
    <PriceListView
      refreshing={refreshing}
      games={state.data.games}
      list={state.data.list}
      options={options}
      onOptions={setOptions}
    />
  );
}

function PriceListView({
  refreshing,
  games,
  list,
  options,
  onOptions,
}: {
  refreshing: boolean;
  games: PickerGame[];
  list: MerchantPriceList;
  options: PriceListOptions;
  onOptions: (options: PriceListOptions) => void;
}) {
  const pinned = usePinnedGames();
  const [picking, setPicking] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [image, setImage] = useState('1');
  const [pageIndex, setPageIndex] = useState(0);
  const empty = list.games.length === 0;
  const pinnedIds = pinned.status === 'ready' ? pinned.ids : [];
  const byId = new Map(games.map((game) => [game.id, game]));
  // What the list shows: the games asked for, else those the API chose (PL1).
  const chosen = list.gameIds.flatMap((id) => byId.get(id) ?? []);
  const covers: PriceListCovers = useMemo(
    () => new Map(games.flatMap((game) => (game.cover ? [[game.id, game.cover]] : []))),
    [games],
  );
  const pages = useMemo(() => a4Pages(list.games), [list.games]);
  const shownPage = Math.min(pageIndex, pages.length - 1);
  const packs = list.games.reduce((total, game) => total + game.rows.length, 0);
  const categories = pickerCategories(games);
  const choose = (gameIds: string[]) => {
    setPageIndex(0);
    onOptions({ ...options, gameIds });
  };
  const yours = games.filter((game) => pinnedIds.includes(game.id)).map((game) => game.id);
  const top = topPickerGames(games).map((game) => game.id);

  async function download() {
    setFailure(null);
    setBusy(true);
    const result = await priceListImage(options, Number(image));
    setBusy(false);
    if (!result.ok) return setFailure(result.reason);
    saveBlob(result.blob, result.fileName);
  }

  const imageItems = Array.from({ length: list.imagePages }, (_, index) => ({
    value: String(index + 1),
    label: tm('priceList.imageOf', { page: index + 1, pages: list.imagePages }),
  }));

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <Card className="gap-5 lg:sticky lg:top-4" data-testid="price-list-settings">
        <Field>
          <FieldLabel render={<span />}>{tm('priceList.games')}</FieldLabel>
          <ChosenGames games={chosen} onChange={() => setPicking(true)} />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="xl"
              disabled={yours.length === 0}
              onClick={() => choose(yours)}
            >
              <StarIcon aria-hidden="true" />
              {tm('sale.yourGames')}
            </Button>
            <Button
              variant="outline"
              size="xl"
              disabled={top.length === 0}
              onClick={() => choose(top)}
            >
              <TrendingUpIcon aria-hidden="true" />
              {tm('priceList.topSold')}
            </Button>
            <Select
              items={categories.map((item) => ({ value: item.id, label: item.nameAr }))}
              value={null}
              onValueChange={(category) =>
                category &&
                choose(games.filter((game) => game.categoryId === category).map((game) => game.id))
              }
            >
              <SelectTrigger
                aria-label={tm('priceList.category')}
                className="h-11 min-w-36 text-md"
              >
                <SelectValue placeholder={tm('priceList.category')} />
              </SelectTrigger>
              <SelectContent>
                {categories.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.nameAr}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </Field>
        <GamePickerDialog
          open={picking}
          onOpenChange={setPicking}
          multiple
          games={games}
          pinned={pinnedIds}
          selected={chosen.map((game) => game.id)}
          onPick={choose}
        />
        <Field>
          <FieldLabel>{tm('priceList.prices')}</FieldLabel>
          <ToggleGroup<MerchantPriceList['mode']>
            aria-label={tm('priceList.prices')}
            value={[options.mode]}
            onValueChange={(value) => value[0] && onOptions({ ...options, mode: value[0] })}
          >
            {PRICE_LIST_MODES.map((mode) => (
              <ToggleGroupItem key={mode} value={mode} className="h-11 flex-1 px-3 text-md">
                {tm(`priceList.modes.${mode}`)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>
        <Field>
          <FieldLabel>{tm('priceList.currency')}</FieldLabel>
          <ToggleGroup<MerchantPriceList['currency']>
            aria-label={tm('priceList.currency')}
            value={[options.currency]}
            onValueChange={(value) => value[0] && onOptions({ ...options, currency: value[0] })}
          >
            {PRICE_LIST_CURRENCIES.map((currency) => (
              <ToggleGroupItem key={currency} value={currency} className="h-11 flex-1 px-3 text-md">
                {tm(`priceList.currencies.${currency}`)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>
        <div className="flex min-h-11 items-center gap-3 text-md">
          <Switch
            id="price-list-unavailable-switch"
            aria-labelledby="price-list-unavailable"
            checked={options.unavailable}
            onCheckedChange={(unavailable) => onOptions({ ...options, unavailable })}
          />
          <label
            id="price-list-unavailable"
            htmlFor="price-list-unavailable-switch"
            className="flex min-h-11 flex-1 cursor-pointer items-center"
          >
            {tm('priceList.unavailable')}
          </label>
        </div>
        <div className="flex flex-col gap-3 border-t border-border pt-4">
          <Button
            size="xl"
            disabled={empty}
            render={
              <Link
                href={`/merchant/price-list/print?${priceListQuery(options)}`}
                prefetch={false}
              />
            }
          >
            <FileDownIcon aria-hidden="true" />
            {tm('priceList.print')}
          </Button>
          <div className="flex gap-2">
            {list.imagePages > 1 && (
              <Select
                items={imageItems}
                value={image}
                onValueChange={(value) => value && setImage(value)}
              >
                <SelectTrigger
                  aria-label={tm('priceList.whichImage')}
                  className="h-11 flex-1 text-md"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {imageItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button
              variant="outline"
              size="xl"
              className="flex-1"
              disabled={empty || busy}
              onClick={() => void download()}
            >
              <ImageDownIcon aria-hidden="true" />
              {tm('priceList.image')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {tm('priceList.imageHint', { max: PRICE_LIST_IMAGES_PER_HOUR })}
          </p>
          {failure && (
            <FormAlert>
              {failure === 'RATE_LIMITED'
                ? tm('priceList.imageLimit', { max: PRICE_LIST_IMAGES_PER_HOUR })
                : errorText(failure)}
            </FormAlert>
          )}
        </div>
      </Card>

      <section
        aria-labelledby="price-list-preview"
        aria-busy={refreshing}
        className={`flex min-w-0 flex-col gap-3 ${refreshing ? 'opacity-60' : ''}`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="price-list-preview" className="text-lg font-bold">
            {tm('priceList.preview')}
          </h2>
          {!empty && (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                aria-label={tm('priceList.previous')}
                disabled={shownPage === 0}
                onClick={() => setPageIndex(shownPage - 1)}
              >
                <ChevronRightIcon className="ltr:rotate-180" aria-hidden="true" />
              </Button>
              <span className="text-sm text-muted-foreground tabular-nums" aria-live="polite">
                {tm('priceList.pagesLine', { page: shownPage + 1, pages: pages.length })} ·{' '}
                {tmc('priceList.packCount', packs)}
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label={tm('priceList.next')}
                disabled={shownPage >= pages.length - 1}
                onClick={() => setPageIndex(shownPage + 1)}
              >
                <ChevronLeftIcon className="ltr:rotate-180" aria-hidden="true" />
              </Button>
            </div>
          )}
        </div>
        {options.mode === 'purchase' && (
          <Callout tone="warning" title={tm('priceList.purchaseNote')} />
        )}
        {list.omittedCount > 0 && (
          <p className="text-sm text-muted-foreground" data-testid="price-list-omitted">
            {tm('priceList.omitted', { count: list.omittedCount })}{' '}
            <Link href="/merchant/prices" prefetch={false} className="text-primary underline">
              {tm('priceList.setPrices')}
            </Link>
          </p>
        )}
        {empty ? (
          <EmptyState
            icon={<ListIcon />}
            title={list.gameIds.length === 0 ? tm('priceList.noGames') : tm('priceList.empty')}
            description={
              list.gameIds.length === 0 ? tm('priceList.noGamesHint') : tm('priceList.emptyHint')
            }
            action={
              list.gameIds.length === 0 ? (
                <Button size="xl" onClick={() => setPicking(true)}>
                  {tm('picker.titleMany')}
                </Button>
              ) : undefined
            }
          />
        ) : (
          // One A4 page (at least its height from `md`), white like the paper, whatever the theme.
          <div className="mx-auto flex w-full max-w-[210mm] flex-col rounded-md border border-border bg-white p-4 sm:p-8 md:aspect-[210/297]">
            <PriceListDocument
              list={list}
              covers={covers}
              games={pages[shownPage]}
              page={{ number: shownPage + 1, count: pages.length }}
            />
          </div>
        )}
      </section>
    </div>
  );
}
