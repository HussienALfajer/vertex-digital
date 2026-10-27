'use client';

import {
  type MerchantGame,
  type MerchantPriceList,
  PRICE_LIST_CURRENCIES,
  PRICE_LIST_MODES,
} from '@vertex-digital/contracts';
import { Button } from '@vertex-digital/ui/components/button';
import { Callout } from '@vertex-digital/ui/components/callout';
import { Card } from '@vertex-digital/ui/components/card';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { Field, FieldLabel } from '@vertex-digital/ui/components/field';
import { Switch } from '@vertex-digital/ui/components/switch';
import { ToggleGroup, ToggleGroupItem } from '@vertex-digital/ui/components/toggle-group';
import { ImageDownIcon, ListIcon, PrinterIcon } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useRef, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { saveBlob } from './download';
import { tm } from './i18n';
import { MerchantPageStatus, MerchantSkeleton, useMerchantRead } from './merchant-state';
import { PriceListDocument } from './price-list-document';
import {
  getMerchantGames,
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
 * "قائمة الأسعار" (S21 F36, PL1–PL3): the games (none chosen: the followed ones, else all), the
 * prices (selling, or the merchant's own purchase prices with a warning), the currency and the
 * unavailable packs; a live preview, "طباعة / حفظ PDF" on the A4 print page, and "تنزيل صورة",
 * one PNG per 60 packs, for WhatsApp. Read live, never cached.
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
  const games = useRef<ReturnType<typeof getMerchantGames> | null>(null);
  const read = useCallback(async () => {
    games.current ??= getMerchantGames();
    const [gameList, list] = await Promise.all([games.current, getPriceList(options)]);
    if (!gameList.ok) {
      games.current = null;
      return gameList;
    }
    if (!list.ok) return list;
    return { ok: true as const, data: { games: gameList.data.items, list: list.data } };
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
  games: MerchantGame[];
  list: MerchantPriceList;
  options: PriceListOptions;
  onOptions: (options: PriceListOptions) => void;
}) {
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const empty = list.games.length === 0;

  async function download(page: number) {
    setFailure(null);
    setBusy(page);
    const result = await priceListImage(options, page);
    setBusy(null);
    if (!result.ok) return setFailure(result.reason);
    saveBlob(result.blob, result.fileName);
  }

  return (
    <div className="flex flex-col gap-6">
      <Card className="gap-5">
        <Field>
          <FieldLabel>{tm('priceList.games')}</FieldLabel>
          <ToggleGroup<string>
            multiple
            aria-label={tm('priceList.games')}
            className="flex-wrap"
            value={options.gameIds}
            onValueChange={(gameIds) => onOptions({ ...options, gameIds })}
          >
            {games.map((game) => (
              <ToggleGroupItem key={game.id} value={game.id} className="h-11 px-4 text-md">
                {game.nameAr}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {options.gameIds.length === 0 && (
            <p className="text-sm text-muted-foreground">{tm('priceList.gamesHint')}</p>
          )}
        </Field>
        <div className="flex flex-wrap gap-6">
          <Field>
            <FieldLabel>{tm('priceList.prices')}</FieldLabel>
            <ToggleGroup<MerchantPriceList['mode']>
              aria-label={tm('priceList.prices')}
              value={[options.mode]}
              onValueChange={(value) => value[0] && onOptions({ ...options, mode: value[0] })}
            >
              {PRICE_LIST_MODES.map((mode) => (
                <ToggleGroupItem key={mode} value={mode} className="h-11 px-4 text-md">
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
                <ToggleGroupItem key={currency} value={currency} className="h-11 px-4 text-md">
                  {tm(`priceList.currencies.${currency}`)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>
        </div>
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
      </Card>

      {options.mode === 'purchase' && (
        <Callout tone="warning" title={tm('priceList.purchaseNote')} />
      )}
      {list.omittedCount > 0 && (
        <p className="text-muted-foreground" data-testid="price-list-omitted">
          {tm('priceList.omitted', { count: list.omittedCount })}{' '}
          <Link href="/merchant/prices" prefetch={false} className="text-primary underline">
            {tm('priceList.setPrices')}
          </Link>
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          size="xl"
          disabled={empty}
          render={
            <Link href={`/merchant/price-list/print?${priceListQuery(options)}`} prefetch={false} />
          }
        >
          <PrinterIcon aria-hidden="true" />
          {tm('priceList.print')}
        </Button>
        {Array.from({ length: list.imagePages }, (_, index) => index + 1).map((page) => (
          <Button
            key={page}
            variant="outline"
            size="xl"
            disabled={empty || busy !== null}
            onClick={() => void download(page)}
          >
            <ImageDownIcon aria-hidden="true" />
            {list.imagePages === 1
              ? tm('priceList.image')
              : tm('priceList.imagePage', { page, pages: list.imagePages })}
          </Button>
        ))}
      </div>
      {failure && <FormAlert>{errorText(failure)}</FormAlert>}

      <section
        aria-label={tm('priceList.preview')}
        aria-busy={refreshing}
        className={`flex flex-col gap-2 ${refreshing ? 'opacity-60' : ''}`}
      >
        <h2 className="text-lg font-bold">{tm('priceList.preview')}</h2>
        {empty ? (
          <EmptyState
            icon={<ListIcon />}
            title={tm('priceList.empty')}
            description={tm('priceList.emptyHint')}
          />
        ) : (
          <div className="rounded-lg border border-border bg-white p-4 sm:p-6">
            <PriceListDocument list={list} />
          </div>
        )}
      </section>
    </div>
  );
}
