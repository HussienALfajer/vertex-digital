import {
  ADJUSTMENT_CATEGORIES,
  ADJUSTMENT_CONFIRMATION_THRESHOLD_USD_UNITS,
  ADJUSTMENT_DIRECTIONS,
  type AdjustmentCategory,
  type AdjustmentDirection,
  type AdminWallet,
  type CreateAdjustment,
  createAdjustmentSchema,
  isAllowedAdjustment,
  MANUAL_DEPOSIT_METHODS,
  type ManualDepositMethod,
  parseUsd,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  ToggleGroup,
  ToggleGroupItem,
} from '@vertex-digital/ui';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { useIdempotencyKey } from '../../lib/idempotency';
import {
  type AdjustmentField,
  type AdjustmentFieldErrors,
  BalanceLines,
  ConfirmAmountField,
  failureOf,
} from './adjustment-form';
import { useCreateAdjustment } from './wallet.queries';

/** The categories the admin may pick for a direction and this customer (rules J1, J4). */
const categoriesFor = (direction: AdjustmentDirection, isTest: boolean) =>
  ADJUSTMENT_CATEGORIES.filter(
    (category) => isAllowedAdjustment(category, direction) && (category !== 'test_funds' || isTest),
  );

/** The contract's field of a schema issue, as the dialog names its fields. */
const FIELDS: Record<string, AdjustmentField> = {
  amountUnits: 'amount',
  direction: 'category',
  category: 'category',
  depositMethod: 'method',
  externalReference: 'reference',
  reason: 'reason',
  customerNote: 'note',
};

/**
 * "تعديل الرصيد" (rules J1–J10): direction, amount, category, the manual deposit's method and
 * reference, the internal reason and the customer's note, with the balance after; above $100 the
 * amount typed twice. Validated with the API's own schema; re-authentication and retries keep the
 * request's `Idempotency-Key` (edge cases 4–6).
 */
export function AdjustDialog({ wallet, onDone }: { wallet: AdminWallet; onDone: () => void }) {
  const { t } = useTranslation();
  const adjust = useCreateAdjustment(wallet.customer.id);
  const keyFor = useIdempotencyKey();
  const [direction, setDirection] = useState<AdjustmentDirection>('credit');
  const [category, setCategory] = useState<AdjustmentCategory | null>(null);
  const [method, setMethod] = useState<ManualDepositMethod | null>(null);
  const [amountText, setAmountText] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [errors, setErrors] = useState<AdjustmentFieldErrors>({});
  const [failure, setFailure] = useState<string | null>(null);

  const categories = categoriesFor(direction, wallet.customer.isTest);
  const amountUnits = parseUsd(amountText);
  const needsConfirmation =
    amountUnits !== null && amountUnits > ADJUSTMENT_CONFIRMATION_THRESHOLD_USD_UNITS;
  const signed = amountUnits === null ? null : direction === 'credit' ? amountUnits : -amountUnits;

  function changeDirection(next: AdjustmentDirection) {
    setDirection(next);
    // A category the new direction does not allow is cleared (rule J1).
    if (category && !isAllowedAdjustment(category, next)) setCategory(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const data = new FormData(event.currentTarget);
    const text = (name: string) => String(data.get(name) ?? '').trim();
    const note = text('customerNote');
    const manual = category === 'manual_deposit';
    const body = {
      direction,
      amountUnits: amountUnits ?? Number.NaN,
      amountConfirmationUnits: needsConfirmation ? (parseUsd(confirmText) ?? -1) : undefined,
      category,
      reason: text('reason'),
      customerNote: note || undefined,
      depositMethod: manual ? (method ?? undefined) : undefined,
      externalReference: manual ? text('externalReference') || undefined : undefined,
    };
    const parsed = createAdjustmentSchema.safeParse(body);
    const found: AdjustmentFieldErrors = {};
    for (const issue of parsed.error?.issues ?? []) {
      const field = FIELDS[String(issue.path[0])];
      if (field) found[field] = t(`wallets.adjust.errors.${field}`);
    }
    if (needsConfirmation && body.amountConfirmationUnits !== amountUnits) {
      found.confirm = t('wallets.adjust.errors.confirm');
    }
    setErrors(found);
    if (!parsed.success || found.confirm) return;

    const request: CreateAdjustment = parsed.data;
    try {
      await adjust.mutateAsync({ body: request, key: keyFor(request) });
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
        <DialogTitle>{t('wallets.adjust.title')}</DialogTitle>
        <DialogDescription>{t('wallets.adjust.description')}</DialogDescription>
      </DialogHeader>
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <Field>
          <FieldLabel>{t('wallets.adjust.direction')}</FieldLabel>
          <ToggleGroup<AdjustmentDirection>
            aria-label={t('wallets.adjust.direction')}
            value={[direction]}
            onValueChange={(value) => value[0] && changeDirection(value[0])}
          >
            {ADJUSTMENT_DIRECTIONS.map((item) => (
              <ToggleGroupItem key={item} value={item}>
                {t(`wallets.directions.${item}`)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>
        <Field invalid={!!errors.amount}>
          <FieldLabel>{t('wallets.adjust.amount')}</FieldLabel>
          <Input
            name="amount"
            dir="ltr"
            inputMode="decimal"
            autoComplete="off"
            autoFocus
            value={amountText}
            onChange={(event) => setAmountText(event.target.value)}
          />
          <FieldDescription>{t('wallets.adjust.amountHint')}</FieldDescription>
          <FieldError match={!!errors.amount}>{errors.amount}</FieldError>
        </Field>
        {needsConfirmation && (
          <ConfirmAmountField
            value={confirmText}
            onChange={setConfirmText}
            error={errors.confirm}
          />
        )}
        <Field invalid={!!errors.category}>
          <FieldLabel>{t('wallets.adjust.category')}</FieldLabel>
          <Select
            items={categories.map((item) => ({
              value: item,
              label: t(`wallets.categories.${item}`),
            }))}
            value={category}
            onValueChange={(value) => setCategory(value)}
          >
            <SelectTrigger aria-label={t('wallets.adjust.category')}>
              <SelectValue placeholder={t('wallets.adjust.chooseCategory')} />
            </SelectTrigger>
            <SelectContent>
              {categories.map((item) => (
                <SelectItem key={item} value={item}>
                  {t(`wallets.categories.${item}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldError match={!!errors.category}>{errors.category}</FieldError>
        </Field>
        {category === 'manual_deposit' && (
          <>
            <Field invalid={!!errors.method}>
              <FieldLabel>{t('wallets.adjust.method')}</FieldLabel>
              <Select
                items={MANUAL_DEPOSIT_METHODS.map((item) => ({
                  value: item,
                  label: t(`wallets.methods.${item}`),
                }))}
                value={method}
                onValueChange={(value) => setMethod(value)}
              >
                <SelectTrigger aria-label={t('wallets.adjust.method')}>
                  <SelectValue placeholder={t('wallets.adjust.chooseMethod')} />
                </SelectTrigger>
                <SelectContent>
                  {MANUAL_DEPOSIT_METHODS.map((item) => (
                    <SelectItem key={item} value={item}>
                      {t(`wallets.methods.${item}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError match={!!errors.method}>{errors.method}</FieldError>
            </Field>
            <Field invalid={!!errors.reference}>
              <FieldLabel>{t('wallets.adjust.reference')}</FieldLabel>
              <Input
                name="externalReference"
                dir="ltr"
                autoComplete="off"
                spellCheck={false}
                maxLength={100}
              />
              <FieldError match={!!errors.reference}>{errors.reference}</FieldError>
            </Field>
          </>
        )}
        <Field invalid={!!errors.reason}>
          <FieldLabel>{t('wallets.adjust.reason')}</FieldLabel>
          <Textarea name="reason" rows={2} maxLength={500} />
          <FieldDescription>{t('wallets.adjust.reasonHint')}</FieldDescription>
          <FieldError match={!!errors.reason}>{errors.reason}</FieldError>
        </Field>
        <Field invalid={!!errors.note}>
          <FieldLabel>{t('wallets.adjust.note')}</FieldLabel>
          <Textarea name="customerNote" rows={2} maxLength={200} />
          <FieldDescription>{t('wallets.adjust.noteHint')}</FieldDescription>
          <FieldError match={!!errors.note}>{errors.note}</FieldError>
        </Field>
        <BalanceLines balanceUnits={wallet.balanceUnits} signedUnits={signed} />
        {failure && <FormAlert>{failure}</FormAlert>}
        <DialogFooter>
          <Button type="submit" disabled={adjust.isPending}>
            {adjust.isPending ? t('wallets.adjust.submitting') : t('wallets.adjust.submit')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
