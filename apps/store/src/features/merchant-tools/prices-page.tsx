'use client';

import {
  formatSyp,
  formatUsd,
  type SellingPriceRow,
  type SellingPrices,
  type SellingSettings,
  SYP_STEPS,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vertex-digital/ui/components/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@vertex-digital/ui/components/table';
import { ToggleGroup, ToggleGroupItem } from '@vertex-digital/ui/components/toggle-group';
import { useFocusInvalid } from '@vertex-digital/ui/focus-invalid';
import { PackageIcon, PencilIcon, SlidersHorizontalIcon } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { errorText } from '@/lib/errors';
import { ltr } from '@/lib/format';
import { markupInput, parseMarkup, parseSellingPrice, salePriceStart } from './form';
import { ChosenGames, GamePickerDialog, readPickerGames } from './game-picker';
import { type PickerGame, topPickerGames } from './game-picker-rules';
import { tm } from './i18n';
import { MerchantPageStatus, MerchantSkeleton, useMerchantRead } from './merchant-state';
import { usePinnedGames } from './pinned-games';
import { filterCounts, matchesFilter, PRICE_FILTERS, type PriceFilter } from './price-filters';
import {
  clearSellingPrice,
  getSellingPrices,
  getSellingSettings,
  saveSellingSettings,
  setSellingPrice,
} from './requests';
import { SellingPriceField } from './selling-price-field';

const STORE_STEP = 'store';

/**
 * "أسعار البيع" (S21 F31, SP1–SP3; owner, 2026-10-30): the markup and the SYP step on one line,
 * edited in a dialog; the game from the picker, kept in the address (`?game=`); then a compact
 * table of the game's packs (cards on a phone) with the purchase price, the selling price, the
 * profit, the source and the below-cost warning, filtered by chips with their counts. A pack's own
 * price is set in USD or SYP, or cleared back to the markup.
 */
export function PricesPage() {
  const read = useCallback(async () => {
    const [settings, games] = await Promise.all([getSellingSettings(), readPickerGames()]);
    if (!settings.ok) return settings;
    if (!games.ok) return games;
    return { ok: true as const, data: { settings: settings.data, games: games.data } };
  }, []);
  const { state, setState, reload } = useMerchantRead(read);
  if (state.status !== 'ready') {
    return (
      <MerchantPageStatus
        state={state}
        onRetry={() => void reload()}
        skeleton={<MerchantSkeleton />}
      />
    );
  }
  return (
    <div className="flex flex-col gap-5">
      <SettingsLine
        saved={state.data.settings}
        onSaved={(settings) => setState({ status: 'ready', data: { ...state.data, settings } })}
      />
      <GamePrices games={state.data.games} settingsKey={JSON.stringify(state.data.settings)} />
    </div>
  );
}

/** SP1 on one line: "نسبة الربح 10% · تقريب المتجر · تعديل", the same form in a dialog. */
function SettingsLine({
  saved,
  onSaved,
}: {
  saved: SellingSettings;
  onSaved: (settings: SellingSettings) => void;
}) {
  const [open, setOpen] = useState(false);
  const markup =
    saved.markupBp === null
      ? tm('prices.noMarkup')
      : tm('prices.markupLine', { percent: ltr(`${markupInput(saved.markupBp)}%`) });
  const step =
    saved.sypStepUnits === null
      ? tm('prices.stepStore')
      : tm('prices.stepValue', { amount: formatSyp(saved.sypStepUnits) });
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-surface ps-4 pe-2 py-1.5">
      <SlidersHorizontalIcon className="size-4 text-muted-foreground" aria-hidden="true" />
      <p className="flex-1 text-sm" data-testid="selling-settings">
        <span className="font-medium">{markup}</span>
        <span className="text-muted-foreground"> · {step}</span>
      </p>
      <Button variant="ghost" size="xl" onClick={() => setOpen(true)}>
        <PencilIcon aria-hidden="true" />
        {tm('prices.editSettings')}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent closeLabel={tm('common.close')}>
          <DialogHeader>
            <DialogTitle>{tm('prices.settingsTitle')}</DialogTitle>
            <DialogDescription>{tm('prices.settingsBody')}</DialogDescription>
          </DialogHeader>
          <SettingsForm
            saved={saved}
            onSaved={(settings) => {
              onSaved(settings);
              setOpen(false);
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** SP1: the markup and the SYP step, the form "تعديل" opens. */
function SettingsForm({
  saved,
  onSaved,
}: {
  saved: SellingSettings;
  onSaved: (settings: SellingSettings) => void;
}) {
  const [markup, setMarkup] = useState(markupInput(saved.markupBp));
  const [step, setStep] = useState<string>(
    saved.sypStepUnits === null ? STORE_STEP : String(saved.sypStepUnits),
  );
  const [invalid, setInvalid] = useState(false);
  const [message, setMessage] = useState<{ text: string } | null>(null);
  const [pending, setPending] = useState(false);
  const { ref, focusInvalid } = useFocusInvalid();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    const markupBp = parseMarkup(markup);
    setInvalid(markupBp === undefined);
    if (markupBp === undefined) return focusInvalid();
    setPending(true);
    const result = await saveSellingSettings({
      markupBp,
      sypStepUnits: step === STORE_STEP ? null : (Number(step) as SellingSettings['sypStepUnits']),
    });
    setPending(false);
    if (!result.ok) return setMessage({ text: errorText(result.reason) });
    onSaved(result.data);
  }

  const steps = [
    { value: STORE_STEP, label: tm('prices.stepStore') },
    ...SYP_STEPS.map((units) => ({
      value: String(units),
      label: tm('prices.stepValue', { amount: formatSyp(units) }),
    })),
  ];
  return (
    <form ref={ref} className="grid gap-4 sm:grid-cols-2" onSubmit={submit} noValidate>
      <Field invalid={invalid}>
        <FieldLabel>{tm('prices.markup')}</FieldLabel>
        <Input
          name="markup"
          dir="ltr"
          inputMode="decimal"
          autoComplete="off"
          className="h-11 text-md"
          value={markup}
          onChange={(event) => setMarkup(event.target.value)}
        />
        <FieldDescription>{tm('prices.markupHint')}</FieldDescription>
        <FieldError match={invalid}>{tm('prices.markupInvalid')}</FieldError>
      </Field>
      <Field>
        <FieldLabel render={<span />}>{tm('prices.step')}</FieldLabel>
        <Select items={steps} value={step} onValueChange={(next) => next && setStep(next)}>
          <SelectTrigger aria-label={tm('prices.step')} className="h-11 w-full text-md">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {steps.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <Button type="submit" size="xl" disabled={pending}>
          {tm('common.save')}
        </Button>
        {message && <FormAlert>{message.text}</FormAlert>}
      </div>
    </form>
  );
}

/** The game in the address, `?game=<slug>`, so a reload or a shared link opens it again. */
function rememberGame(slug: string) {
  const url = new URL(window.location.href);
  url.searchParams.set('game', slug);
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`);
}

function GamePrices({ games, settingsKey }: { games: PickerGame[]; settingsKey: string }) {
  const pinned = usePinnedGames();
  const [gameId, setGameId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const pinnedIds = pinned.status === 'ready' ? pinned.ids : [];
  // The address's game, else the first of "ألعابك", else the best seller, else the first game:
  // chosen once the pinned games are known (or failed to load).
  useEffect(() => {
    if (gameId !== null || pinned.status === 'loading') return;
    const asked = new URLSearchParams(window.location.search).get('game');
    const ids = new Set(games.map((game) => game.id));
    const start =
      games.find((game) => game.slug === asked)?.id ??
      (pinned.status === 'ready' ? pinned.ids.find((id) => ids.has(id)) : undefined) ??
      topPickerGames(games, 1)[0]?.id ??
      games[0]?.id ??
      null;
    setGameId(start);
  }, [games, gameId, pinned]);
  // The rows remount with the game (their key), and read again with the settings.
  const read = useCallback(() => getSellingPrices(gameId as string), [gameId]);
  if (games.length === 0) {
    return <EmptyState icon={<PackageIcon />} title={tm('prices.noGames')} />;
  }
  const chosen = games.find((game) => game.id === gameId);
  return (
    <section className="flex flex-col gap-4">
      {chosen ? (
        <ChosenGames games={[chosen]} onChange={() => setPicking(true)} />
      ) : (
        <div className="h-16 rounded-lg border border-border bg-surface" aria-hidden="true" />
      )}
      <GamePickerDialog
        open={picking}
        onOpenChange={setPicking}
        games={games}
        pinned={pinnedIds}
        selected={gameId ? [gameId] : []}
        onPick={([id]) => {
          const game = games.find((item) => item.id === id);
          if (!game) return;
          setGameId(game.id);
          rememberGame(game.slug);
        }}
      />
      {gameId && <PackRows key={gameId} read={read} settingsKey={settingsKey} />}
    </section>
  );
}

const profitOf = (row: SellingPriceRow) =>
  row.sellingUsdUnits === null || row.purchaseUsdUnits === null
    ? null
    : row.sellingUsdUnits - row.purchaseUsdUnits;

function Profit({ row }: { row: SellingPriceRow }) {
  const units = profitOf(row);
  if (units === null) return <span className="text-muted-foreground">—</span>;
  return (
    <bdi
      dir="ltr"
      className={
        units > 0
          ? 'text-status-success-foreground'
          : units < 0
            ? 'text-status-danger-foreground'
            : 'text-muted-foreground'
      }
    >
      {`${units > 0 ? '+' : units < 0 ? '-' : ''}${formatUsd(Math.abs(units))}`}
    </bdi>
  );
}

/** The selling price, USD first with its SYP muted (owner, 2026-10-30). */
function Selling({ row }: { row: SellingPriceRow }) {
  if (row.sellingUsdUnits === null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="flex flex-col">
      <bdi dir="ltr" className="font-semibold">
        {formatUsd(row.sellingUsdUnits)}
      </bdi>
      {row.sellingSypUnits !== null && (
        <span className="text-xs text-muted-foreground">
          {tm('common.approx', {
            amount: tm('common.syp', { amount: formatSyp(row.sellingSypUnits) }),
          })}
        </span>
      )}
    </span>
  );
}

function Purchase({ row }: { row: SellingPriceRow }) {
  return row.purchaseUsdUnits === null ? (
    <span className="text-muted-foreground">{tm('prices.unavailable')}</span>
  ) : (
    <bdi dir="ltr">{formatUsd(row.purchaseUsdUnits)}</bdi>
  );
}

function Source({ row }: { row: SellingPriceRow }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Badge tone={row.source === 'none' ? 'neutral' : row.source === 'product' ? 'gold' : 'info'}>
        {tm(`prices.sources.${row.source}`)}
      </Badge>
      {row.belowCost && <Badge tone="danger">{tm('prices.belowCost')}</Badge>}
    </span>
  );
}

function PackRows({
  read,
  settingsKey,
}: {
  read: () => ReturnType<typeof getSellingPrices>;
  settingsKey: string;
}) {
  const { state, setState, reload } = useMerchantRead(read);
  const [editing, setEditing] = useState<SellingPriceRow | null>(null);
  const [filter, setFilter] = useState<PriceFilter>('all');
  // Saved settings change every selling price: read again, leaving an open dialog as it is.
  const readSettings = useRef(settingsKey);
  useEffect(() => {
    if (readSettings.current === settingsKey) return;
    readSettings.current = settingsKey;
    void reload();
  }, [settingsKey, reload]);
  if (state.status !== 'ready') {
    return (
      <MerchantPageStatus
        state={state}
        onRetry={() => void reload()}
        skeleton={<MerchantSkeleton />}
      />
    );
  }
  const prices: SellingPrices = state.data;
  const replace = (row: SellingPriceRow) =>
    setState({
      status: 'ready',
      data: {
        ...prices,
        products: prices.products.map((item) => (item.productId === row.productId ? row : item)),
      },
    });
  if (prices.products.length === 0) {
    return <EmptyState icon={<PackageIcon />} title={tm('prices.empty')} />;
  }
  const counts = filterCounts(prices.products);
  const rows = prices.products.filter((row) => matchesFilter(row, filter));
  const edit = (row: SellingPriceRow) => (
    <Button
      variant="ghost"
      size="icon"
      aria-label={tm('prices.editOf', { name: row.nameAr })}
      title={tm('prices.edit')}
      onClick={() => setEditing(row)}
    >
      <PencilIcon aria-hidden="true" />
    </Button>
  );
  return (
    <>
      <div className="-mx-1 overflow-x-auto px-1 pb-1">
        <ToggleGroup<PriceFilter>
          aria-label={tm('prices.filters.label')}
          value={[filter]}
          onValueChange={(value) => setFilter(value[0] ?? 'all')}
        >
          {PRICE_FILTERS.map((item) => (
            <ToggleGroupItem key={item} value={item} className="h-11 shrink-0 gap-1.5 px-3">
              {tm(`prices.filters.${item}`)}
              <span className="text-xs text-muted-foreground tabular-nums">{counts[item]}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          {tm('prices.filters.empty')}
        </p>
      ) : (
        <div data-testid="selling-prices">
          {/* A phone: a small card per pack. */}
          <ul className="flex flex-col gap-2 md:hidden">
            {rows.map((row) => (
              <li key={row.productId}>
                <Card className="gap-2 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <bdi className="font-medium">{row.nameAr}</bdi>
                    {edit(row)}
                  </div>
                  <dl className="grid grid-cols-3 gap-2 text-sm tabular-nums">
                    <div className="flex flex-col">
                      <dt className="text-xs text-muted-foreground">{tm('prices.purchase')}</dt>
                      <dd>
                        <Purchase row={row} />
                      </dd>
                    </div>
                    <div className="flex flex-col">
                      <dt className="text-xs text-muted-foreground">{tm('prices.selling')}</dt>
                      <dd>
                        <Selling row={row} />
                      </dd>
                    </div>
                    <div className="flex flex-col">
                      <dt className="text-xs text-muted-foreground">{tm('prices.profit')}</dt>
                      <dd>
                        <Profit row={row} />
                      </dd>
                    </div>
                  </dl>
                  <Source row={row} />
                </Card>
              </li>
            ))}
          </ul>
          {/* Wider: one compact table, its head kept in sight. */}
          <Table
            className="hidden md:table"
            containerClassName="hidden md:block max-h-[calc(100dvh-12rem)] overflow-y-auto"
          >
            <TableHeader>
              <TableRow>
                <TableHead className="sticky top-0 z-10 bg-muted">{tm('prices.pack')}</TableHead>
                <TableHead className="sticky top-0 z-10 bg-muted">
                  {tm('prices.purchase')}
                </TableHead>
                <TableHead className="sticky top-0 z-10 bg-muted">{tm('prices.selling')}</TableHead>
                <TableHead className="sticky top-0 z-10 bg-muted">{tm('prices.profit')}</TableHead>
                <TableHead className="sticky top-0 z-10 bg-muted">{tm('prices.source')}</TableHead>
                <TableHead className="sticky top-0 z-10 w-12 bg-muted">
                  <span className="sr-only">{tm('prices.edit')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.productId}>
                  <TableCell className="font-medium whitespace-normal">
                    <bdi>{row.nameAr}</bdi>
                  </TableCell>
                  <TableCell>
                    <Purchase row={row} />
                  </TableCell>
                  <TableCell className="py-1.5">
                    <Selling row={row} />
                  </TableCell>
                  <TableCell>
                    <Profit row={row} />
                  </TableCell>
                  <TableCell>
                    <Source row={row} />
                  </TableCell>
                  <TableCell className="px-1">{edit(row)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        {editing && (
          <PriceDialog
            key={editing.productId}
            row={editing}
            onDone={(row) => {
              replace(row);
              setEditing(null);
            }}
          />
        )}
      </Dialog>
    </>
  );
}

/**
 * SP2: a pack's own price in USD (first) or SYP. A currency change never carries a typed amount
 * over (`switchSaleCurrency`): 730 SYP is never saved as $730.
 */
function PriceDialog({
  row,
  onDone,
}: {
  row: SellingPriceRow;
  onDone: (row: SellingPriceRow) => void;
}) {
  // The pack's own price as it stands, in its currency; the other currency starts empty.
  const ready = {
    usdUnits: row.ownPrice?.currency === 'usd' ? row.ownPrice.amountUnits : null,
    sypUnits: row.ownPrice?.currency === 'syp' ? row.ownPrice.amountUnits : null,
  };
  const [draft, setDraft] = useState(() => salePriceStart(ready, row.ownPrice?.currency ?? 'usd'));
  const [invalid, setInvalid] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const { ref, focusInvalid } = useFocusInvalid();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const input = parseSellingPrice(draft.currency, draft.amount);
    setInvalid(input === undefined);
    if (input === undefined) return focusInvalid();
    setPending(true);
    const result = await setSellingPrice(row.productId, input);
    setPending(false);
    if (!result.ok) return setFailure(errorText(result.reason));
    onDone(result.data);
  }

  async function clear() {
    setFailure(null);
    setPending(true);
    const result = await clearSellingPrice(row.productId);
    setPending(false);
    if (!result.ok) return setFailure(errorText(result.reason));
    onDone(result.data);
  }

  return (
    <DialogContent closeLabel={tm('common.close')}>
      <DialogHeader>
        <DialogTitle>{tm('prices.editTitle', { name: row.nameAr })}</DialogTitle>
        <DialogDescription>{tm('prices.sypFixed')}</DialogDescription>
      </DialogHeader>
      {row.purchaseUsdUnits !== null && (
        <p className="text-sm text-muted-foreground">
          {tm('prices.purchaseIs', { amount: ltr(formatUsd(row.purchaseUsdUnits)) })}
        </p>
      )}
      <form ref={ref} className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <SellingPriceField
          draft={draft}
          ready={ready}
          invalid={invalid}
          label={tm('prices.amount')}
          onChange={setDraft}
        />
        {failure && <FormAlert>{failure}</FormAlert>}
        <DialogFooter>
          {row.ownPrice && (
            <Button type="button" variant="outline" size="xl" disabled={pending} onClick={clear}>
              {tm('prices.clear')}
            </Button>
          )}
          <Button type="submit" size="xl" disabled={pending}>
            {tm('common.save')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
