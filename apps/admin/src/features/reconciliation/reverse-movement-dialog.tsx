import {
  type ReverseTreasuryMovement,
  reverseTreasuryMovementSchema,
  TREASURY_PLACES,
  type TreasuryMovement,
  type TreasuryPlace,
} from '@vertex-digital/contracts';
import {
  Button,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldError,
  FieldLabel,
  Textarea,
  useFocusInvalid,
} from '@vertex-digital/ui';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert, InvalidAlert } from '../../components/form-alert';
import { formatDateTime } from '../../lib/format';
import { useIdempotencyKey } from '../../lib/idempotency';
import { ConfirmAmountField } from '../wallet/adjustment-form';
import { useReverseMovement } from './reconciliation.queries';
import { money, placeLabel } from './reconciliation-labels';
import {
  parsePlaceAmount,
  type TreasuryField,
  type TreasuryFieldErrors,
  treasuryFailure,
  useNeedsConfirmation,
} from './treasury-form';

const FIELDS: readonly TreasuryField[] = ['reason', 'confirm'];

/** The place an amount is typed for: a place's own precision; the corrections' side is USD. */
const amountPlace = (movement: TreasuryMovement): TreasuryPlace =>
  (TREASURY_PLACES as readonly string[]).includes(movement.from)
    ? (movement.from as TreasuryPlace)
    : (movement.to as TreasuryPlace);

/**
 * "عكس" (rule T9): the original's places, amounts and date, a reason; above $100 the sent amount
 * typed twice. The reversal mirrors every posting and is final.
 */
export function ReverseMovementDialog({
  movement,
  onDone,
}: {
  movement: TreasuryMovement;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const reverse = useReverseMovement();
  const keyFor = useIdempotencyKey();
  const [confirmText, setConfirmText] = useState('');
  const [forceConfirm, setForceConfirm] = useState(false);
  const [errors, setErrors] = useState<TreasuryFieldErrors>({});
  const { ref, focusInvalid } = useFocusInvalid();
  const [failure, setFailure] = useState<string | null>(null);
  const needsConfirmation =
    useNeedsConfirmation(movement.sentCurrency, movement.sentUnits) || forceConfirm;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const data = new FormData(event.currentTarget);
    const confirmation = needsConfirmation
      ? (parsePlaceAmount(amountPlace(movement), confirmText) ?? -1)
      : undefined;
    const parsed = reverseTreasuryMovementSchema.safeParse({
      reason: String(data.get('reason') ?? '').trim(),
      amountConfirmationUnits: confirmation,
    });
    const found: TreasuryFieldErrors = {};
    if (parsed.error?.issues.some((issue) => issue.path[0] === 'reason')) {
      found.reason = t('reconciliation.movement.errors.reason');
    }
    if (needsConfirmation && confirmation !== movement.sentUnits) {
      found.confirm = t('wallets.adjust.errors.confirm');
    }
    setErrors(found);
    if (!parsed.success || Object.keys(found).length > 0) return focusInvalid();

    const body: ReverseTreasuryMovement = parsed.data;
    try {
      await reverse.mutateAsync({ id: movement.id, body, key: keyFor(body) });
      onDone();
    } catch (error) {
      const shown = treasuryFailure(t, error, FIELDS);
      if (shown.field === 'confirm') setForceConfirm(true);
      if (!shown.field) return setFailure(shown.message);
      setErrors({ [shown.field]: shown.message });
      focusInvalid();
    }
  }

  return (
    <DialogContent closeLabel={t('common.close')} className="max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{t('reconciliation.reverse.title')}</DialogTitle>
        <DialogDescription>{t('reconciliation.reverse.description')}</DialogDescription>
      </DialogHeader>
      <form ref={ref} className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <div className="flex flex-col gap-1 rounded-lg border border-border p-3">
          <p className="text-sm text-muted-foreground">{t('reconciliation.reverse.original')}</p>
          <p className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-medium">
              {t('reconciliation.movements.route', {
                from: placeLabel(t, movement.from),
                to: placeLabel(t, movement.to),
              })}
            </span>
            <span className="font-bold tabular-nums">
              {money(t, movement.sentCurrency, movement.sentUnits)}
            </span>
          </p>
          <p className="text-sm text-muted-foreground">{formatDateTime(movement.createdAt)}</p>
        </div>
        {needsConfirmation && (
          <ConfirmAmountField
            value={confirmText}
            onChange={setConfirmText}
            error={errors.confirm}
          />
        )}
        <Field invalid={!!errors.reason}>
          <FieldLabel>{t('reconciliation.movement.reason')}</FieldLabel>
          <Textarea name="reason" rows={2} maxLength={500} autoFocus />
          <FieldError match={!!errors.reason}>{errors.reason}</FieldError>
        </Field>
        {failure && <FormAlert>{failure}</FormAlert>}
        <InvalidAlert show={Object.values(errors).some(Boolean)} />
        <DialogFooter>
          <Button type="submit" variant="destructive" disabled={reverse.isPending}>
            {reverse.isPending ? t('reconciliation.saving') : t('reconciliation.reverse.submit')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
