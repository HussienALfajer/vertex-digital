'use client';

import {
  formatRate,
  formatUsd,
  type MerchantShop,
  type ShopCustomerRow,
  type ShopTransferCurrency,
  type ShopTransferResult,
} from '@vertex-digital/contracts';
import { Button } from '@vertex-digital/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@vertex-digital/ui/components/dialog';
import { Field, FieldError, FieldLabel } from '@vertex-digital/ui/components/field';
import { Input } from '@vertex-digital/ui/components/input';
import { PasswordInput } from '@vertex-digital/ui/components/password-input';
import { SlideToPay } from '@vertex-digital/ui/components/slide-to-pay';
import { ToggleGroup, ToggleGroupItem } from '@vertex-digital/ui/components/toggle-group';
import { useFocusInvalid } from '@vertex-digital/ui/focus-invalid';
import { CircleCheckIcon, LoaderCircleIcon, LockIcon } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { apiRequest } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { ltr } from '@/lib/format';
import { t } from '@/lib/i18n';
import { mayHaveLanded } from '@/lib/idempotency';
import { sendAttempt } from '../purchase/attempt';
import { tsa } from './i18n';
import { transfer, transferCheck } from './requests';
import { freesTransferKey, remainingToday, transferPreview } from './rules';

type Refusal = { text: string };

/**
 * "شحن رصيد" (S26 WL1–WL4): the amount in SYP (whole pounds, at the shop's rate) or USD, the USD
 * it credits rounded down, today's remaining cap, the merchant's balance; the slide sends it with
 * one `Idempotency-Key` per amount, kept per customer in this tab's session storage
 * (`sendAttempt`), so a lost answer, a closed dialog or a reload never makes a second transfer. A
 * transfer the API answers `REAUTHENTICATION_REQUIRED` asks for the password (15 minutes, WL4),
 * then sends the same transfer again with the same key. Closed after an answer that may have
 * written, the page reads its customers again (`onClose(true)`).
 */
export function TransferDialog({
  shop,
  customer,
  onClose,
  onDone,
}: {
  shop: MerchantShop;
  customer: ShopCustomerRow;
  onClose: (unsettled: boolean) => void;
  onDone: (result: ShopTransferResult) => void;
}) {
  const [currency, setCurrency] = useState<ShopTransferCurrency>(shop.rate ? 'syp' : 'usd');
  const [typed, setTyped] = useState('');
  const [showError, setShowError] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [sending, setSending] = useState(false);
  const [askPassword, setAskPassword] = useState(false);
  const [done, setDone] = useState<ShopTransferResult | null>(null);
  const [slide, setSlide] = useState(0);
  const [balance, setBalance] = useState<number | null>(null);
  const [unsettled, setUnsettled] = useState(false);
  const preview = transferPreview(currency, typed, shop.rate);
  const remaining = remainingToday(
    shop.limits.dailyTransferCapUsdUnits,
    shop.transferredTodayUsdUnits,
  );

  useEffect(() => {
    let live = true;
    void apiRequest<{ balanceUnits: number }>('/api/wallet').then((result) => {
      if (live && result.ok) setBalance(result.data.balanceUnits);
    });
    return () => {
      live = false;
    };
  }, []);

  async function confirm() {
    setShowError(true);
    setRefusal(null);
    if (preview.kind !== 'ok') return setSlide((n) => n + 1);
    const body = {
      currency,
      amountUnits: preview.amountUnits,
      expectedUsdUnits: preview.usdUnits,
    };
    setSending(true);
    const result = await sendAttempt(
      `shop-transfer:${customer.id}`,
      JSON.stringify({ customer: customer.id, ...body }),
      (key) => transfer(customer.id, body, key),
      freesTransferKey,
    );
    setSending(false);
    setUnsettled(!result.ok && mayHaveLanded(result.reason));
    setSlide((n) => n + 1);
    if (result.ok) {
      setDone(result.data);
      setBalance(result.data.merchantBalanceUsdUnits);
      return onDone(result.data);
    }
    if (result.reason === 'REAUTHENTICATION_REQUIRED') return setAskPassword(true);
    const details = result.details as
      | { largestUsdUnits?: number; remainingUsdUnits?: number }
      | undefined;
    const text =
      result.reason === 'SHOP_BALANCE_CAP_EXCEEDED'
        ? tsa('transfer.capExceeded', { amount: ltr(formatUsd(details?.largestUsdUnits ?? 0)) })
        : result.reason === 'SHOP_DAILY_TRANSFER_CAP_EXCEEDED'
          ? tsa('transfer.dailyExceeded', {
              amount: ltr(formatUsd(details?.remainingUsdUnits ?? 0)),
            })
          : result.reason === 'PRICE_CHANGED'
            ? tsa('transfer.rateChanged')
            : result.reason === 'INSUFFICIENT_BALANCE'
              ? tsa('transfer.insufficient')
              : result.reason === 'ACCOUNT_FROZEN'
                ? tsa('transfer.frozen')
                : errorText(result.reason);
    setRefusal({ text });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !sending && onClose(unsettled)}>
      <DialogContent closeLabel={tsa('common.close')} className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{tsa('transfer.title', { name: customer.name })}</DialogTitle>
          <DialogDescription>{tsa('transfer.body')}</DialogDescription>
        </DialogHeader>
        {done ? (
          <div className="flex flex-col gap-4" role="status">
            <p className="flex items-center gap-2 text-status-success-foreground">
              <CircleCheckIcon className="size-5 shrink-0" aria-hidden="true" />
              {tsa('transfer.done', {
                amount: ltr(formatUsd(done.amountUsdUnits)),
                name: customer.name,
              })}
            </p>
            <Figure
              label={tsa('transfer.customerBalance')}
              value={formatUsd(done.customerBalanceUsdUnits)}
            />
            <Button size="xl" variant="outline" onClick={() => onClose(unsettled)}>
              {tsa('common.close')}
            </Button>
          </div>
        ) : askPassword ? (
          <PasswordStep
            onChecked={() => {
              setAskPassword(false);
              void confirm();
            }}
          />
        ) : (
          <div className="flex flex-col gap-4">
            <Field>
              <FieldLabel render={<span />}>{tsa('transfer.currency')}</FieldLabel>
              <ToggleGroup<ShopTransferCurrency>
                aria-label={tsa('transfer.currency')}
                value={[currency]}
                onValueChange={(value) => {
                  if (!value[0]) return;
                  setCurrency(value[0]);
                  setTyped('');
                  setShowError(false);
                }}
              >
                <ToggleGroupItem
                  value="syp"
                  disabled={shop.rate === null}
                  className="h-11 px-4 text-md"
                >
                  {tsa('transfer.syp')}
                </ToggleGroupItem>
                <ToggleGroupItem value="usd" className="h-11 px-4 text-md">
                  {tsa('transfer.usd')}
                </ToggleGroupItem>
              </ToggleGroup>
              {shop.rate === null && (
                <p className="text-sm text-muted-foreground">{tsa('transfer.noRate')}</p>
              )}
            </Field>
            <Field invalid={showError && preview.kind !== 'ok'}>
              <FieldLabel>
                {currency === 'syp' ? tsa('transfer.amountSyp') : tsa('transfer.amountUsd')}
              </FieldLabel>
              <Input
                name="amount"
                dir="ltr"
                inputMode={currency === 'syp' ? 'numeric' : 'decimal'}
                className="h-11 text-md"
                value={typed}
                disabled={sending}
                onChange={(event) => {
                  setTyped(event.target.value);
                  setRefusal(null);
                }}
              />
              <FieldError
                match={showError && (preview.kind === 'invalid' || preview.kind === 'empty')}
              >
                {currency === 'syp'
                  ? tsa('transfer.amountInvalidSyp')
                  : tsa('transfer.amountInvalidUsd')}
              </FieldError>
              <FieldError match={showError && preview.kind === 'below_minimum'}>
                {tsa('transfer.amountMin')}
              </FieldError>
            </Field>
            <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-3">
              <Figure
                label={tsa('transfer.credits')}
                value={preview.kind === 'ok' ? formatUsd(preview.usdUnits) : '—'}
                strong
                testId="transfer-usd"
              />
              {currency === 'syp' && shop.rate && (
                <span className="text-xs text-muted-foreground">
                  {tsa('transfer.rateLine', { rate: formatRate(shop.rate) })}
                </span>
              )}
              <Figure label={tsa('transfer.remaining')} value={formatUsd(remaining)} />
              <Figure
                label={tsa('transfer.customerBalance')}
                value={formatUsd(customer.balanceUsdUnits)}
              />
              {balance !== null && (
                <Figure label={tsa('transfer.yourBalance')} value={formatUsd(balance)} />
              )}
            </div>
            {refusal && <FormAlert>{refusal.text}</FormAlert>}
            {sending ? (
              <p
                className="flex items-center justify-center gap-2 text-sm text-muted-foreground"
                role="status"
              >
                <LoaderCircleIcon className="size-4 animate-spin" aria-hidden="true" />
              </p>
            ) : (
              <SlideToPay
                key={slide}
                label={tsa('transfer.slide', {
                  amount: preview.kind === 'ok' ? ltr(formatUsd(preview.usdUnits)) : '',
                }).trim()}
                onConfirm={() => void confirm()}
              />
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Figure({
  label,
  value,
  strong = false,
  testId,
}: {
  label: string;
  value: string;
  strong?: boolean;
  testId?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <bdi
        dir="ltr"
        className={`tabular-nums ${strong ? 'text-lg font-bold' : 'font-medium'}`}
        data-testid={testId}
      >
        {value}
      </bdi>
    </div>
  );
}

/** WL4: the merchant's password opens transfers for 15 minutes. */
function PasswordStep({ onChecked }: { onChecked: () => void }) {
  const [password, setPassword] = useState('');
  const [showError, setShowError] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const { ref, focusInvalid } = useFocusInvalid();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setShowError(true);
    setFailure(null);
    if (password === '') return focusInvalid();
    setChecking(true);
    const result = await transferCheck(password);
    setChecking(false);
    if (result.ok) return onChecked();
    setFailure(
      result.reason === 'INVALID_PASSWORD'
        ? tsa('transfer.passwordWrong')
        : errorText(result.reason),
    );
    focusInvalid();
  }

  return (
    <form
      ref={ref}
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(event) => void submit(event)}
    >
      <div className="flex items-start gap-3 rounded-md bg-status-info p-3 text-sm text-status-info-foreground">
        <LockIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span className="flex flex-col gap-1">
          <span className="font-bold">{tsa('transfer.passwordTitle')}</span>
          <span>{tsa('transfer.passwordBody')}</span>
        </span>
      </div>
      <Field invalid={showError && (password === '' || failure !== null)}>
        <FieldLabel>{tsa('transfer.password')}</FieldLabel>
        <PasswordInput
          name="password"
          autoComplete="current-password"
          className="h-11 text-md"
          showLabel={t('fields.showPassword')}
          hideLabel={t('fields.hidePassword')}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <FieldError match={showError && password === ''}>
          {tsa('transfer.passwordInvalid')}
        </FieldError>
      </Field>
      {failure && <FormAlert>{failure}</FormAlert>}
      <Button type="submit" size="xl" disabled={checking}>
        {checking && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
        {tsa('transfer.passwordConfirm')}
      </Button>
    </form>
  );
}
