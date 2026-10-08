'use client';

import {
  type Currency,
  type DepositMethod,
  depositLimitBreach,
  formatAmountInput,
  formatRate,
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
import { CircleAlertIcon, ClockIcon, LockIcon, WalletIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { errorText } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { t } from '@/lib/i18n';
import {
  amountText,
  limitText,
  PRESETS_USD,
  parseDepositAmount,
  presetUnits,
  previewUsd,
  usdText,
} from './amounts';
import { createShamCashDeposit, getShamCashOptions, getUsdtOptions } from './requests';
import { UsdtForm } from './usdt-form';

type State =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; shamCash: ShamCashOptions; usdt: UsdtOptions };

const CURRENCY_ORDER: Currency[] = ['SYP', 'USD'];

/** The method picker's order (S04 screens). */
const METHODS: DepositMethod[] = ['sham_cash', ...USDT_METHODS];

/** Why a method cannot take a deposit now, or null when it can. */
function unavailableReason(
  method: DepositMethod,
  shamCash: ShamCashOptions,
  usdt: UsdtOptions,
): 'unavailable' | 'delayed' | null {
  if (method === 'sham_cash') {
    return CURRENCY_ORDER.some((currency) => shamCash.currencies[currency].available)
      ? null
      : 'unavailable';
  }
  const network = usdt.networks.find((item) => item.method === method);
  if (network?.available) return null;
  return network?.unavailableReason === 'delayed' ? 'delayed' : 'unavailable';
}

/**
 * "إيداع" (S03, S04 screens): the method picker (Sham Cash, USDT on TRC20 or BEP20), then the
 * method's form. A deposit already waiting for payment opens instead (rule SC4). Read in the
 * browser, never cached.
 */
export function DepositFormPage() {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: 'loading' });

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
  if (METHODS.every((method) => unavailableReason(method, shamCash, usdt))) {
    return (
      <EmptyState
        icon={<WalletIcon />}
        title={t('deposits.form.unavailableTitle')}
        description={t('deposits.form.unavailableBody')}
        action={
          <Button variant="outline" size="xl" render={<Link href="/wallet" />}>
            {t('deposits.backToWallet')}
          </Button>
        }
      />
    );
  }
  return <MethodPicker shamCash={shamCash} usdt={usdt} />;
}

function MethodPicker({ shamCash, usdt }: { shamCash: ShamCashOptions; usdt: UsdtOptions }) {
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
        firstCurrency && <ShamCashForm options={shamCash} initialCurrency={firstCurrency} />
      ) : (
        <UsdtForm key={method} options={usdt} method={method} />
      )}
    </div>
  );
}

function ShamCashForm({
  options,
  initialCurrency,
}: {
  options: ShamCashOptions;
  initialCurrency: Currency;
}) {
  const router = useRouter();
  const [currency, setCurrency] = useState<Currency>(initialCurrency);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // One `Idempotency-Key` per request body: a retry of the same amount after a lost answer
  // returns the first deposit (rule SC2); a changed amount is a new attempt.
  const attempt = useRef<{ body: string; key: string } | null>(null);

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
    setText('');
    setError(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (units === null || declaredUsd === null) {
      return setError(
        t(currency === 'SYP' ? 'deposits.form.invalidSyp' : 'deposits.form.invalidUsd'),
      );
    }
    const breach = options.limits ? depositLimitBreach(options.limits, declaredUsd) : null;
    if (breach) return setError(limitText(breach));
    const body = { currency, amountUnits: units };
    const sent = JSON.stringify(body);
    if (attempt.current?.body !== sent) attempt.current = { body: sent, key: crypto.randomUUID() };
    setSubmitting(true);
    const result = await createShamCashDeposit(body, attempt.current.key);
    if (result.ok) return router.push(`/wallet/deposits/${result.data.id}`);
    setSubmitting(false);
    if (result.reason === 'UNAUTHORIZED')
      return router.replace('/sign-in?next=%2Fwallet%2Fdeposit');
    const pendingId = (result.details as { depositId?: unknown } | undefined)?.depositId;
    if (result.reason === 'DEPOSIT_ALREADY_PENDING' && typeof pendingId === 'string') {
      return router.replace(`/wallet/deposits/${pendingId}`);
    }
    setError(
      result.reason === 'DEPOSIT_LIMIT_EXCEEDED'
        ? (limitText(result.details) ?? errorText(result.reason))
        : errorText(result.reason),
    );
  }

  return (
    <form className="flex flex-col gap-6" onSubmit={submit} noValidate>
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
              date: formatDateTime(options.eta.opensAt),
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
