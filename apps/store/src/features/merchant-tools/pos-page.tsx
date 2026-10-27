'use client';

import {
  formatAmountInput,
  formatSyp,
  formatUsd,
  MERCHANT_CODE_QUANTITY_MAX,
  type MerchantGame,
  type OrderSummary,
  orderTotal,
  type PlayerCheck,
  type RecentPlayers,
  type SaleCurrency,
  type SavedPlayer,
  type SellingPriceRow,
  type StoreGame,
} from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui/components/badge';
import { Button } from '@vertex-digital/ui/components/button';
import { Card } from '@vertex-digital/ui/components/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vertex-digital/ui/components/dialog';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '@vertex-digital/ui/components/field';
import { Input } from '@vertex-digital/ui/components/input';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { useFocusInvalid } from '@vertex-digital/ui/focus-invalid';
import {
  CircleAlertIcon,
  KeyboardIcon,
  PrinterIcon,
  TicketIcon,
  UserRoundCheckIcon,
} from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { useNotificationEvents } from '@/features/notifications/live';
import { listOrders } from '@/features/orders/requests';
import { STAGE_TONES, stageText } from '@/features/orders/stages';
import { sendAttempt } from '@/features/purchase/attempt';
import { checkFields, type FieldValues } from '@/features/purchase/fields';
import { freesKey } from '@/features/purchase/order-key';
import { checkPlayer, createOrder } from '@/features/purchase/requests';
import { isFrozenCustomer, useCustomer } from '@/features/purchase/session';
import { apiRequest, type Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { ltr } from '@/lib/format';
import { parseSellingPrice } from './form';
import { tm } from './i18n';
import { MerchantPageStatus, MerchantSkeleton, useMerchantRead } from './merchant-state';
import {
  getMerchantGames,
  getRecentPlayers,
  getSavedPlayers,
  getSellingPrices,
  getWatches,
  setOrderSale,
} from './requests';
import { SellingPriceField } from './selling-price-field';

// S20 MT2: a directly granted merchant accepts the terms here, loaded only on that refusal.
const TermsSheet = dynamic(() =>
  import('@/features/merchant/terms-sheet').then((module) => module.TermsSheet),
);

/** PS1: followed games first, then by the merchant's 30-day units, then the store's order. */
async function posGames() {
  const [games, watches] = await Promise.all([getMerchantGames(), getWatches()]);
  if (!games.ok) return games;
  const followed = new Set(watches.ok ? watches.data.games.map((game) => game.gameId) : []);
  const items = [...games.data.items].sort(
    (a, b) =>
      Number(followed.has(b.id)) - Number(followed.has(a.id)) || b.recentUnits - a.recentUnits,
  );
  return { ok: true as const, data: items };
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/**
 * "نقطة البيع" (S21 F32, PS1–PS5): a game bar, the pack grid with each pack's purchase and selling
 * price and availability, the player fields with the game's recent and saved ids, and the last 10
 * orders live. A pack with an id filled opens the confirmation (two taps and a confirmation);
 * the order goes through `POST /api/orders` with every S08 and S09 rule. Keyboard: `/`, `1`–`9`,
 * `F2`, `Enter`, `Esc`, `P`, `?`. Tablet and desktop first; works at phone width.
 */
export function PosPage() {
  const read = useCallback(() => posGames(), []);
  const { state, reload } = useMerchantRead(read);
  const [gameId, setGameId] = useState<string | null>(null);
  const strip = useOrderStrip();
  const [help, setHelp] = useState(false);
  // S21 MA1: a frozen merchant reads only; the packs stay shown but open nothing.
  const frozen = isFrozenCustomer(useCustomer());

  useEffect(() => {
    if (state.status === 'ready' && gameId === null) setGameId(state.data[0]?.id ?? null);
  }, [state, gameId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return;
      if (event.key === '?') {
        event.preventDefault();
        setHelp(true);
      } else if (event.key.toLowerCase() === 'p' && strip.lastDelivered) {
        event.preventDefault();
        window.open(`/orders/${strip.lastDelivered}/print?paper=58&content=receipt`, '_blank');
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [strip.lastDelivered]);

  if (state.status !== 'ready') {
    return <MerchantPageStatus state={state} onRetry={reload} skeleton={<MerchantSkeleton />} />;
  }
  const game = state.data.find((item) => item.id === gameId) ?? null;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <nav aria-label={tm('pos.games')} className="-mx-4 overflow-x-auto px-4">
          <ul className="flex min-w-max gap-2">
            {state.data.map((item) => (
              <li key={item.id}>
                <Button
                  size="xl"
                  variant={item.id === gameId ? 'primary' : 'outline'}
                  aria-pressed={item.id === gameId}
                  onClick={() => setGameId(item.id)}
                >
                  {item.nameAr}
                </Button>
              </li>
            ))}
          </ul>
        </nav>
        <Button
          variant="ghost"
          size="xl"
          className="hidden shrink-0 md:inline-flex"
          onClick={() => setHelp(true)}
        >
          <KeyboardIcon aria-hidden="true" />
          {tm('pos.shortcutsOpen')}
        </Button>
      </div>
      {frozen && <FormAlert>{tm('common.frozen')}</FormAlert>}
      {game ? (
        <GamePanel key={game.id} game={game} frozen={frozen} onPlaced={strip.reload} />
      ) : (
        <EmptyState icon={<CircleAlertIcon />} title={tm('pos.chooseGame')} />
      )}
      <OrderStrip strip={strip} />
      <Dialog open={help} onOpenChange={setHelp}>
        <DialogContent closeLabel={tm('common.close')}>
          <DialogHeader>
            <DialogTitle>{tm('pos.shortcuts')}</DialogTitle>
          </DialogHeader>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            {(
              [
                ['/', 'search'],
                ['1–9', 'pack'],
                ['F2', 'player'],
                ['Enter', 'confirm'],
                ['Esc', 'close'],
                ['P', 'print'],
                ['?', 'help'],
              ] as const
            ).map(([key, label]) => (
              <div key={key} className="contents">
                <dt>
                  <kbd className="rounded border border-border px-2 py-0.5 tabular-nums" dir="ltr">
                    {key}
                  </kbd>
                </dt>
                <dd>{tm(`pos.keys.${label}`)}</dd>
              </div>
            ))}
          </dl>
        </DialogContent>
      </Dialog>
    </div>
  );
}

type GameData = {
  store: StoreGame;
  prices: SellingPriceRow[];
  recent: RecentPlayers['items'];
  saved: SavedPlayer[];
};

type GameState = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; data: GameData };

async function readGame(game: MerchantGame): Promise<GameState> {
  const [store, prices, recent, saved] = await Promise.all([
    apiRequest<StoreGame>(`/api/catalog/games/${encodeURIComponent(game.slug)}`),
    getSellingPrices(game.id),
    getRecentPlayers(game.id),
    getSavedPlayers(game.id),
  ]);
  if (!store.ok || !prices.ok) return { status: 'failed' };
  return {
    status: 'ready',
    data: {
      store: store.data,
      prices: prices.data.products,
      recent: recent.ok ? recent.data.items : [],
      saved: saved.ok ? saved.data.items : [],
    },
  };
}

function priceLine(row: SellingPriceRow): string {
  if (row.sellingSypUnits !== null)
    return tm('common.syp', { amount: formatSyp(row.sellingSypUnits) });
  if (row.sellingUsdUnits !== null) return ltr(formatUsd(row.sellingUsdUnits));
  return tm('pos.noSelling');
}

/** PS1–PS3: one game's packs, the player fields and the confirmation. */
function GamePanel({
  game,
  frozen,
  onPlaced,
}: {
  game: MerchantGame;
  frozen: boolean;
  onPlaced: () => void;
}) {
  const [state, setState] = useState<GameState>({ status: 'loading' });
  const [values, setValues] = useState<FieldValues>({});
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<SellingPriceRow | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [needPlayer, setNeedPlayer] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => setState(await readGame(game)), [game]);
  useEffect(() => {
    void load();
  }, [load]);

  const ready = state.status === 'ready' ? state.data : null;
  const kinds = useMemo(
    () => new Map(ready?.store.products.map((product) => [product.id, product]) ?? []),
    [ready],
  );
  const packs = useMemo(
    () =>
      (ready?.prices ?? []).filter(
        (row) => query.trim() === '' || row.nameAr.includes(query.trim()),
      ),
    [ready, query],
  );
  // One object while the typed values stay the same: the sheet checks the player again only
  // when they change, never on a re-render (audit A06-6, BK4's quota).
  const fields = useMemo(
    () =>
      ready && ready.store.fields.length > 0
        ? (checkFields(ready.store.fields, values) as { values: FieldValues }).values
        : {},
    [ready, values],
  );

  const open = useCallback(
    (row: SellingPriceRow) => {
      if (frozen || !ready || !row.available) return;
      const product = kinds.get(row.productId);
      if (product?.kind === 'direct' && !checkFields(ready.store.fields, values).ok) {
        setNeedPlayer(true);
        playerRef.current?.querySelector('input')?.focus();
        return;
      }
      setNeedPlayer(false);
      setChosen(row);
    },
    [frozen, ready, kinds, values],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'F2') {
        event.preventDefault();
        playerRef.current?.querySelector('input')?.focus();
        return;
      }
      if (chosen || isTyping(event.target)) return;
      if (event.key === '/') {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (/^[1-9]$/.test(event.key)) {
        const row = packs[Number(event.key) - 1];
        if (row) {
          event.preventDefault();
          open(row);
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [packs, open, chosen]);

  if (state.status === 'loading') {
    return (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-hidden="true">
        {Array.from({ length: 8 }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed placeholders
          <Skeleton key={index} className="h-28" />
        ))}
      </div>
    );
  }
  if (state.status === 'failed') {
    return (
      <Card className="gap-3 border-status-danger" role="alert">
        <p className="text-sm">{tm('pos.offline')}</p>
        <Button variant="outline" size="xl" className="self-start" onClick={() => void load()}>
          {tm('common.retry')}
        </Button>
      </Card>
    );
  }
  const data = state.data;
  const direct = data.store.fields.length > 0;
  const chips = [
    ...data.saved.map((player) => ({
      fields: player.fields,
      label: player.label,
      name: player.playerName,
    })),
    ...data.recent.map((player) => ({
      fields: player.fields,
      label: null,
      name: player.playerName,
    })),
  ];
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="flex flex-col gap-3 lg:order-2" ref={playerRef}>
        {direct && (
          <Card className="gap-3">
            <h2 className="font-bold">{tm('pos.player')}</h2>
            {data.store.fields.map((field) => (
              <Field key={field.key} invalid={needPlayer}>
                <FieldLabel>{field.labelAr}</FieldLabel>
                <Input
                  name={field.key}
                  dir="ltr"
                  autoComplete="off"
                  className="h-11 text-md"
                  value={values[field.key] ?? ''}
                  onChange={(event) => {
                    const value = event.target.value;
                    setValues((current) => ({ ...current, [field.key]: value }));
                  }}
                />
              </Field>
            ))}
            {needPlayer && <FormAlert>{tm('pos.fillPlayer')}</FormAlert>}
            <div className="flex flex-col gap-2">
              <span className="text-xs text-muted-foreground">
                {tm('pos.saved')} · {tm('pos.recent')}
              </span>
              {chips.length === 0 ? (
                <p className="text-sm text-muted-foreground">{tm('pos.noRecent')}</p>
              ) : (
                <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
                  {chips.map((chip) => (
                    <li key={`${chip.label ?? ''}:${JSON.stringify(chip.fields)}`}>
                      <button
                        type="button"
                        className="flex min-h-11 w-full items-center justify-between gap-2 rounded-md px-2 text-start text-sm hover:bg-muted"
                        onClick={() => {
                          setValues(chip.fields);
                          setNeedPlayer(false);
                        }}
                      >
                        <bdi dir="ltr" className="font-medium">
                          {Object.values(chip.fields).join(' · ')}
                        </bdi>
                        <span className="truncate text-xs text-muted-foreground">
                          {chip.label ?? chip.name ?? ''}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        )}
      </div>
      <div className="flex flex-col gap-3 lg:order-1">
        <div className="flex items-center gap-3">
          <Input
            ref={searchRef}
            type="search"
            name="search"
            placeholder={tm('pos.search')}
            aria-label={tm('pos.search')}
            className="h-11 text-md"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <span className="hidden shrink-0 text-xs text-muted-foreground md:inline">
            {tm('pos.searchHint')}
          </span>
        </div>
        {notice &&
          (notice.saleSaved ? (
            <p className="text-sm text-status-success-foreground" role="status">
              {tm('pos.placed', { number: notice.number })}
            </p>
          ) : (
            <div className="flex flex-col items-start gap-1">
              <FormAlert tone="warning">
                {tm('pos.saleNotSaved', { number: notice.number })}
              </FormAlert>
              <Link
                href={`/orders/${notice.id}`}
                prefetch={false}
                className="inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-4"
              >
                {tm('pos.saleSetOnOrder')}
              </Link>
            </div>
          ))}
        {packs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tm('pos.noPacks')}</p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
            {packs.map((row, index) => (
              <li key={row.productId}>
                <button
                  type="button"
                  disabled={frozen || !row.available}
                  onClick={() => open(row)}
                  className="flex h-full min-h-28 w-full flex-col items-start gap-1 rounded-lg border border-border bg-surface p-3 text-start transition-colors hover:border-primary disabled:opacity-50"
                >
                  <span className="flex w-full items-start justify-between gap-2">
                    <span className="font-bold break-words">
                      <bdi>{row.nameAr}</bdi>
                    </span>
                    {index < 9 && (
                      <kbd
                        className="rounded border border-border px-1.5 tabular-nums text-xs"
                        dir="ltr"
                      >
                        {index + 1}
                      </kbd>
                    )}
                  </span>
                  {row.available && row.purchaseUsdUnits !== null ? (
                    <>
                      <span className="text-xs text-muted-foreground">
                        {tm('pos.purchase')} <bdi dir="ltr">{formatUsd(row.purchaseUsdUnits)}</bdi>
                      </span>
                      <span
                        className={`text-sm ${row.belowCost ? 'text-status-danger-foreground' : ''}`}
                      >
                        {tm('pos.selling')} <bdi>{priceLine(row)}</bdi>
                      </span>
                    </>
                  ) : (
                    <Badge tone="neutral">{tm('pos.unavailable')}</Badge>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Dialog open={chosen !== null} onOpenChange={(next) => !next && setChosen(null)}>
        {chosen && (
          <ConfirmSale
            key={chosen.productId}
            row={chosen}
            store={data.store}
            fields={fields}
            onPlaced={(placed) => {
              setChosen(null);
              setNotice(placed);
              onPlaced();
              void load();
            }}
            onPriceChanged={() => void load()}
          />
        )}
      </Dialog>
    </div>
  );
}

type Check = { status: 'idle' } | { status: 'checking' } | { status: 'done'; check: PlayerCheck };

/** A placed sale, and whether the selling price typed in the sheet was written (A06-7). */
type Notice = { id: string; number: string; saleSaved: boolean };

/** PS3: the pack, quantity, id with its check, the price paid, the editable selling price. */
function ConfirmSale({
  row,
  store,
  fields,
  onPlaced,
  onPriceChanged,
}: {
  row: SellingPriceRow;
  store: StoreGame;
  fields: FieldValues;
  onPlaced: (placed: Notice) => void;
  onPriceChanged: () => void;
}) {
  const product = store.products.find((item) => item.id === row.productId);
  const code = product?.kind === 'code';
  const max = code ? MERCHANT_CODE_QUANTITY_MAX : (product?.maxQuantity ?? 1);
  const [quantity, setQuantity] = useState('1');
  const [check, setCheck] = useState<Check>({ status: code ? 'idle' : 'checking' });
  const [confirmed, setConfirmed] = useState(false);
  const startCurrency: SaleCurrency =
    row.ownPrice?.currency ?? (row.sellingSypUnits !== null ? 'syp' : 'usd');
  const [currency, setCurrency] = useState<SaleCurrency>(startCurrency);
  // The pack's selling price as the field shows it, in the currency it was set in.
  const initialAmount =
    startCurrency === 'syp'
      ? row.sellingSypUnits !== null
        ? formatAmountInput('SYP', row.sellingSypUnits)
        : ''
      : row.sellingUsdUnits !== null
        ? formatAmountInput('USD', row.sellingUsdUnits)
        : '';
  const [amount, setAmount] = useState(initialAmount);
  const [invalid, setInvalid] = useState<'quantity' | 'price' | 'player' | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState(false);
  // The price paid per unit, updated in place by a `PRICE_CHANGED` refusal (A06-2).
  const [purchase, setPurchase] = useState(row.purchaseUsdUnits ?? 0);
  // S20 MT2: the terms sheet, and that they were accepted after a refused confirmation.
  const [termsOpen, setTermsOpen] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const { ref, focusInvalid } = useFocusInvalid();

  useEffect(() => {
    if (code) return;
    let live = true;
    void checkPlayer({ productId: row.productId, fields }).then((result) => {
      if (!live) return;
      setCheck({
        status: 'done',
        check: result.ok ? result.data : { result: 'unavailable', reason: 'supplier' },
      });
    });
    return () => {
      live = false;
    };
  }, [code, row.productId, fields]);

  const needsConfirm =
    check.status === 'done' &&
    check.check.result !== 'valid' &&
    check.check.result !== 'not_supported';
  const units = Number(quantity);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    setTermsAccepted(false);
    if (!/^\d{1,2}$/.test(quantity) || units < 1 || units > max) {
      setInvalid('quantity');
      return focusInvalid();
    }
    const sale = amount.trim() === '' ? null : parseSellingPrice(currency, amount);
    if (sale === undefined) {
      setInvalid('price');
      return focusInvalid();
    }
    if (needsConfirm && !confirmed) {
      setInvalid('player');
      return focusInvalid();
    }
    if (check.status === 'checking') return;
    setInvalid(null);
    setPending(true);
    const body = {
      productId: row.productId,
      quantity: units,
      fields,
      expectedUnitPriceUsdUnits: purchase,
      confirmPlayer: needsConfirm && confirmed,
    };
    // The buy box's key rule, kept in session storage per pack: closing the sheet after a lost
    // answer and confirming again replays the first order instead of paying twice (A06-1).
    const result = await sendAttempt(
      row.productId,
      JSON.stringify(body),
      (key) => createOrder(body, key),
      freesKey,
    );
    if (!result.ok) {
      setPending(false);
      if (result.reason === 'PRICE_CHANGED') {
        const price = (result.details as { unitPriceUsdUnits?: unknown } | undefined)
          ?.unitPriceUsdUnits;
        if (typeof price === 'number') setPurchase(price);
        onPriceChanged();
      }
      if (result.reason === 'MERCHANT_TERMS_REQUIRED') setTermsOpen(true);
      return setFailure(result.reason);
    }
    // PS3: a price typed here is this sale's own (`manual`); the pack's stays as it was.
    const typed = sale && (sale.currency !== startCurrency || amount !== initialAmount);
    const saleSaved = sale && typed ? (await setOrderSale(result.data.id, sale)).ok : true;
    setPending(false);
    onPlaced({ id: result.data.id, number: result.data.number, saleSaved });
  }

  return (
    <DialogContent closeLabel={tm('common.close')}>
      <DialogHeader>
        <DialogTitle>{tm('pos.confirmTitle')}</DialogTitle>
        <DialogDescription>
          <bdi>{row.nameAr}</bdi> · {store.game.nameAr}
        </DialogDescription>
      </DialogHeader>
      <form ref={ref} className="flex flex-col gap-4" onSubmit={submit} noValidate>
        {!code && (
          <div className="flex flex-col gap-2 rounded-lg bg-muted p-3 text-sm">
            <bdi dir="ltr" className="font-medium">
              {Object.values(fields).join(' · ')}
            </bdi>
            {check.status === 'checking' && <span>{tm('pos.checking')}</span>}
            {check.status === 'done' && check.check.result === 'valid' && (
              <span className="flex items-center gap-2 text-status-success-foreground">
                <UserRoundCheckIcon className="size-4" aria-hidden="true" />
                {check.check.playerName
                  ? tm('pos.checkedName', { name: check.check.playerName })
                  : tm('bulk.checks.validNoName')}
              </span>
            )}
            {needsConfirm && check.status === 'done' && (
              <span className="text-status-warning-foreground">
                {check.check.result === 'invalid'
                  ? tm('pos.checkInvalid')
                  : tm('pos.checkUnavailable')}
              </span>
            )}
            {needsConfirm && (
              <label
                className="flex min-h-11 items-center gap-2"
                data-invalid={invalid === 'player' ? '' : undefined}
              >
                <input
                  type="checkbox"
                  className="size-5"
                  checked={confirmed}
                  aria-invalid={invalid === 'player'}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                {tm('pos.confirmPlayer')}
              </label>
            )}
          </div>
        )}
        {code && (
          <Field invalid={invalid === 'quantity'}>
            <FieldLabel>{tm('pos.quantity')}</FieldLabel>
            <Input
              name="quantity"
              dir="ltr"
              inputMode="numeric"
              className="h-11 text-md"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
            />
            <FieldDescription>{tm('pos.quantityHint', { max })}</FieldDescription>
            <FieldError match={invalid === 'quantity'}>
              {tm('pos.quantityHint', { max })}
            </FieldError>
          </Field>
        )}
        <p className="flex items-baseline justify-between text-sm">
          <span className="text-muted-foreground">{tm('pos.total')}</span>
          <bdi dir="ltr" className="font-bold">
            {formatUsd(
              orderTotal(
                purchase,
                Number.isInteger(units) && units > 0 && units <= max ? units : 1,
              ),
            )}
          </bdi>
        </p>
        <SellingPriceField
          currency={currency}
          amount={amount}
          invalid={invalid === 'price'}
          label={tm('pos.sellingPrice')}
          onCurrency={setCurrency}
          onAmount={setAmount}
        />
        <p className="text-xs text-muted-foreground">{tm('pos.sellingHint')}</p>
        {termsAccepted ? (
          <FormAlert tone="success">{tm('pos.termsAccepted')}</FormAlert>
        ) : (
          failure && <FormAlert>{errorText(failure)}</FormAlert>
        )}
        {termsOpen && (
          <TermsSheet
            open={termsOpen}
            onOpenChange={setTermsOpen}
            onAccepted={() => setTermsAccepted(true)}
          />
        )}
        <DialogFooter>
          <Button type="submit" size="xl" disabled={pending || check.status === 'checking'}>
            {tm('pos.confirm')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

type Strip = {
  orders: OrderSummary[] | null;
  /** The first read failed: the strip offers a retry instead of a lasting skeleton (A06-8). */
  failed: boolean;
  lastDelivered: string | null;
  reload: () => void;
};

/** PS1, PS5: the last 10 orders, read again on each order event (S09 LT2). */
function useOrderStrip(): Strip {
  const [orders, setOrders] = useState<OrderSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const reload = useCallback(() => {
    setFailed(false);
    void listOrders().then((result) => {
      if (result.ok) setOrders(result.data.items.slice(0, 10));
      else setFailed(true);
    });
  }, []);
  useEffect(() => reload(), [reload]);
  useNotificationEvents((event) => {
    if (event.type === 'order' || event.type === 'resync') reload();
  });
  const lastDelivered = orders?.find((order) => order.stage === 'delivered')?.id ?? null;
  return { orders, failed, lastDelivered, reload };
}

function OrderStrip({ strip }: { strip: Strip }) {
  return (
    <Card className="gap-3">
      <h2 className="font-bold">{tm('pos.strip')}</h2>
      {strip.orders === null && strip.failed ? (
        <div className="flex flex-col items-start gap-2" role="alert">
          <p className="text-sm">{tm('pos.stripFailed')}</p>
          <Button variant="outline" size="xl" onClick={strip.reload}>
            {tm('common.retry')}
          </Button>
        </div>
      ) : strip.orders === null ? (
        <Skeleton className="h-16 w-full" />
      ) : strip.orders.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tm('pos.stripEmpty')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {strip.orders.map((order) => (
            <li key={order.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <Link href={`/orders/${order.id}`} prefetch={false} className="flex min-w-0 flex-col">
                <span className="text-sm font-medium break-words">
                  <bdi>{order.productNameAr}</bdi> · {order.game.nameAr}
                </span>
                <bdi dir="ltr" className="text-xs text-muted-foreground">
                  {order.number}
                </bdi>
              </Link>
              <span className="flex items-center gap-2">
                <Badge tone={STAGE_TONES[order.stage]}>{stageText(order.stage)}</Badge>
                {order.stage === 'delivered' && (
                  <Button
                    variant="ghost"
                    size="xl"
                    render={
                      <Link
                        href={`/orders/${order.id}/print?paper=58&content=receipt`}
                        prefetch={false}
                        target="_blank"
                      />
                    }
                  >
                    <PrinterIcon aria-hidden="true" />
                    {tm('pos.printReceipt')}
                  </Button>
                )}
                {/* PS5: a delivered code pack prints its codes too (Q27). */}
                {order.stage === 'delivered' && order.productKind === 'code' && (
                  <Button
                    variant="ghost"
                    size="xl"
                    render={
                      <Link
                        href={`/orders/${order.id}/print?paper=58&content=codes`}
                        prefetch={false}
                        target="_blank"
                      />
                    }
                  >
                    <TicketIcon aria-hidden="true" />
                    {tm('pos.printCodes')}
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
