'use client';

import {
  formatSyp,
  formatUsd,
  type MerchantGame,
  type SaleCurrency,
  type SellingPriceRow,
  type SellingPrices,
  type SellingSettings,
  SYP_STEPS,
} from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui/components/badge';
import { Button } from '@vertex-digital/ui/components/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@vertex-digital/ui/components/card';
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
import { ToggleGroup, ToggleGroupItem } from '@vertex-digital/ui/components/toggle-group';
import { useFocusInvalid } from '@vertex-digital/ui/focus-invalid';
import { PackageIcon, PencilIcon } from 'lucide-react';
import { type FormEvent, useCallback, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { errorText } from '@/lib/errors';
import { markupInput, parseMarkup, parseSellingPrice, sellingPriceInput } from './form';
import { tm } from './i18n';
import { MerchantPageStatus, MerchantSkeleton, useMerchantRead } from './merchant-state';
import {
  clearSellingPrice,
  getMerchantGames,
  getSellingPrices,
  getSellingSettings,
  saveSellingSettings,
  setSellingPrice,
} from './requests';

const STORE_STEP = 'store';

/**
 * "أسعار البيع" (S21 F31, SP1–SP3): the markup and the SYP step, then per game each pack's
 * purchase price (the merchant's own list), its selling price in USD and SYP, its source and the
 * below-cost warning; a pack's own price is set in USD or SYP, or cleared back to the markup.
 */
export function PricesPage() {
  const read = useCallback(async () => {
    const [settings, games] = [await getSellingSettings(), await getMerchantGames()];
    if (!settings.ok) return settings;
    if (!games.ok) return games;
    return { ok: true as const, data: { settings: settings.data, games: games.data.items } };
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
    <div className="flex flex-col gap-6">
      <SettingsCard
        saved={state.data.settings}
        onSaved={(settings) => setState({ status: 'ready', data: { ...state.data, settings } })}
      />
      <GamePrices games={state.data.games} settingsKey={JSON.stringify(state.data.settings)} />
    </div>
  );
}

function SettingsCard({
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
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
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
    if (!result.ok) return setMessage({ ok: false, text: errorText(result.reason) });
    setMessage({ ok: true, text: tm('common.saved') });
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
    <Card>
      <CardHeader>
        <CardTitle>{tm('prices.settingsTitle')}</CardTitle>
        <CardDescription>{tm('prices.settingsBody')}</CardDescription>
      </CardHeader>
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
          {message &&
            (message.ok ? (
              <span role="status" className="text-sm text-muted-foreground">
                {message.text}
              </span>
            ) : (
              <FormAlert>{message.text}</FormAlert>
            ))}
        </div>
      </form>
    </Card>
  );
}

function GamePrices({ games, settingsKey }: { games: MerchantGame[]; settingsKey: string }) {
  const [gameId, setGameId] = useState<string | null>(games[0]?.id ?? null);
  // The rows remount with the settings (their key), so a settings change reprices them.
  const read = useCallback(() => getSellingPrices(gameId as string), [gameId]);
  if (games.length === 0) {
    return <EmptyState icon={<PackageIcon />} title={tm('prices.noGames')} />;
  }
  const items = games.map((game) => ({ value: game.id, label: game.nameAr }));
  return (
    <section className="flex flex-col gap-4">
      <Field className="max-w-sm">
        <FieldLabel render={<span />}>{tm('prices.game')}</FieldLabel>
        <Select items={items} value={gameId} onValueChange={(next) => next && setGameId(next)}>
          <SelectTrigger aria-label={tm('prices.game')} className="h-11 w-full text-md">
            <SelectValue placeholder={tm('prices.chooseGame')} />
          </SelectTrigger>
          <SelectContent className="max-h-80">
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {gameId && <PackRows key={`${gameId}:${settingsKey}`} read={read} />}
    </section>
  );
}

function PackRows({ read }: { read: () => ReturnType<typeof getSellingPrices> }) {
  const { state, setState, reload } = useMerchantRead(read);
  const [editing, setEditing] = useState<SellingPriceRow | null>(null);
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
  return (
    <>
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2" data-testid="selling-prices">
        {prices.products.map((row) => (
          <li key={row.productId}>
            <Card className="gap-3">
              <div className="flex items-start justify-between gap-3">
                <span className="font-medium">{row.nameAr}</span>
                <Badge tone={row.source === 'none' ? 'neutral' : 'info'}>
                  {tm(`prices.sources.${row.source}`)}
                </Badge>
              </div>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <dt className="text-muted-foreground">{tm('prices.purchase')}</dt>
                <dd className="text-end tabular-nums">
                  {row.purchaseUsdUnits === null ? (
                    <span className="text-muted-foreground">{tm('prices.unavailable')}</span>
                  ) : (
                    <bdi dir="ltr">{formatUsd(row.purchaseUsdUnits)}</bdi>
                  )}
                </dd>
                <dt className="text-muted-foreground">{tm('prices.selling')}</dt>
                <dd className="flex flex-col items-end tabular-nums">
                  {row.sellingUsdUnits === null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <>
                      <bdi dir="ltr" className="font-semibold">
                        {formatUsd(row.sellingUsdUnits)}
                      </bdi>
                      {row.sellingSypUnits !== null && (
                        <span className="text-muted-foreground">
                          {tm('common.syp', { amount: formatSyp(row.sellingSypUnits) })}
                        </span>
                      )}
                    </>
                  )}
                </dd>
              </dl>
              {row.belowCost && (
                <span className="text-sm font-medium text-destructive">
                  {tm('prices.belowCost')}
                </span>
              )}
              <Button
                variant="outline"
                size="xl"
                className="self-start"
                onClick={() => setEditing(row)}
              >
                <PencilIcon />
                {tm('prices.edit')}
              </Button>
            </Card>
          </li>
        ))}
      </ul>
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

function PriceDialog({
  row,
  onDone,
}: {
  row: SellingPriceRow;
  onDone: (row: SellingPriceRow) => void;
}) {
  const [currency, setCurrency] = useState<SaleCurrency>(row.ownPrice?.currency ?? 'syp');
  const [amount, setAmount] = useState(row.ownPrice ? sellingPriceInput(row.ownPrice) : '');
  const [invalid, setInvalid] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const { ref, focusInvalid } = useFocusInvalid();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const input = parseSellingPrice(currency, amount);
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
      <form ref={ref} className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <Field>
          <FieldLabel>{tm('prices.currency')}</FieldLabel>
          <ToggleGroup<SaleCurrency>
            aria-label={tm('prices.currency')}
            value={[currency]}
            onValueChange={(value) => value[0] && setCurrency(value[0])}
          >
            <ToggleGroupItem value="syp" className="h-10 px-4 text-md">
              {tm('prices.syp')}
            </ToggleGroupItem>
            <ToggleGroupItem value="usd" className="h-10 px-4 text-md">
              {tm('prices.usd')}
            </ToggleGroupItem>
          </ToggleGroup>
        </Field>
        <Field invalid={invalid}>
          <FieldLabel>{tm('prices.amount')}</FieldLabel>
          <Input
            name="amount"
            dir="ltr"
            inputMode={currency === 'usd' ? 'decimal' : 'numeric'}
            autoComplete="off"
            className="h-11 text-md"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
          <FieldError match={invalid}>
            {currency === 'usd' ? tm('prices.amountInvalidUsd') : tm('prices.amountInvalidSyp')}
          </FieldError>
        </Field>
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
