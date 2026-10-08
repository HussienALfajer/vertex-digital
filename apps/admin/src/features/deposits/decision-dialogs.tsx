import {
  type AdminDeposit,
  DEPOSIT_REJECT_REASONS,
  type DepositRejectReason,
  type RejectDeposit,
  type RequestReceipt,
  rejectDepositSchema,
  requestReceiptSchema,
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@vertex-digital/ui';
import type { TFunction } from 'i18next';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { useIdempotencyKey } from '../../lib/idempotency';
import { useRejectDeposit, useRequestReceipt } from './deposits.queries';

type NoteField = 'reason' | 'customerNote' | 'internalNote';

/** The fields of a refused body, by the contract's issue paths. */
function fieldErrors(
  t: TFunction,
  issues: readonly { path: readonly PropertyKey[] }[],
): Partial<Record<NoteField, string>> {
  const found: Partial<Record<NoteField, string>> = {};
  for (const issue of issues) {
    const field = issue.path[0];
    if (field === 'reason') found.reason = t('deposits.reject.errors.reason');
    if (field === 'customerNote') found.customerNote = t('deposits.decision.errors.customerNote');
    if (field === 'internalNote') found.internalNote = t('deposits.decision.errors.internalNote');
  }
  return found;
}

/**
 * "رفض الإيداع" (rule RV6): a reason the customer reads in words, an optional note shown on the
 * deposit page only (required for "other"), and the internal note for the audit entry. No money
 * moves, so no re-authentication; the `Idempotency-Key` makes a retry a replay (RV9).
 */
export function RejectDialog({ deposit, onDone }: { deposit: AdminDeposit; onDone: () => void }) {
  const { t } = useTranslation();
  const reject = useRejectDeposit(deposit.id);
  const keyFor = useIdempotencyKey();
  const [reason, setReason] = useState<DepositRejectReason | null>(null);
  const [errors, setErrors] = useState<Partial<Record<NoteField, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const data = new FormData(event.currentTarget);
    const customerNote = String(data.get('customerNote') ?? '').trim();
    const body: RejectDeposit = {
      reason: reason ?? ('' as DepositRejectReason),
      customerNote: customerNote || undefined,
      internalNote: String(data.get('internalNote') ?? ''),
    };
    const parsed = rejectDepositSchema.safeParse(body);
    setErrors(fieldErrors(t, parsed.error?.issues ?? []));
    if (!parsed.success) return;
    try {
      await reject.mutateAsync({ body: parsed.data, key: keyFor(parsed.data) });
      onDone();
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <DialogContent closeLabel={t('common.close')} className="max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{t('deposits.reject.title')}</DialogTitle>
        <DialogDescription>
          {t('deposits.reject.description', { reference: deposit.referenceCode })}
        </DialogDescription>
      </DialogHeader>
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <Field invalid={!!errors.reason}>
          <FieldLabel>{t('deposits.reject.reason')}</FieldLabel>
          <Select
            items={DEPOSIT_REJECT_REASONS.map((item) => ({
              value: item,
              label: t(`deposits.rejectReasons.${item}`),
            }))}
            value={reason}
            onValueChange={(value) => setReason(value)}
          >
            <SelectTrigger aria-label={t('deposits.reject.reason')}>
              <SelectValue placeholder={t('deposits.reject.chooseReason')} />
            </SelectTrigger>
            <SelectContent>
              {DEPOSIT_REJECT_REASONS.map((item) => (
                <SelectItem key={item} value={item}>
                  {t(`deposits.rejectReasons.${item}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldError match={!!errors.reason}>{errors.reason}</FieldError>
        </Field>
        <NoteFields errors={errors} customerNoteRequired={reason === 'other'} />
        <p className="text-sm text-muted-foreground">{t('deposits.reject.money')}</p>
        {failure && <FormAlert>{failure}</FormAlert>}
        <DialogFooter>
          <Button type="submit" variant="destructive" disabled={reject.isPending}>
            {reject.isPending ? t('deposits.reject.submitting') : t('deposits.reject.submit')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

/**
 * "طلب إيصال أوضح" (rule RV8): once per deposit, back to `pending` with a new 24 hours. Refused
 * while the customer has another deposit waiting for a receipt: the message says to reject.
 */
export function RequestReceiptDialog({
  deposit,
  onDone,
}: {
  deposit: AdminDeposit;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const request = useRequestReceipt(deposit.id);
  const [errors, setErrors] = useState<Partial<Record<NoteField, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const data = new FormData(event.currentTarget);
    const customerNote = String(data.get('customerNote') ?? '').trim();
    const body: RequestReceipt = {
      customerNote: customerNote || undefined,
      internalNote: String(data.get('internalNote') ?? ''),
    };
    const parsed = requestReceiptSchema.safeParse(body);
    setErrors(fieldErrors(t, parsed.error?.issues ?? []));
    if (!parsed.success) return;
    try {
      await request.mutateAsync(parsed.data);
      onDone();
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <DialogContent closeLabel={t('common.close')} className="max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{t('deposits.requestReceipt.title')}</DialogTitle>
        <DialogDescription>{t('deposits.requestReceipt.description')}</DialogDescription>
      </DialogHeader>
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <NoteFields errors={errors} customerNoteRequired={false} />
        {failure && <FormAlert>{failure}</FormAlert>}
        <DialogFooter>
          <Button type="submit" disabled={request.isPending}>
            {request.isPending
              ? t('deposits.requestReceipt.submitting')
              : t('deposits.requestReceipt.submit')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function NoteFields({
  errors,
  customerNoteRequired,
}: {
  errors: Partial<Record<NoteField, string>>;
  customerNoteRequired: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Field invalid={!!errors.customerNote}>
        <FieldLabel>
          {customerNoteRequired
            ? t('deposits.decision.customerNoteRequired')
            : t('deposits.decision.customerNote')}
        </FieldLabel>
        <Textarea name="customerNote" rows={2} maxLength={300} />
        <FieldDescription>{t('deposits.decision.customerNoteHint')}</FieldDescription>
        <FieldError match={!!errors.customerNote}>{errors.customerNote}</FieldError>
      </Field>
      <Field invalid={!!errors.internalNote}>
        <FieldLabel>{t('deposits.decision.internalNote')}</FieldLabel>
        <Textarea name="internalNote" rows={2} maxLength={500} />
        <FieldDescription>{t('deposits.decision.internalNoteHint')}</FieldDescription>
        <FieldError match={!!errors.internalNote}>{errors.internalNote}</FieldError>
      </Field>
    </>
  );
}
