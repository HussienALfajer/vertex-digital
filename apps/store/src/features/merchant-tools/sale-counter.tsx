'use client';

import {
  displaySypTotal,
  formatAmountInput,
  formatSyp,
  formatUsd,
  MERCHANT_CODE_QUANTITY_MAX,
  type OrderSummary,
  orderTotal,
  type PlayerCheck,
  type RecentPlayers,
  type SaleCurrency,
  type SavedPlayer,
  type SellingPriceRow,
  type StoreGame,
  type StoreProduct,
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
  EyeIcon,
  EyeOffIcon,
  KeyboardIcon,
  PrinterIcon,
  TicketIcon,
  UserRoundCheckIcon,
} from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { readCustomerPrices } from '@/features/catalog/customer-prices';
import { PackButton } from '@/features/catalog/pack-button';
import { withPrivatePrices } from '@/features/catalog/private-prices';
import { useNotificationEvents } from '@/features/notifications/live';
import { listOrders } from '@/features/orders/requests';
import { STAGE_TONES, stageText } from '@/features/orders/stages';
import { sendAttempt } from '@/features/purchase/attempt';
import { usePurchasesStopped } from '@/features/purchase/customer';
import { FieldInput } from '@/features/purchase/field-input';
import { checkFields, type FieldValues } from '@/features/purchase/fields';
import { freesKey } from '@/features/purchase/order-key';
import { checkPlayer, createOrder } from '@/features/purchase/requests';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { clearFormDraft, readFormDraft, saveFormDraft } from '@/lib/form-draft';
import { t } from '@/lib/i18n';
import { parseSellingPrice } from './form';
import { tm } from './i18n';
import { getRecentPlayers, getSavedPlayers, getSellingPrices, setOrderSale } from './requests';
import { type Amount, type SalePrice, saleFigures } from './sale-figures';
import { toggleCostHidden, useCostHidden } from './sale-mode';
import { SellingPriceField } from './selling-price-field';
import { MerchantTierProvider, useMerchantTier } from './tier-state';

// S20 MT2: a directly granted merchant accepts the terms here, loaded only on that refusal.
const TermsSheet = dynamic(() =>
  import('@/features/merchant/terms-sheet').then((module) => module.TermsSheet),
);

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/** A shortcut is not one with a modifier held (`Ctrl+P` prints the page). */
const plainKey = (event: KeyboardEvent) => !event.ctrlKey && !event.metaKey && !event.altKey;

/**
 * The sale mode of a game page (S21 F32, PS1–PS6), a merchant's only: each pack's selling and
 * purchase price in both currencies with the profit, the player fields with the game's recent and
 * saved ids, and the last 10 orders live. A pack with an id filled opens the confirmation (two taps
 * and a confirmation); the order goes through `POST /api/orders` with every S08 and S09 rule.
 * Keyboard: `/`, `1`–`9`, `F2`, `Enter`, `Esc`, `P`, `H`, `?`. `pack` is the page's `?pack=`.
 */
export function SaleCounter({
  data,
  pack,
  frozen: accountFrozen,
  linkWaiting,
}: {
  data: StoreGame;
  pack: string | null;
  frozen: boolean;
  /** A link asked the buy box for something, and it would show the hidden cost (PS1b). */
  linkWaiting: boolean;
}) {
  // Its own tier read: the code packs' limit (S23 TS5). Outside the merchant area's layout.
  return (
    <MerchantTierProvider>
      <Counter data={data} pack={pack} accountFrozen={accountFrozen} linkWaiting={linkWaiting} />
    </MerchantTierProvider>
  );
}

function Counter({
  data,
  pack,
  accountFrozen,
  linkWaiting,
}: {
  data: StoreGame;
  pack: string | null;
  accountFrozen: boolean;
  linkWaiting: boolean;
}) {
  const strip = useOrderStrip();
  const [help, setHelp] = useState(false);
  const hideCost = useCostHidden();
  // S05 SW7, BB7: while purchases are stopped the packs open nothing either (audit A09-24).
  const stopped = usePurchasesStopped();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target) || !plainKey(event)) return;
      if (event.key === '?' || event.key === '؟') {
        event.preventDefault();
        setHelp(true);
      } else if (event.code === 'KeyH') {
        // By the key's place: an Arabic keyboard layout has no `h`.
        event.preventDefault();
        toggleCostHidden();
      } else if (event.code === 'KeyP' && strip.lastDelivered) {
        event.preventDefault();
        window.open(`/orders/${strip.lastDelivered}/print?paper=58&content=receipt`, '_blank');
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [strip.lastDelivered]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="xl"
          aria-pressed={hideCost}
          aria-keyshortcuts="H"
          onClick={toggleCostHidden}
        >
          {hideCost ? <EyeIcon aria-hidden="true" /> : <EyeOffIcon aria-hidden="true" />}
          {tm(hideCost ? 'sale.showCost' : 'sale.hideCost')}
        </Button>
        <Button
          variant="ghost"
          size="xl"
          className="hidden md:inline-flex"
          onClick={() => setHelp(true)}
        >
          <KeyboardIcon aria-hidden="true" />
          {tm('sale.shortcutsOpen')}
        </Button>
      </div>
      {linkWaiting && <FormAlert tone="warning">{tm('sale.linkNeedsCost')}</FormAlert>}
      {accountFrozen && <FormAlert>{tm('common.frozen')}</FormAlert>}
      {stopped && <FormAlert>{t('purchase.stopped')}</FormAlert>}
      <GamePanel
        store={data}
        pack={linkWaiting ? null : pack}
        frozen={accountFrozen || stopped}
        paused={help}
        hideCost={hideCost}
        onPlaced={strip.reload}
      />
      <OrderStrip strip={strip} />
      <Dialog open={help} onOpenChange={setHelp}>
        <DialogContent closeLabel={tm('common.close')}>
          <DialogHeader>
            <DialogTitle>{tm('sale.shortcuts')}</DialogTitle>
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
                ['H', 'hideCost'],
                ['?', 'help'],
              ] as const
            ).map(([key, label]) => (
              <div key={key} className="contents">
                <dt>
                  <kbd className="rounded border border-border px-2 py-0.5 tabular-nums" dir="ltr">
                    {key}
                  </kbd>
                </dt>
                <dd>{tm(`sale.keys.${label}`)}</dd>
              </div>
            ))}
          </dl>
        </DialogContent>
      </Dialog>
    </div>
  );
}

type GameData = {
  prices: SellingPriceRow[];
  products: StoreProduct[];
  /** The purchase price in SYP per pack (the merchant's own prices of the game), where known. */
  purchaseSyp: Map<string, number>;
  recent: RecentPlayers['items'];
  saved: SavedPlayer[];
};

type GameState = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; data: GameData };

async function readGame(store: StoreGame): Promise<GameState> {
  const [own, prices, recent, saved] = await Promise.all([
    readCustomerPrices(store.game.slug),
    getSellingPrices(store.game.id),
    getRecentPlayers(store.game.id),
    getSavedPlayers(store.game.id),
  ]);
  if (!prices.ok) return { status: 'failed' };
  const products = own ? withPrivatePrices(store.products, own) : store.products;
  const purchaseSyp = new Map<string, number>();
  for (const row of prices.data.products) {
    const product = products.find((item) => item.id === row.productId);
    // Only the figure of the same price: a read that crossed a price change shows USD alone.
    if (product?.priceSypUnits != null && product.priceUsdUnits === row.purchaseUsdUnits) {
      purchaseSyp.set(row.productId, product.priceSypUnits);
    }
  }
  return {
    status: 'ready',
    data: {
      prices: prices.data.products,
      products,
      purchaseSyp,
      recent: recent.ok ? recent.data.items : [],
      saved: saved.ok ? saved.data.items : [],
    },
  };
}

const amountText = ({ currency, units }: Amount) =>
  currency === 'syp' ? tm('common.syp', { amount: formatSyp(units) }) : formatUsd(units);

/** A price with its equivalent after "≈" (brand/identity.md §6: the rate is not locked here). */
function PriceLine({ price, large }: { price: SalePrice; large?: boolean }) {
  return (
    <span className={`flex flex-wrap items-baseline gap-x-1.5 ${large ? '' : 'text-xs'}`}>
      <bdi className={`tabular-nums ${large ? 'text-xl font-bold' : ''}`}>
        {amountText(price.main)}
      </bdi>
      {price.approx && (
        <span className="text-xs text-muted-foreground tabular-nums">
          {tm('common.approx', { amount: amountText(price.approx) })}
        </span>
      )}
    </span>
  );
}

/** PS3, PS6: what a pack shows in the sale mode; with the cost hidden, the selling price alone. */
function SaleCard({
  row,
  number,
  purchaseSyp,
  hideCost,
}: {
  row: SellingPriceRow;
  number: number;
  purchaseSyp: number | null;
  hideCost: boolean;
}) {
  const { selling, purchase, profit } = saleFigures(row, purchaseSyp);
  return (
    <>
      <span className="flex w-full items-start justify-between gap-2">
        <bdi className="font-bold break-words">{row.nameAr}</bdi>
        {number <= 9 && (
          <kbd className="rounded border border-border px-1.5 tabular-nums text-xs" dir="ltr">
            {number}
          </kbd>
        )}
      </span>
      {row.available && purchase ? (
        <>
          <span className="flex flex-col">
            <span className="text-xs text-muted-foreground">{tm('sale.selling')}</span>
            {selling ? (
              <PriceLine price={selling} large />
            ) : (
              <span className="text-sm">{tm('sale.noSelling')}</span>
            )}
          </span>
          {!hideCost && (
            <>
              <span className="flex flex-col">
                <span className="text-xs text-muted-foreground">{tm('sale.purchase')}</span>
                <PriceLine price={purchase} />
              </span>
              {profit && (
                <Badge
                  tone={profit.units > 0 ? 'success' : profit.units < 0 ? 'danger' : 'neutral'}
                  className="mt-auto self-start"
                >
                  {tm('sale.profit', {
                    amount: `${profit.units > 0 ? '+' : profit.units < 0 ? '-' : ''}${amountText({
                      ...profit,
                      units: Math.abs(profit.units),
                    })}`,
                  })}
                </Badge>
              )}
              {row.belowCost && (
                <span className="text-xs text-status-danger-foreground">
                  {tm('prices.belowCost')}
                </span>
              )}
            </>
          )}
        </>
      ) : (
        <Badge tone="neutral" className="self-start">
          {tm('sale.unavailable')}
        </Badge>
      )}
    </>
  );
}

/** PS1–PS3: the game's packs, the player fields and the confirmation. */
function GamePanel({
  store,
  pack,
  frozen,
  paused,
  hideCost,
  onPlaced,
}: {
  store: StoreGame;
  pack: string | null;
  frozen: boolean;
  /** The help sheet is open: the number keys wait. */
  paused: boolean;
  hideCost: boolean;
  onPlaced: () => void;
}) {
  const game = store.game;
  const [state, setState] = useState<GameState>({ status: 'loading' });
  // The player typed for this game until the sale goes through, across a game change and a reload.
  const [values, setValues] = useState<FieldValues>(
    () => readFormDraft<FieldValues>(`sale:${game.id}`) ?? {},
  );
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<SellingPriceRow | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [needPlayer, setNeedPlayer] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => setState(await readGame(store)), [store]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (Object.keys(values).length > 0) saveFormDraft(`sale:${game.id}`, values);
    else clearFormDraft(`sale:${game.id}`);
  }, [game.id, values]);

  const ready = state.status === 'ready' ? state.data : null;
  const kinds = useMemo(
    () => new Map(ready?.products.map((product) => [product.id, product]) ?? []),
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
      store.fields.length > 0
        ? (checkFields(store.fields, values) as { values: FieldValues }).values
        : {},
    [store.fields, values],
  );

  const open = useCallback(
    (row: SellingPriceRow) => {
      if (frozen || !ready || !row.available) return;
      const product = kinds.get(row.productId);
      if (product?.kind === 'direct' && !checkFields(store.fields, values).ok) {
        setNeedPlayer(true);
        playerRef.current?.querySelector('input')?.focus();
        return;
      }
      setNeedPlayer(false);
      setChosen(row);
    },
    [frozen, ready, kinds, store.fields, values],
  );

  // `?pack=` (a search result): that pack, once it is known; it asks for the id first if missing.
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!pack || !ready || opened.current === pack) return;
    opened.current = pack;
    const row = ready.prices.find((item) => item.productId === pack);
    if (row) open(row);
  }, [pack, ready, open]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'F2') {
        event.preventDefault();
        playerRef.current?.querySelector('input')?.focus();
        return;
      }
      if (chosen || paused || isTyping(event.target) || !plainKey(event)) return;
      if (event.key === '/') {
        event.preventDefault();
        // The packs' search here, not the store's (which `Ctrl+K` still opens).
        event.stopPropagation();
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
  }, [packs, open, chosen, paused]);

  if (state.status === 'loading') {
    return (
      <div
        className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3"
        aria-hidden="true"
      >
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
        <p className="text-sm">{tm('sale.offline')}</p>
        <Button variant="outline" size="xl" className="self-start" onClick={() => void load()}>
          {tm('common.retry')}
        </Button>
      </Card>
    );
  }
  const data = state.data;
  const direct = store.fields.length > 0;
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
            <h2 className="font-bold">{tm('sale.player')}</h2>
            {store.fields.map((field) => (
              <FieldInput
                key={field.key}
                field={field}
                value={values[field.key] ?? ''}
                onChange={(value) => {
                  setValues((current) => ({ ...current, [field.key]: value }));
                  setNeedPlayer(false);
                }}
                onBlur={() => {}}
              />
            ))}
            {needPlayer && <FormAlert>{tm('sale.fillPlayer')}</FormAlert>}
            <div className="flex flex-col gap-2">
              <span className="text-xs text-muted-foreground">
                {tm('sale.saved')} · {tm('sale.recent')}
              </span>
              {chips.length === 0 ? (
                <p className="text-sm text-muted-foreground">{tm('sale.noRecent')}</p>
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
            placeholder={tm('sale.search')}
            aria-label={tm('sale.search')}
            className="h-11 text-md"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <span className="hidden shrink-0 text-xs text-muted-foreground md:inline">
            {tm('sale.searchHint')}
          </span>
        </div>
        {notice &&
          (notice.saleSaved ? (
            <p className="text-sm text-status-success-foreground" role="status">
              {tm('sale.placed', { number: notice.number })}
            </p>
          ) : (
            <div className="flex flex-col items-start gap-1">
              <FormAlert tone="warning">
                {tm('sale.saleNotSaved', { number: notice.number })}
              </FormAlert>
              <Link
                href={`/orders/${notice.id}`}
                prefetch={false}
                className="inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-4"
              >
                {tm('sale.saleSetOnOrder')}
              </Link>
            </div>
          ))}
        {packs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tm('sale.noPacks')}</p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3">
            {packs.map((row, index) => (
              <li key={row.productId}>
                <PackButton
                  available={!frozen && row.available}
                  selected={false}
                  onSelect={() => open(row)}
                >
                  <SaleCard
                    row={row}
                    number={index + 1}
                    purchaseSyp={data.purchaseSyp.get(row.productId) ?? null}
                    hideCost={hideCost}
                  />
                </PackButton>
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
            products={data.products}
            gameName={game.nameAr}
            purchaseSyp={data.purchaseSyp.get(chosen.productId) ?? null}
            hideCost={hideCost}
            fields={fields}
            onPlaced={(placed) => {
              clearFormDraft(`sale-price:${chosen.productId}`);
              // The next sale is for another player: this id never comes back by itself.
              setValues({});
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
  products,
  gameName,
  purchaseSyp,
  hideCost,
  fields,
  onPlaced,
  onPriceChanged,
}: {
  row: SellingPriceRow;
  products: StoreProduct[];
  gameName: string;
  /** The pack's purchase price in SYP at `row.purchaseUsdUnits`; null when not known. */
  purchaseSyp: number | null;
  /** PS6: the customer may see the screen, so no price paid here either. */
  hideCost: boolean;
  fields: FieldValues;
  onPlaced: (placed: Notice) => void;
  onPriceChanged: () => void;
}) {
  const product = products.find((item) => item.id === row.productId);
  const code = product?.kind === 'code';
  // S23 TS5: a code pack takes up to the tier's units per order (the server enforces it too).
  const unitsMax = useMerchantTier().tier?.privileges.orderUnitsMax ?? MERCHANT_CODE_QUANTITY_MAX;
  const max = code ? unitsMax : (product?.maxQuantity ?? 1);
  const [quantity, setQuantity] = useState('1');
  const [check, setCheck] = useState<Check>({ status: code ? 'idle' : 'checking' });
  const [confirmed, setConfirmed] = useState(false);
  const startCurrency: SaleCurrency =
    row.ownPrice?.currency ?? (row.sellingSypUnits !== null ? 'syp' : 'usd');
  // A selling price typed here stays with the pack until the sale goes through (a closed
  // confirmation, a reload).
  const [typedSale] = useState(() =>
    readFormDraft<{ currency: SaleCurrency; amount: string }>(`sale-price:${row.productId}`),
  );
  const [currency, setCurrency] = useState<SaleCurrency>(typedSale?.currency ?? startCurrency);
  // The pack's selling price as the field shows it, in the currency it was set in.
  const initialAmount =
    startCurrency === 'syp'
      ? row.sellingSypUnits !== null
        ? formatAmountInput('SYP', row.sellingSypUnits)
        : ''
      : row.sellingUsdUnits !== null
        ? formatAmountInput('USD', row.sellingUsdUnits)
        : '';
  const [amount, setAmount] = useState(typedSale?.amount ?? initialAmount);
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
    if (currency === startCurrency && amount === initialAmount) {
      clearFormDraft(`sale-price:${row.productId}`);
    } else saveFormDraft(`sale-price:${row.productId}`, { currency, amount });
  }, [row.productId, currency, amount, startCurrency, initialAmount]);

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
  const shownUnits = Number.isInteger(units) && units > 0 && units <= max ? units : 1;

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
        <DialogTitle>{tm('sale.confirmTitle')}</DialogTitle>
        <DialogDescription>
          <bdi>{row.nameAr}</bdi> · {gameName}
        </DialogDescription>
      </DialogHeader>
      <form ref={ref} className="flex flex-col gap-4" onSubmit={submit} noValidate>
        {!code && (
          <div className="flex flex-col gap-2 rounded-lg bg-muted p-3 text-sm">
            <bdi dir="ltr" className="font-medium">
              {Object.values(fields).join(' · ')}
            </bdi>
            {check.status === 'checking' && <span>{tm('sale.checking')}</span>}
            {check.status === 'done' && check.check.result === 'valid' && (
              <span className="flex items-center gap-2 text-status-success-foreground">
                <UserRoundCheckIcon className="size-4" aria-hidden="true" />
                {check.check.playerName
                  ? tm('sale.checkedName', { name: check.check.playerName })
                  : tm('bulk.checks.validNoName')}
              </span>
            )}
            {needsConfirm && check.status === 'done' && (
              <span className="text-status-warning-foreground">
                {check.check.result === 'invalid'
                  ? tm('sale.checkInvalid')
                  : tm('sale.checkUnavailable')}
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
                {tm('sale.confirmPlayer')}
              </label>
            )}
          </div>
        )}
        {code && (
          <Field invalid={invalid === 'quantity'}>
            <FieldLabel>{tm('sale.quantity')}</FieldLabel>
            <Input
              name="quantity"
              dir="ltr"
              inputMode="numeric"
              className="h-11 text-md"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
            />
            <FieldDescription>{tm('sale.quantityHint', { max })}</FieldDescription>
            <FieldError match={invalid === 'quantity'}>
              {tm('sale.quantityHint', { max })}
            </FieldError>
          </Field>
        )}
        {/* A price that changed is shown whatever is hidden: it must be seen before it is paid. */}
        {(!hideCost || purchase !== row.purchaseUsdUnits) && (
          <div className="flex flex-col">
            <p className="flex items-baseline justify-between text-sm">
              <span className="text-muted-foreground">{tm('sale.total')}</span>
              <bdi dir="ltr" className="font-bold">
                {formatUsd(orderTotal(purchase, shownUnits))}
              </bdi>
            </p>
            {/* The SYP of the price on the card only: a refusal's new price comes in USD alone. */}
            {purchaseSyp !== null && purchase === row.purchaseUsdUnits && (
              <span className="text-end text-xs text-muted-foreground tabular-nums">
                {tm('common.approx', {
                  amount: tm('common.syp', {
                    amount: formatSyp(
                      displaySypTotal([{ sypUnits: purchaseSyp, count: shownUnits }]),
                    ),
                  }),
                })}
              </span>
            )}
          </div>
        )}
        <SellingPriceField
          currency={currency}
          amount={amount}
          invalid={invalid === 'price'}
          label={tm('sale.sellingPrice')}
          onCurrency={setCurrency}
          onAmount={setAmount}
        />
        <p className="text-xs text-muted-foreground">{tm('sale.sellingHint')}</p>
        {termsAccepted ? (
          <FormAlert tone="success">{tm('sale.termsAccepted')}</FormAlert>
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
            {tm('sale.confirm')}
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
  // An installed app opens a new-tab link in its only window: there the print page comes in place,
  // through the router, keeping this page mounted behind its back link.
  const [printTarget, setPrintTarget] = useState<'_blank' | undefined>('_blank');
  useEffect(() => {
    if (
      (navigator as Navigator & { standalone?: boolean }).standalone === true ||
      window.matchMedia('(display-mode: standalone)').matches
    ) {
      setPrintTarget(undefined);
    }
  }, []);
  return (
    <Card className="gap-3">
      <h2 className="font-bold">{tm('sale.strip')}</h2>
      {strip.orders === null && strip.failed ? (
        <div className="flex flex-col items-start gap-2" role="alert">
          <p className="text-sm">{tm('sale.stripFailed')}</p>
          <Button variant="outline" size="xl" onClick={strip.reload}>
            {tm('common.retry')}
          </Button>
        </div>
      ) : strip.orders === null ? (
        <Skeleton className="h-16 w-full" />
      ) : strip.orders.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tm('sale.stripEmpty')}</p>
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
                        target={printTarget}
                      />
                    }
                  >
                    <PrinterIcon aria-hidden="true" />
                    {tm('sale.printReceipt')}
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
                        target={printTarget}
                      />
                    }
                  >
                    <TicketIcon aria-hidden="true" />
                    {tm('sale.printCodes')}
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
