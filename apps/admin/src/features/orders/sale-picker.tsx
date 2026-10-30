import { useQuery } from '@tanstack/react-query';
import {
  formatSyp,
  formatUsd,
  type GameDetail,
  marginBasisPoints,
  PRICE_MATRIX_MAX_LISTS,
  type PriceMatrix,
  type Product,
  ROOT_PRICE_LIST_IDS,
} from '@vertex-digital/contracts';
import {
  Badge,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vertex-digital/ui';
import { CheckIcon, SearchIcon, TagIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { priceListsQuery, priceMatrixQuery } from '../pricing/pricing.queries';
import { formatPercentBp } from '../pricing/pricing-format';
import { StockChip } from '../suppliers/offer-cells';
import { UnusableReason } from '../suppliers/supplier-parts';
import { filterPacks, sortPacks } from './sale-picker-rules';

/*
 * The sale picker of "شراء من اللوحة" (S16 screens; owner, 2026-10-29), after the game picker: the
 * game's packs as cards by quantity with the admin's cost, margin and availability, and a quick
 * filter.
 */

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
/**
 * Rule AP16: the list the order is charged on. A walk-in order chooses any unarchived list
 * (retail first); a gift or a compensation says it takes the cost list; an order the customer pays
 * names the customer's own list (S20 PO4).
 */
export function PriceListLine({
  mode,
  value,
  onChange,
}: {
  mode: 'choose' | 'cost' | 'customer';
  /** The charged list; null while the customer's is read. */
  value: string | null;
  onChange: (id: string) => void;
}) {
  const { t } = useTranslation();
  const lists = useQuery(priceListsQuery);
  const live = (lists.data ?? []).filter((list) => list.archivedAt === null);
  const name = live.find((list) => list.id === value)?.name ?? '';
  if (mode !== 'choose') {
    return (
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <TagIcon className="size-4 text-muted-foreground" aria-hidden="true" />
        {mode === 'cost'
          ? t('orders.buy.picker.chargedCost')
          : t('orders.buy.picker.chargedCustomer', { list: name })}
      </p>
    );
  }
  return (
    <Field className="max-w-72">
      <FieldLabel>{t('orders.buy.picker.priceList')}</FieldLabel>
      <Select
        items={live.map((list) => ({ value: list.id, label: list.name }))}
        value={value}
        onValueChange={(next) => {
          if (next) onChange(next);
        }}
      >
        <SelectTrigger aria-label={t('orders.buy.picker.priceList')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {live.map((list) => (
            <SelectItem key={list.id} value={list.id}>
              {list.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldDescription>{t('orders.buy.picker.priceListHelp')}</FieldDescription>
    </Field>
  );
}

type PriceSheet = PriceMatrix['rows'][number];

export function PackCards({
  game,
  ownerFunded,
  chargedList,
  productId,
  invalid,
  focus,
  onPick,
}: {
  game: GameDetail;
  ownerFunded: boolean;
  /** The list the shown prices are charged on, marked among the lists; null unknown. */
  chargedList: string | null;
  productId: string | null;
  invalid: boolean;
  /** Right after the game was picked: the filter takes the focus. */
  focus: boolean;
  onPick: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const filter = useRef<HTMLInputElement>(null);
  // Every list's price and the supplier's cost, from the price matrix (S20); retail comes first.
  const lists = useQuery(priceListsQuery);
  const others = (lists.data ?? [])
    .filter((list) => list.archivedAt === null && list.id !== ROOT_PRICE_LIST_IDS.retail)
    .slice(0, PRICE_MATRIX_MAX_LISTS - 1);
  const matrix = useQuery({
    ...priceMatrixQuery({ gameId: game.id, lists: others.map((list) => list.id) }),
    enabled: lists.isSuccess,
  });
  const sheets = new Map((matrix.data?.rows ?? []).map((row) => [row.productId, row]));

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
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
        data-invalid={invalid ? '' : undefined}
      >
        <legend className="sr-only">{t('orders.buy.pack')}</legend>
        {shown.map((item) => (
          <PackCard
            key={item.id}
            item={item}
            sheet={sheets.get(item.id)}
            lists={matrix.data?.lists ?? []}
            chargedList={chargedList}
            choice={packChoice(item, ownerFunded)}
            checked={productId === item.id}
            onPick={onPick}
          />
        ))}
      </fieldset>
    </div>
  );
}

/** What a price leaves over the cost: the amount and its share of the price. */
function Margin({ price, cost }: { price: number; cost: number }) {
  const margin = price - cost;
  return (
    <bdi
      dir="ltr"
      className={margin > 0 ? 'text-status-success-foreground' : 'text-destructive-text'}
    >
      {formatUsd(margin)}
      {margin > 0 && ` (${formatPercentBp(marginBasisPoints(price, cost))}%)`}
    </bdi>
  );
}

function PackCard({
  item,
  sheet,
  lists,
  chargedList,
  choice,
  checked,
  onPick,
}: {
  item: Product;
  sheet: PriceSheet | undefined;
  lists: PriceMatrix['lists'];
  chargedList: string | null;
  choice: ReturnType<typeof packChoice>;
  checked: boolean;
  onPick: (id: string) => void;
}) {
  const { t } = useTranslation();
  const price = item.priceUsdUnits;
  // The basis route's cost, or with no usable route the cheapest route's cost as an estimate.
  const estimate = item.basisCostUsdUnits === null ? (sheet?.estimate ?? null) : null;
  const cost = item.basisCostUsdUnits ?? estimate?.costUsdUnits ?? null;
  const supplier =
    item.basisSupplierNameAr ?? (estimate ? t(`suppliers.names.${estimate.supplierCode}`) : null);
  return (
    <label className="flex cursor-pointer flex-col gap-3 rounded-lg border border-border bg-surface p-3 transition-colors hover:border-primary has-checked:border-primary has-checked:bg-muted has-disabled:cursor-not-allowed has-disabled:opacity-70 has-disabled:hover:border-border">
      <span className="flex items-start gap-2">
        <input
          type="radio"
          name="product"
          className="mt-1 size-4 shrink-0 accent-primary"
          value={item.id}
          disabled={choice === 'unavailable'}
          checked={checked}
          onChange={() => onPick(item.id)}
        />
        <bdi className="flex-1 font-medium">{item.nameAr}</bdi>
        {choice === 'buyable' && (
          <Badge tone="success">{t('catalog.availability.available')}</Badge>
        )}
        {choice === 'trial' && <Badge tone="gold">{t('orders.buy.trial')}</Badge>}
        {choice === 'unavailable' && (
          <Badge tone="neutral">{t(`catalog.availability.${item.availability}`)}</Badge>
        )}
      </span>
      <span className="flex flex-wrap items-baseline gap-x-2 tabular-nums">
        {price === null ? (
          <span className="text-sm text-muted-foreground">{t('orders.buy.noPrice')}</span>
        ) : (
          <>
            <bdi dir="ltr" className="text-xl font-bold">
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
        <span className="flex flex-col gap-1 rounded-md bg-muted px-2.5 py-2 text-xs tabular-nums">
          <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
            <span className="text-muted-foreground">{t('orders.buy.picker.supplierPrice')}</span>
            <span className="flex items-center gap-1.5">
              <bdi dir="ltr" className="font-medium">
                {formatUsd(cost)}
              </bdi>
              {estimate && <Badge tone="neutral">{t('catalog.products.estimated')}</Badge>}
            </span>
          </span>
          {supplier && (
            <span className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
              <bdi>{supplier}</bdi>
              {item.basisStockLevel && <StockChip level={item.basisStockLevel} quiet />}
              {estimate && <UnusableReason reason={estimate.reason} />}
            </span>
          )}
          {price !== null && (
            <span className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">{t('orders.buy.picker.margin')}</span>
              <Margin price={price} cost={cost} />
            </span>
          )}
        </span>
      )}
      {sheet && lists.length > 0 && (
        <dl className="m-0 grid grid-cols-[1fr_auto] items-baseline gap-x-3 gap-y-1 border-t border-border pt-2 text-xs tabular-nums">
          {lists.map((list) => {
            const cell = sheet.cells.find((entry) => entry.priceListId === list.id);
            const stored = cell?.priceUsdUnits ?? null;
            const listPrice = stored ?? cell?.estimatedPriceUsdUnits ?? null;
            const charged = list.id === chargedList;
            return (
              <div key={list.id} className="contents">
                <dt
                  className={`flex items-center gap-1 ${charged ? 'font-bold text-foreground' : 'text-muted-foreground'}`}
                >
                  {charged && <CheckIcon className="size-3.5" aria-hidden="true" />}
                  {list.name}
                  {charged && (
                    <span className="sr-only">{` ${t('orders.buy.picker.charged')}`}</span>
                  )}
                </dt>
                <dd
                  className={`m-0 ${charged ? 'font-bold text-foreground' : 'text-muted-foreground'}`}
                >
                  {listPrice === null ? (
                    '—'
                  ) : (
                    <bdi dir="ltr">
                      {stored === null && '~'}
                      {formatUsd(listPrice)}
                    </bdi>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
    </label>
  );
}
