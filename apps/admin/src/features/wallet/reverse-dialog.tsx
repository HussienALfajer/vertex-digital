import {
  ADJUSTMENT_CONFIRMATION_THRESHOLD_USD_UNITS,
  type AdminWalletEntry,
  formatSignedUsd,
  parseUsd,
  type ReverseAdjustment,
  reverseAdjustmentSchema,
} from '@vertex-digital/contracts';
import {
  Button,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Textarea,
} from '@vertex-digital/ui';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { formatDateTime } from '../../lib/format';
import { useIdempotencyKey } from '../../lib/idempotency';
import {
  type AdjustmentFieldErrors,
  BalanceLines,
  ConfirmAmountField,
  failureOf,
} from './adjustment-form';
import { useReverseAdjustment } from './wallet.queries';
import { entryLabel } from './wallet-labels';

/**
 * Reverses one adjustment (rules R1–R5): the original's direction, amount, category and date, the
 * balance it leaves, a reason and an optional note; above $100 the amount typed twice (rule J6).
 */
export function ReverseDialog({
  entry,
  adjustment,
  balanceUnits,
  onDone,
}: {
  entry: AdminWalletEntry;
  adjustment: NonNullable<AdminWalletEntry['adjustment']>;
  balanceUnits: number;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const reverse = useReverseAdjustment();
  const keyFor = useIdempotencyKey();
  const [confirmText, setConfirmText] = useState('');
  const [errors, setErrors] = useState<AdjustmentFieldErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const amountUnits = Math.abs(entry.amountUnits);
  const needsConfirmation = amountUnits > ADJUSTMENT_CONFIRMATION_THRESHOLD_USD_UNITS;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const data = new FormData(event.currentTarget);
    const text = (name: string) => String(data.get(name) ?? '').trim();
    const confirmation = needsConfirmation ? (parseUsd(confirmText) ?? -1) : undefined;
    const parsed = reverseAdjustmentSchema.safeParse({
      reason: text('reason'),
      customerNote: text('customerNote') || undefined,
      amountConfirmationUnits: confirmation,
    });
    const found: AdjustmentFieldErrors = {};
    for (const issue of parsed.error?.issues ?? []) {
      if (issue.path[0] === 'reason') found.reason = t('wallets.adjust.errors.reason');
      if (issue.path[0] === 'customerNote') found.note = t('wallets.adjust.errors.note');
    }
    if (needsConfirmation && confirmation !== amountUnits) {
      found.confirm = t('wallets.adjust.errors.confirm');
    }
    setErrors(found);
    if (!parsed.success || found.confirm) return;

    const body: ReverseAdjustment = parsed.data;
    try {
      await reverse.mutateAsync({ id: adjustment.id, body, key: keyFor(body) });
      onDone();
    } catch (error) {
      const shown = failureOf(t, error);
      if (shown.field) setErrors({ [shown.field]: shown.message });
      else setFailure(shown.message);
    }
  }

  return (
    <DialogContent closeLabel={t('common.close')} className="max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{t('wallets.reverse.title')}</DialogTitle>
        <DialogDescription>{t('wallets.reverse.description')}</DialogDescription>
      </DialogHeader>
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <div className="flex flex-col gap-1 rounded-lg border border-border p-3">
          <p className="text-sm text-muted-foreground">{t('wallets.reverse.original')}</p>
          <p className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-medium">
              {t(`wallets.directions.${adjustment.direction}`)} · {entryLabel(t, entry)}
            </span>
            <bdi dir="ltr" className="font-bold tabular-nums">
              {formatSignedUsd(entry.amountUnits)}
            </bdi>
          </p>
          <p className="text-sm text-muted-foreground">{formatDateTime(entry.occurredAt)}</p>
        </div>
        {needsConfirmation && (
          <ConfirmAmountField
            value={confirmText}
            onChange={setConfirmText}
            error={errors.confirm}
          />
        )}
        <Field invalid={!!errors.reason}>
          <FieldLabel>{t('wallets.adjust.reason')}</FieldLabel>
          <Textarea name="reason" rows={2} maxLength={500} autoFocus />
          <FieldDescription>{t('wallets.adjust.reasonHint')}</FieldDescription>
          <FieldError match={!!errors.reason}>{errors.reason}</FieldError>
        </Field>
        <Field invalid={!!errors.note}>
          <FieldLabel>{t('wallets.adjust.note')}</FieldLabel>
          <Textarea name="customerNote" rows={2} maxLength={200} />
          <FieldDescription>{t('wallets.adjust.noteHint')}</FieldDescription>
          <FieldError match={!!errors.note}>{errors.note}</FieldError>
        </Field>
        <BalanceLines balanceUnits={balanceUnits} signedUnits={-entry.amountUnits} />
        {failure && <FormAlert>{failure}</FormAlert>}
        <DialogFooter>
          <Button type="submit" variant="destructive" disabled={reverse.isPending}>
            {reverse.isPending ? t('wallets.reverse.submitting') : t('wallets.reverse.submit')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
