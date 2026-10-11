import {
  type AdminCustomer,
  type ArchiveBlocker,
  customerStateChangeSchema,
  formatUsd,
  updateCustomerLimitsSchema,
} from '@vertex-digital/contracts';
import {
  Button,
  Callout,
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
} from '@vertex-digital/ui';
import { InfoIcon, TriangleAlertIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { ApiError } from '../../lib/api/client';
import { errorMessage } from '../../lib/errors';
import { ltr } from '../../lib/format';
import { LIMIT_SOURCE_KEYS, limitInput, parseLimitInput } from './customer-labels';
import {
  type CustomerStateAction,
  useCustomerStateChange,
  useUpdateCustomerLimits,
} from './customers.queries';

/** The blockers of a refused archive (rule AR1), or null for any other failure. */
function archiveBlockers(error: unknown): ArchiveBlocker[] | null {
  if (!(error instanceof ApiError) || error.code !== 'CUSTOMER_NOT_ARCHIVABLE') return null;
  const blockers = (error.details as { blockers?: ArchiveBlocker[] } | undefined)?.blockers;
  return blockers ?? [];
}

/**
 * Freeze, unfreeze, archive, unarchive or sign out everywhere (CF1, CF6, AR1, AR3, SN1): a reason
 * of 5 to 500 characters and re-authentication. Freezing says how many reservations it cancels;
 * a refused archive lists its blockers. The reason stays on an error.
 */
export function StateChangeDialog({
  customer,
  action,
  onDone,
}: {
  customer: AdminCustomer;
  action: CustomerStateAction;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const change = useCustomerStateChange(customer.id);
  const [invalid, setInvalid] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const blockers = archiveBlockers(failure);
  const destructive = action === 'freeze' || action === 'archive' || action === 'revoke';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const parsed = customerStateChangeSchema.safeParse({
      reason: String(new FormData(event.currentTarget).get('reason') ?? ''),
    });
    setInvalid(!parsed.success);
    if (!parsed.success) return;
    try {
      await change.mutateAsync({ action, body: parsed.data });
      onDone();
    } catch (error) {
      setFailure(error);
    }
  }

  return (
    <DialogContent closeLabel={t('common.close')}>
      <DialogHeader>
        <DialogTitle>{t(`customers.dialogs.${action}.title`, { name: customer.name })}</DialogTitle>
        <DialogDescription>
          {t(`customers.dialogs.${action}.description`, {
            count: customer.counts.activeSessions,
          })}
        </DialogDescription>
      </DialogHeader>
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        {action === 'freeze' && (
          <Callout
            tone={customer.counts.reservations > 0 ? 'warning' : 'neutral'}
            icon={<InfoIcon />}
            title={
              customer.counts.reservations > 0
                ? t('customers.dialogs.freeze.reservations', {
                    count: customer.counts.reservations,
                  })
                : t('customers.dialogs.freeze.noReservations')
            }
          />
        )}
        <Field invalid={invalid}>
          <FieldLabel>{t('customers.dialogs.reason')}</FieldLabel>
          <Textarea name="reason" rows={3} maxLength={500} autoFocus />
          <FieldDescription>{t('customers.dialogs.reasonHint')}</FieldDescription>
          <FieldError match={invalid}>{t('customers.dialogs.reasonError')}</FieldError>
        </Field>
        {blockers ? (
          <div
            role="alert"
            className="flex flex-col gap-2 rounded-lg bg-status-danger px-4 py-3 text-status-danger-foreground"
          >
            <p className="flex items-center gap-2 font-medium">
              <TriangleAlertIcon className="size-5 shrink-0" aria-hidden="true" />
              {t('customers.dialogs.archive.blockers')}
            </p>
            <ul className="flex list-disc flex-col gap-1 ps-9 text-sm">
              {blockers.map((blocker) => (
                <li key={blocker}>
                  {t(`customers.blockers.${blocker}`, {
                    balance: ltr(formatUsd(customer.balanceUnits)),
                  })}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          failure !== null && <FormAlert>{errorMessage(t, failure)}</FormAlert>
        )}
        <DialogFooter>
          <Button
            type="submit"
            variant={destructive ? 'destructive' : 'primary'}
            disabled={change.isPending}
          >
            {change.isPending
              ? t('customers.dialogs.submitting')
              : t(`customers.dialogs.${action}.submit`)}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

const LIMIT_FIELDS = [
  'perDepositUsdUnits',
  'dailyDepositUsdUnits',
  'dailyPurchaseUsdUnits',
] as const;

type LimitField = (typeof LIMIT_FIELDS)[number];

const LIMIT_LABELS = {
  perDepositUsdUnits: 'customers.limits.perDeposit',
  dailyDepositUsdUnits: 'customers.limits.dailyDeposit',
  dailyPurchaseUsdUnits: 'customers.limits.dailyPurchase',
} as const satisfies Record<LimitField, string>;

const EFFECTIVE_OF = {
  perDepositUsdUnits: 'perDeposit',
  dailyDepositUsdUnits: 'dailyDeposit',
  dailyPurchaseUsdUnits: 'dailyPurchase',
} as const satisfies Record<LimitField, string>;

/**
 * Rule LM5: the three optional overrides typed in dollars (an empty field returns to the default)
 * and a reason, with re-authentication. Amounts go through the contracts' money helpers: whole
 * cents, USD units, never floats. The values stay on an error.
 */
export function LimitsDialog({
  customer,
  onDone,
}: {
  customer: AdminCustomer;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const update = useUpdateCustomerLimits(customer.id);
  const [errors, setErrors] = useState<Partial<Record<LimitField | 'reason' | 'below', boolean>>>(
    {},
  );
  const [failure, setFailure] = useState<string | null>(null);
  const { limits } = customer;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const form = new FormData(event.currentTarget);
    const values = Object.fromEntries(
      LIMIT_FIELDS.map((field) => [field, parseLimitInput(String(form.get(field) ?? ''))]),
    ) as Record<LimitField, number | null | undefined>;
    const body = { ...values, reason: String(form.get('reason') ?? '') };
    const parsed = updateCustomerLimitsSchema.safeParse(body);
    const paths = new Set((parsed.error?.issues ?? []).map((issue) => issue.path[0]));
    const below =
      typeof values.perDepositUsdUnits === 'number' &&
      typeof values.dailyDepositUsdUnits === 'number' &&
      values.perDepositUsdUnits > values.dailyDepositUsdUnits;
    const next = {
      perDepositUsdUnits:
        values.perDepositUsdUnits === undefined || paths.has('perDepositUsdUnits'),
      dailyDepositUsdUnits:
        values.dailyDepositUsdUnits === undefined || (paths.has('dailyDepositUsdUnits') && !below),
      dailyPurchaseUsdUnits:
        values.dailyPurchaseUsdUnits === undefined || paths.has('dailyPurchaseUsdUnits'),
      reason: paths.has('reason'),
      below,
    };
    setErrors(next);
    if (!parsed.success) return;
    try {
      await update.mutateAsync(parsed.data);
      onDone();
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <DialogContent closeLabel={t('common.close')} className="max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{t('customers.limits.dialogTitle', { name: customer.name })}</DialogTitle>
        <DialogDescription>{t('customers.limits.dialogDescription')}</DialogDescription>
      </DialogHeader>
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        {LIMIT_FIELDS.map((field) => {
          const effective = limits.effective[EFFECTIVE_OF[field]];
          const wrong = !!errors[field] || (field === 'dailyDepositUsdUnits' && !!errors.below);
          return (
            <Field key={field} invalid={wrong}>
              <FieldLabel>{t(LIMIT_LABELS[field])}</FieldLabel>
              <Input
                name={field}
                dir="ltr"
                inputMode="decimal"
                autoComplete="off"
                placeholder={t('customers.limits.placeholder')}
                defaultValue={limitInput(limits[field])}
              />
              <FieldDescription>
                {t('customers.limits.current', {
                  value:
                    effective.units === null
                      ? t('customers.limits.noCap')
                      : ltr(formatUsd(effective.units)),
                  source: t(LIMIT_SOURCE_KEYS[effective.source]),
                })}
              </FieldDescription>
              <FieldError match={wrong}>
                {errors.below && field === 'dailyDepositUsdUnits' && !errors[field]
                  ? t('customers.limits.dailyBelow')
                  : t('customers.limits.fieldError')}
              </FieldError>
            </Field>
          );
        })}
        <Field invalid={!!errors.reason}>
          <FieldLabel>{t('customers.dialogs.reason')}</FieldLabel>
          <Textarea name="reason" rows={3} maxLength={500} />
          <FieldDescription>{t('customers.dialogs.reasonHint')}</FieldDescription>
          <FieldError match={!!errors.reason}>{t('customers.dialogs.reasonError')}</FieldError>
        </Field>
        {failure && <FormAlert>{failure}</FormAlert>}
        <DialogFooter>
          <Button type="submit" disabled={update.isPending}>
            {update.isPending ? t('customers.dialogs.submitting') : t('customers.limits.submit')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
