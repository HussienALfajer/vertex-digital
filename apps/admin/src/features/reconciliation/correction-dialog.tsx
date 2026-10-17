import {
  type CreateSupplierCorrection,
  createSupplierCorrectionSchema,
  SUPPLIER_CORRECTION_DIRECTIONS,
  type SupplierCode,
  type SupplierCorrectionDirection,
  supplierPlace,
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
  Input,
  Textarea,
  ToggleGroup,
  ToggleGroupItem,
  useFocusInvalid,
} from '@vertex-digital/ui';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert, InvalidAlert } from '../../components/form-alert';
import { useIdempotentRequest } from '../../lib/idempotency';
import { ConfirmAmountField } from '../wallet/adjustment-form';
import { useCreateCorrection } from './reconciliation.queries';
import { placeLabel } from './reconciliation-labels';
import {
  parsePlaceAmount,
  type TreasuryField,
  type TreasuryFieldErrors,
  treasuryFailure,
  useNeedsConfirmation,
} from './treasury-form';

const FIELDS: readonly TreasuryField[] = ['sent', 'order', 'reference', 'reason', 'confirm'];

const FIELD_OF_PATH: Record<string, 'sent' | 'order' | 'reference' | 'reason'> = {
  amountUnits: 'sent',
  orderNumber: 'order',
  externalReference: 'reference',
  reason: 'reason',
};

/**
 * "تصحيح رصيد المورد" (rule T5): the supplier credited the store (`increase`) or charged it
 * (`decrease`), sub-cent amounts allowed, an optional order number and reference, the reason;
 * above $100 the amount typed twice.
 */
export function CorrectionDialog({
  supplier,
  onDone,
}: {
  supplier: SupplierCode;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const correct = useCreateCorrection();
  const send = useIdempotentRequest();
  const place = supplierPlace(supplier);
  const [direction, setDirection] = useState<SupplierCorrectionDirection>('decrease');
  const [amountText, setAmountText] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [forceConfirm, setForceConfirm] = useState(false);
  const [errors, setErrors] = useState<TreasuryFieldErrors>({});
  const { ref, focusInvalid } = useFocusInvalid();
  const [failure, setFailure] = useState<string | null>(null);
  const amountUnits = parsePlaceAmount(place, amountText);
  const needsConfirmation = useNeedsConfirmation('USD', amountUnits) || forceConfirm;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const data = new FormData(event.currentTarget);
    const text = (name: string) => String(data.get(name) ?? '').trim();
    const body = {
      supplier,
      direction,
      amountUnits: amountUnits ?? Number.NaN,
      orderNumber: text('orderNumber') || undefined,
      externalReference: text('externalReference') || undefined,
      reason: text('reason'),
      amountConfirmationUnits: needsConfirmation
        ? (parsePlaceAmount(place, confirmText) ?? -1)
        : undefined,
    };
    const parsed = createSupplierCorrectionSchema.safeParse(body);
    const found: TreasuryFieldErrors = {};
    for (const issue of parsed.error?.issues ?? []) {
      const field = FIELD_OF_PATH[String(issue.path[0])];
      if (field && !found[field]) found[field] = t(`reconciliation.correction.errors.${field}`);
    }
    if (needsConfirmation && body.amountConfirmationUnits !== amountUnits) {
      found.confirm = t('wallets.adjust.errors.confirm');
    }
    setErrors(found);
    if (!parsed.success || Object.keys(found).length > 0) return focusInvalid();

    const request: CreateSupplierCorrection = parsed.data;
    try {
      await send(request, (key) => correct.mutateAsync({ body: request, key }));
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
        <DialogTitle>{t('reconciliation.correction.title')}</DialogTitle>
        <DialogDescription>
          {t('reconciliation.correction.description', { place: placeLabel(t, place) })}
        </DialogDescription>
      </DialogHeader>
      <form ref={ref} className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <Field>
          <FieldLabel>{t('reconciliation.correction.direction')}</FieldLabel>
          <ToggleGroup<SupplierCorrectionDirection>
            aria-label={t('reconciliation.correction.direction')}
            value={[direction]}
            onValueChange={(value) => value[0] && setDirection(value[0])}
          >
            {SUPPLIER_CORRECTION_DIRECTIONS.map((item) => (
              <ToggleGroupItem key={item} value={item}>
                {t(`reconciliation.correction.directions.${item}`)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>
        <Field invalid={!!errors.sent}>
          <FieldLabel>{t('reconciliation.correction.amount')}</FieldLabel>
          <Input
            name="amount"
            dir="ltr"
            inputMode="decimal"
            autoComplete="off"
            autoFocus
            value={amountText}
            onChange={(event) => setAmountText(event.target.value)}
          />
          <FieldDescription>{t('reconciliation.correction.amountHint')}</FieldDescription>
          <FieldError match={!!errors.sent}>{errors.sent}</FieldError>
        </Field>
        {needsConfirmation && (
          <ConfirmAmountField
            value={confirmText}
            onChange={setConfirmText}
            error={errors.confirm}
          />
        )}
        <Field invalid={!!errors.order}>
          <FieldLabel>{t('reconciliation.correction.order')}</FieldLabel>
          <Input name="orderNumber" dir="ltr" autoComplete="off" spellCheck={false} />
          <FieldError match={!!errors.order}>{errors.order}</FieldError>
        </Field>
        <Field invalid={!!errors.reference}>
          <FieldLabel>{t('reconciliation.movement.reference')}</FieldLabel>
          <Input
            name="externalReference"
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            maxLength={100}
          />
          <FieldError match={!!errors.reference}>{errors.reference}</FieldError>
        </Field>
        <Field invalid={!!errors.reason}>
          <FieldLabel>{t('reconciliation.movement.reason')}</FieldLabel>
          <Textarea name="reason" rows={2} maxLength={500} />
          <FieldError match={!!errors.reason}>{errors.reason}</FieldError>
        </Field>
        {failure && <FormAlert>{failure}</FormAlert>}
        <InvalidAlert show={Object.values(errors).some(Boolean)} />
        <DialogFooter>
          <Button type="submit" disabled={correct.isPending}>
            {correct.isPending ? t('reconciliation.saving') : t('reconciliation.correction.submit')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
