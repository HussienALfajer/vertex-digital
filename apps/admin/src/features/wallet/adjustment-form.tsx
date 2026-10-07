import { formatUsd } from '@vertex-digital/contracts';
import { Field, FieldDescription, FieldError, FieldLabel, Input } from '@vertex-digital/ui';
import type { TFunction } from 'i18next';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../lib/api/client';
import { errorMessage } from '../../lib/errors';

/*
 * What the adjust and reverse dialogs share: the request's `Idempotency-Key`, the typed
 * confirmation above $100 (rule J6), the balance lines, and where a refusal is shown.
 */

export type AdjustmentField =
  | 'amount'
  | 'confirm'
  | 'category'
  | 'method'
  | 'reference'
  | 'reason'
  | 'note';

export type AdjustmentFieldErrors = Partial<Record<AdjustmentField, string>>;

/**
 * The `Idempotency-Key` for a request body (rule J9, edge cases 4–6): one per dialog opening,
 * kept while the same body is sent again (a retry after re-authentication or a lost answer gets
 * the first result), and a new one once a field changed after a refusal, so the edited request is
 * not answered `IDEMPOTENCY_KEY_REUSED`.
 */
export function useIdempotencyKey(): (body: unknown) => string {
  const last = useRef<{ key: string; body: string } | null>(null);
  return (body) => {
    const sent = JSON.stringify(body);
    if (last.current?.body !== sent) last.current = { key: crypto.randomUUID(), body: sent };
    return last.current.key;
  };
}

/** Codes that belong under one field rather than above the buttons. */
const FIELD_OF_CODE: Partial<Record<string, AdjustmentField>> = {
  ADJUSTMENT_NOT_ALLOWED: 'category',
  AMOUNT_CONFIRMATION_REQUIRED: 'confirm',
  AMOUNT_CONFIRMATION_MISMATCH: 'confirm',
  EXTERNAL_REFERENCE_TAKEN: 'reference',
};

/**
 * A refused adjustment, and where to show it. `INSUFFICIENT_BALANCE` names the balance the debit
 * met (rule J5, edge case 3), which may be newer than the one on screen.
 */
export function failureOf(
  t: TFunction,
  error: unknown,
): { field?: AdjustmentField; message: string } {
  const code = error instanceof ApiError ? error.code : undefined;
  if (code === 'INSUFFICIENT_BALANCE' && error instanceof ApiError) {
    const balance = (error.details as { balanceUnits?: unknown } | undefined)?.balanceUnits;
    if (Number.isSafeInteger(balance)) {
      return {
        message: t('wallets.adjust.insufficient', { balance: formatUsd(balance as number) }),
      };
    }
  }
  return { field: code ? FIELD_OF_CODE[code] : undefined, message: errorMessage(t, error) };
}

/** The amount typed a second time, never pasted (rule J6). */
export function ConfirmAmountField({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string;
}) {
  const { t } = useTranslation();
  return (
    <Field invalid={!!error}>
      <FieldLabel>{t('wallets.adjust.confirm')}</FieldLabel>
      <Input
        name="amountConfirmation"
        dir="ltr"
        inputMode="decimal"
        autoComplete="off"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onPaste={(event) => event.preventDefault()}
        onDrop={(event) => event.preventDefault()}
      />
      <FieldDescription>{t('wallets.adjust.confirmHint')}</FieldDescription>
      <FieldError match={!!error}>{error}</FieldError>
    </Field>
  );
}

/** The balance now and after the movement (unknown until the amount is valid). */
export function BalanceLines({
  balanceUnits,
  signedUnits,
}: {
  balanceUnits: number;
  signedUnits: number | null;
}) {
  const { t } = useTranslation();
  const after = signedUnits === null ? null : balanceUnits + signedUnits;
  return (
    <dl className="grid grid-cols-2 gap-3 rounded-lg border border-border p-3 text-sm">
      <div className="flex flex-col gap-1">
        <dt className="text-muted-foreground">{t('wallets.adjust.balanceNow')}</dt>
        <dd className="text-base font-medium tabular-nums">
          <bdi dir="ltr">{formatUsd(balanceUnits)}</bdi>
        </dd>
      </div>
      <div className="flex flex-col gap-1">
        <dt className="text-muted-foreground">{t('wallets.adjust.balanceAfter')}</dt>
        <dd
          className={
            after !== null && after < 0
              ? 'text-base font-medium text-destructive-text tabular-nums'
              : 'text-base font-medium tabular-nums'
          }
        >
          <bdi dir="ltr">{after === null ? '—' : formatUsd(after)}</bdi>
        </dd>
      </div>
    </dl>
  );
}
