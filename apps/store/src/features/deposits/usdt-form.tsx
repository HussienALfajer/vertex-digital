'use client';

import {
  depositLimitBreach,
  formatAmountInput,
  type UsdtMethod,
  type UsdtOptions,
} from '@vertex-digital/contracts';
import { Button } from '@vertex-digital/ui/components/button';
import { Callout } from '@vertex-digital/ui/components/callout';
import { Card } from '@vertex-digital/ui/components/card';
import { Field, FieldError, FieldLabel } from '@vertex-digital/ui/components/field';
import { Input } from '@vertex-digital/ui/components/input';
import { NetworkIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type FormEvent, useRef, useState } from 'react';
import { errorText } from '@/lib/errors';
import { t } from '@/lib/i18n';
import {
  limitText,
  ONE_CENT_UNITS,
  parseDepositAmount,
  prefillText,
  USDT_PRESETS_USD,
  usdText,
} from './amounts';
import { createUsdtDeposit } from './requests';

/**
 * The USDT form (S04 screens): the network note, the USD amount with its presets and limits, and
 * who pays the fees. `DEPOSIT_AMOUNT_BUSY` (rule U3) offers the same amount one cent up or down.
 */
export function UsdtForm({
  options,
  method,
  prefillUnits = null,
}: {
  options: UsdtOptions;
  method: UsdtMethod;
  /** The shortfall of a reservation (S09 rule BB8). */
  prefillUnits?: number | null;
}) {
  const router = useRouter();
  const [text, setText] = useState(() => prefillText(prefillUnits, options.limits?.minUnits));
  const [error, setError] = useState<string | null>(null);
  const [busyAlternatives, setBusyAlternatives] = useState<number[]>([]);
  const [submitting, setSubmitting] = useState(false);
  // One `Idempotency-Key` per request body (rule U2, as S03 SC2).
  const attempt = useRef<{ body: string; key: string } | null>(null);

  const units = parseDepositAmount('USD', text);
  const limits = options.limits;

  function change(next: string) {
    setText(next);
    setError(null);
    setBusyAlternatives([]);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusyAlternatives([]);
    if (units === null) return setError(t('deposits.form.invalidUsd'));
    const breach = limits ? depositLimitBreach(limits, units) : null;
    if (breach) return setError(limitText(breach));
    const body = { method, amountUnits: units };
    const sent = JSON.stringify(body);
    if (attempt.current?.body !== sent) attempt.current = { body: sent, key: crypto.randomUUID() };
    setSubmitting(true);
    const result = await createUsdtDeposit(body, attempt.current.key);
    if (result.ok) return router.push(`/wallet/deposits/${result.data.id}`);
    setSubmitting(false);
    if (result.reason === 'UNAUTHORIZED')
      return router.replace('/sign-in?next=%2Fwallet%2Fdeposit');
    const pendingId = (result.details as { depositId?: unknown } | undefined)?.depositId;
    if (result.reason === 'DEPOSIT_ALREADY_PENDING' && typeof pendingId === 'string') {
      return router.replace(`/wallet/deposits/${pendingId}`);
    }
    if (result.reason === 'DEPOSIT_AMOUNT_BUSY') {
      setBusyAlternatives(
        [units + ONE_CENT_UNITS, units - ONE_CENT_UNITS].filter(
          (amount) => amount > 0 && !(limits && depositLimitBreach(limits, amount)),
        ),
      );
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
        <Callout
          tone="info"
          icon={<NetworkIcon />}
          title={t(`deposits.usdt.networkNote.${method}`)}
          description={t('deposits.usdt.networkNoteBody')}
        />
        <Field invalid={!!error}>
          <FieldLabel>{t('deposits.form.amountUsd')}</FieldLabel>
          <Input
            name="amount"
            dir="ltr"
            inputMode="decimal"
            autoComplete="off"
            className="h-11 text-md"
            value={text}
            onChange={(event) => change(event.target.value)}
          />
          <FieldError match={!!error}>{error}</FieldError>
        </Field>
        {busyAlternatives.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">{t('deposits.usdt.busyTry')}</span>
            {busyAlternatives.map((amount) => (
              <Button
                key={amount}
                type="button"
                variant="outline"
                size="xl"
                className="px-4 tabular-nums"
                onClick={() => change(formatAmountInput('USD', amount))}
              >
                {usdText(amount)}
              </Button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {USDT_PRESETS_USD.filter((preset) => !limits || !depositLimitBreach(limits, preset)).map(
            (preset) => (
              <Button
                key={preset}
                type="button"
                variant="outline"
                size="xl"
                className="px-4 tabular-nums"
                onClick={() => change(formatAmountInput('USD', preset))}
              >
                {usdText(preset)}
              </Button>
            ),
          )}
        </div>
        {limits && (
          <p className="text-sm text-muted-foreground tabular-nums">
            {t('deposits.form.limits', {
              min: usdText(limits.minUnits),
              max: usdText(limits.perDepositUnits),
              remaining: usdText(limits.remainingTodayUnits),
            })}
          </p>
        )}
        <p className="text-sm text-muted-foreground">{t('deposits.usdt.fees')}</p>
      </Card>
      <Button type="submit" size="xl" disabled={submitting}>
        {submitting ? t('deposits.form.submitting') : t('deposits.form.submit')}
      </Button>
    </form>
  );
}
