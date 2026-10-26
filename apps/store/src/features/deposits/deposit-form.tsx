'use client';

import {
  type Currency,
  type DepositMethod,
  depositLimitBreach,
  formatAmountInput,
  formatRate,
  orderNumberSchema,
  QUOTE_LOCK_MINUTES,
  type ShamCashOptions,
  USDT_METHODS,
  type UsdtOptions,
} from '@vertex-digital/contracts';
import { Button } from '@vertex-digital/ui/components/button';
import { Card } from '@vertex-digital/ui/components/card';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { Field, FieldError, FieldLabel } from '@vertex-digital/ui/components/field';
import { Input } from '@vertex-digital/ui/components/input';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@vertex-digital/ui/components/toggle-group';
import { useFocusInvalid } from '@vertex-digital/ui/focus-invalid';
import { ArrowRightIcon, CircleAlertIcon, ClockIcon, LockIcon, WalletIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { InvalidAlert } from '@/components/invalid-alert';
import { isFrozenCustomer, useCustomer } from '@/features/purchase/session';
import { errorText } from '@/lib/errors';
import { formatDamascusDateTime } from '@/lib/format';
import { t } from '@/lib/i18n';
import { useIdempotentRequest } from '@/lib/idempotency';
import { useSearchParam } from '@/lib/use-search-param';
import {
  amountFromCentsParam,
  amountText,
  gapFill,
  limitText,
  PRESETS_USD,
  parseDepositAmount,
  presetUnits,
  previewUsd,
  usdText,
} from './amounts';
import { GapLines, GapStrip } from './gap';
import { createShamCashDeposit, getShamCashOptions, getUsdtOptions } from './requests';
import { UsdtForm } from './usdt-form';

type State =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; shamCash: ShamCashOptions; usdt: UsdtOptions };

const CURRENCY_ORDER: Currency[] = ['SYP', 'USD'];

/** The method picker's order (S04 screens). */
const METHODS: DepositMethod[] = ['sham_cash', ...USDT_METHODS];

/**
 * Why a method cannot take a deposit now, or null when it can: `stopped` for the emergency stop
 * or the method's pause (S05 rule SW6), shown alike to customers.
 */
function unavailableReason(
  method: DepositMethod,
  shamCash: ShamCashOptions,
  usdt: UsdtOptions,
): 'stopped' | 'unavailable' | 'delayed' | null {
  if (method === 'sham_cash') {
    if (shamCash.state === 'stopped' || shamCash.state === 'paused') return 'stopped';
    return shamCash.state === 'available' ? null : 'unavailable';
  }
  const network = usdt.networks.find((item) => item.method === method);
  if (network?.state === 'stopped' || network?.state === 'paused') return 'stopped';
  if (network?.state === 'available') return null;
  return network?.unavailableReason === 'delayed' ? 'delayed' : 'unavailable';
}

/**
 * "إيداع" (S03, S04 screens): the method picker (Sham Cash, USDT on TRC20 or BEP20), then the
 * method's form. A deposit already waiting for payment opens instead (rule SC4). Read in the
 * browser, never cached.
 */
export function DepositFormPage() {
  const router = useRouter();
  // S22 BG2, BG3: what the customer lacks, for a reservation (its number and the way back) or
  // for a purchase still to make.
  const gap = amountFromCentsParam(useSearchParam('gap'));
  const orderParam = useSearchParam('order');
  const orderId = orderParam && UUID.test(orderParam) ? orderParam : null;
  const numberParam = orderNumberSchema.safeParse(useSearchParam('number') ?? '');
  const orderNumber = numberParam.success ? numberParam.data : null;
  const [state, setState] = useState<State>({ status: 'loading' });
  // S12 CF5: a frozen customer cannot create a deposit (one created before still opens).
  const frozen = isFrozenCustomer(useCustomer());

  const load = useCallback(async () => {
    const [shamCash, usdt] = await Promise.all([getShamCashOptions(), getUsdtOptions()]);
    if (
      (!shamCash.ok && shamCash.reason === 'UNAUTHORIZED') ||
      (!usdt.ok && usdt.reason === 'UNAUTHORIZED')
    ) {
      router.replace('/sign-in?next=%2Fwallet%2Fdeposit');
      return;
    }
    if (!shamCash.ok || !usdt.ok) return setState({ status: 'failed' });
    const pendingId = shamCash.data.pendingDepositId ?? usdt.data.pendingDepositId;
    if (pendingId) {
      router.replace(`/wallet/deposits/${pendingId}`);
      return;
    }
    setState({ status: 'ready', shamCash: shamCash.data, usdt: usdt.data });
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  if (frozen && state.status === 'ready') {
    return (
      <EmptyState
        icon={<LockIcon />}
        title={errorText('ACCOUNT_FROZEN')}
        action={
          <Button size="xl" render={<Link href="/support/new?category=account" />}>
            {t('frozen.contactButton')}
          </Button>
        }
      />
    );
  }
  if (state.status === 'loading') return <FormSkeleton />;
  if (state.status === 'failed') {
    return (
      <EmptyState
        icon={<CircleAlertIcon />}
        title={t('deposits.loadFailed')}
        action={
          <Button
            variant="outline"
            size="xl"
            onClick={() => {
              setState({ status: 'loading' });
              void load();
            }}
          >
            {t('deposits.retry')}
          </Button>
        }
      />
    );
  }
  const { shamCash, usdt } = state;
  const reasons = METHODS.map((method) => unavailableReason(method, shamCash, usdt));
  if (reasons.every((reason) => reason)) {
    const stopped = reasons.includes('stopped');
    return (
      <EmptyState
        icon={<WalletIcon />}
        title={t(stopped ? 'deposits.form.stoppedTitle' : 'deposits.form.unavailableTitle')}
        description={t(stopped ? 'deposits.form.stoppedBody' : 'deposits.form.unavailableBody')}
        action={
          <Button variant="outline" size="xl" render={<Link href="/wallet" />}>
            {t('deposits.backToWallet')}
          </Button>
        }
      />
    );
  }
  return (
    <div className="flex flex-col gap-6">
      {orderId && (
        <Button
          variant="link"
          size="xl"
          className="self-start px-0"
          render={<Link href={`/orders/${orderId}`} />}
        >
          <ArrowRightIcon className="ltr:rotate-180" aria-hidden="true" />
          {t('deposits.form.backToReservation')}
        </Button>
      )}
      {gap !== null && <GapStrip gapUnits={gap} orderNumber={orderNumber} />}
      <MethodPicker key={gap ?? 'none'} shamCash={shamCash} usdt={usdt} gap={gap} />
    </div>
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function MethodPicker({
  shamCash,
  usdt,
  gap,
}: {
  shamCash: ShamCashOptions;
  usdt: UsdtOptions;
  gap: number | null;
}) {
  const [method, setMethod] = useState<DepositMethod>(
    () => METHODS.find((item) => !unavailableReason(item, shamCash, usdt)) ?? 'sham_cash',
  );
  const firstCurrency = CURRENCY_ORDER.find((currency) => shamCash.currencies[currency].available);
  return (
    <div className="flex flex-col gap-6">
      <Field>
        <FieldLabel>{t('deposits.form.method')}</FieldLabel>
        <ToggleGroup<DepositMethod>
          aria-label={t('deposits.form.method')}
          className="grid w-full grid-cols-1 sm:grid-cols-3"
          value={[method]}
          onValueChange={(value) => value[0] && setMethod(value[0])}
        >
          {METHODS.map((item) => {
            const reason = unavailableReason(item, shamCash, usdt);
            return (
              <ToggleGroupItem
                key={item}
                value={item}
                disabled={!!reason}
                className="h-auto min-h-11 flex-col gap-0.5 px-4 py-2 text-md whitespace-normal"
              >
                <span>{t(`deposits.methods.${item}`)}</span>
                {reason && (
                  <span className="text-xs font-normal">
                    {t(`deposits.form.methodUnavailable.${reason}`)}
                  </span>
                )}
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>
      </Field>
      {method === 'sham_cash' ? (
        firstCurrency && (
          <ShamCashForm options={shamCash} initialCurrency={firstCurrency} gap={gap} />
        )
      ) : (
        <UsdtForm key={method} options={usdt} method={method} gap={gap} />
      )}
    </div>
  );
}

function ShamCashForm({
  options,
  initialCurrency,
  gap,
}: {
  options: ShamCashOptions;
  initialCurrency: Currency;
  gap: number | null;
}) {
  const router = useRouter();
  const [currency, setCurrency] = useState<Currency>(initialCurrency);
  // S22 BG3: the gap in this currency, with Sham Cash's limits (pounds on the display step).
  const fill = (next: Currency) =>
    gap === null ? null : gapFill(gap, next, options.limits, options.rate);
  const [text, setText] = useState(() => fill(initialCurrency)?.text ?? '');
  const [error, setError] = useState<string | null>(null);
  const { ref, focusInvalid } = useFocusInvalid();
  const [submitting, setSubmitting] = useState(false);
  // One `Idempotency-Key` per request body: a retry of the same amount after a lost answer
  // returns the first deposit (rule SC2); a changed amount is a new attempt once an answer came
  // back, never after a lost one (F6-14).
  const sendOnce = useIdempotentRequest();

  const rate = options.rate;
  const units = parseDepositAmount(currency, text);
  const declaredUsd =
    units === null
      ? null
      : currency === 'USD'
        ? units
        : rate
          ? previewUsd(units, rate.sypPerUsd)
          : null;

  function changeCurrency(next: Currency) {
    setCurrency(next);
    setText(fill(next)?.text ?? '');
    setError(null);
  }
  const gapLines = fill(currency);

  /** Every refusal here is about the amount: shown under it, with the focus moved there. */
  function refuse(message: string | null) {
    setError(message);
    focusInvalid();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    // Pounds too large to convert are above any per-deposit limit (edge case 12, F3-7).
    const tooLarge = currency === 'SYP' && units !== null && !!rate && declaredUsd === null;
    if (units === null || (declaredUsd === null && !tooLarge)) {
      return refuse(
        t(currency === 'SYP' ? 'deposits.form.invalidSyp' : 'deposits.form.invalidUsd'),
      );
    }
    const breach = options.limits
      ? depositLimitBreach(options.limits, declaredUsd ?? Number.POSITIVE_INFINITY)
      : null;
    if (breach) return refuse(limitText(breach));
    const body = { currency, amountUnits: units };
    setSubmitting(true);
    const result = await sendOnce(JSON.stringify(body), (key) => createShamCashDeposit(body, key));
    if (result.ok) return router.push(`/wallet/deposits/${result.data.id}`);
    setSubmitting(false);
    if (result.reason === 'UNAUTHORIZED')
      return router.replace('/sign-in?next=%2Fwallet%2Fdeposit');
    const pendingId = (result.details as { depositId?: unknown } | undefined)?.depositId;
    if (result.reason === 'DEPOSIT_ALREADY_PENDING' && typeof pendingId === 'string') {
      return router.replace(`/wallet/deposits/${pendingId}`);
    }
    refuse(
      result.reason === 'DEPOSIT_LIMIT_EXCEEDED'
        ? (limitText(result.details) ?? errorText(result.reason))
        : errorText(result.reason),
    );
  }

  return (
    <form ref={ref} className="flex flex-col gap-6" onSubmit={submit} noValidate>
      <Card className="gap-5">
        <Field>
          <FieldLabel>{t('deposits.form.currency')}</FieldLabel>
          <ToggleGroup<Currency>
            aria-label={t('deposits.form.currency')}
            value={[currency]}
            onValueChange={(value) => value[0] && changeCurrency(value[0])}
          >
            {CURRENCY_ORDER.map((item) => (
              <ToggleGroupItem
                key={item}
                value={item}
                disabled={!options.currencies[item].available}
                className="h-11 px-5 text-md"
              >
                {t(`deposits.currencies.${item}`)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {CURRENCY_ORDER.filter((item) => !options.currencies[item].available).map((item) => (
            <p key={item} className="text-sm text-muted-foreground">
              {t(`deposits.form.unavailable.${options.currencies[item].reason ?? 'disabled'}`, {
                currency: t(`deposits.currencyNames.${item}`),
              })}
            </p>
          ))}
        </Field>
        <Field invalid={!!error}>
          <FieldLabel>
            {t(currency === 'SYP' ? 'deposits.form.amountSyp' : 'deposits.form.amountUsd')}
          </FieldLabel>
          <Input
            name="amount"
            dir="ltr"
            inputMode={currency === 'SYP' ? 'numeric' : 'decimal'}
            autoComplete="off"
            className="h-11 text-md"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setError(null);
            }}
          />
          <FieldError match={!!error}>{error}</FieldError>
          {gapLines && <GapLines fill={gapLines} limits={options.limits} />}
        </Field>
        <div className="flex flex-wrap gap-2">
          {PRESETS_USD.map((usd) => {
            const preset = presetUnits(currency, usd, rate);
            if (preset === null) return null;
            return (
              <Button
                key={usd}
                type="button"
                variant="outline"
                size="xl"
                className="px-4 tabular-nums"
                onClick={() => {
                  setText(formatAmountInput(currency, preset));
                  setError(null);
                }}
              >
                {amountText(currency, preset)}
                {/* A preset is a dollar amount: in pounds it says which one (F3-1). */}
                {currency === 'SYP' && (
                  <span className="text-sm font-normal text-muted-foreground">{usdText(usd)}</span>
                )}
              </Button>
            );
          })}
        </div>
        {currency === 'SYP' && rate && (
          <div className="flex flex-col gap-1 rounded-lg border border-border p-3">
            <p className="text-lg font-bold tabular-nums">
              {t('deposits.form.youGet', {
                amount: declaredUsd === null ? '—' : usdText(declaredUsd),
              })}
            </p>
            <p className="text-sm text-muted-foreground tabular-nums">
              {t('deposits.form.rate', { rate: formatRate(rate.sypPerUsd) })}
            </p>
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <LockIcon className="size-4" aria-hidden="true" />
              {t('deposits.form.lock', { minutes: QUOTE_LOCK_MINUTES })}
            </p>
          </div>
        )}
        {options.limits && (
          <p className="text-sm text-muted-foreground tabular-nums">
            {t('deposits.form.limits', {
              min: usdText(options.limits.minUnits),
              max: usdText(options.limits.perDepositUnits),
              remaining: usdText(options.limits.remainingTodayUnits),
            })}
          </p>
        )}
        <ReviewTime options={options} />
      </Card>
      <InvalidAlert show={!!error} />
      <Button type="submit" size="xl" disabled={submitting}>
        {submitting ? t('deposits.form.submitting') : t('deposits.form.submit')}
      </Button>
    </form>
  );
}

/** The review hours and the ETA now, or the next opening (rule SC13). */
function ReviewTime({ options }: { options: ShamCashOptions }) {
  if (!options.reviewHours || !options.eta) return null;
  return (
    <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
      <ClockIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>
        {options.eta.state === 'open'
          ? t('deposits.eta.openWithHours', {
              minutes: options.eta.minutes,
              start: options.reviewHours.start,
              end: options.reviewHours.end,
            })
          : t('deposits.eta.closedWithHours', {
              start: options.reviewHours.start,
              end: options.reviewHours.end,
              date: formatDamascusDateTime(options.eta.opensAt),
            })}
      </span>
    </p>
  );
}

function FormSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden="true">
      <Card className="gap-4">
        <Skeleton className="h-11 w-40" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-16 w-full" />
      </Card>
      <Skeleton className="h-11 w-full" />
    </div>
  );
}
