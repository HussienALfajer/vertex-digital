import { useQuery } from '@tanstack/react-query';
import {
  formatUsd,
  type MerchantSettings,
  type MerchantSettingsInput,
  merchantSettingsInputSchema,
} from '@vertex-digital/contracts';
import {
  Button,
  Card,
  EmptyState,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  PageHeader,
  Skeleton,
  useFocusInvalid,
} from '@vertex-digital/ui';
import { CircleAlertIcon, CircleCheckIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert, InvalidAlert } from '../../components/form-alert';
import { ApiError } from '../../lib/api/client';
import { errorMessage } from '../../lib/errors';
import { ltr } from '../../lib/format';
import { limitInput, parseLimitInput } from '../customers/customer-labels';
import { merchantSettingsQuery, useSaveMerchantSettings } from './merchants.queries';

type SettingsField = keyof MerchantSettingsInput;

const FIELDS: { name: SettingsField; money: boolean }[] = [
  { name: 'perDepositUsdUnits', money: true },
  { name: 'dailyDepositUsdUnits', money: true },
  { name: 'ordersPerTenMinutes', money: false },
  { name: 'reapplyWaitDays', money: false },
  { name: 'infoExpiryDays', money: false },
  // S21 BK4: a merchant's player checks.
  { name: 'playerChecksPerHour', money: false },
  { name: 'playerChecksPerDay', money: false },
];

/**
 * "إعدادات التجّار" (S20 MD1, PO5, MA1, MA4): the merchant tier's deposit limits, the order rate,
 * the reapply wait and the information expiry, and (S21 BK4) the player-check quota, with their
 * bounds; saving asks for
 * re-authentication and keeps the earlier version in the audit log.
 */
export function MerchantSettingsPage() {
  const { t } = useTranslation();
  const settings = useQuery(merchantSettingsQuery);
  return (
    <>
      <PageHeader
        title={t('merchants.settings.title')}
        description={t('merchants.settings.subtitle')}
      />
      {settings.isPending && <Skeleton className="h-96 w-full max-w-2xl" aria-hidden="true" />}
      {settings.isError && (
        <EmptyState
          icon={<CircleAlertIcon />}
          title={errorMessage(t, settings.error)}
          action={
            <Button variant="outline" onClick={() => settings.refetch()}>
              {t('common.retry')}
            </Button>
          }
        />
      )}
      {settings.data && <SettingsForm saved={settings.data} />}
    </>
  );
}

function SettingsForm({ saved }: { saved: MerchantSettings }) {
  const { t } = useTranslation();
  const save = useSaveMerchantSettings();
  const [values, setValues] = useState<Record<SettingsField, string>>(() => ({
    perDepositUsdUnits: limitInput(saved.perDepositUsdUnits),
    dailyDepositUsdUnits: limitInput(saved.dailyDepositUsdUnits),
    ordersPerTenMinutes: String(saved.ordersPerTenMinutes),
    reapplyWaitDays: String(saved.reapplyWaitDays),
    infoExpiryDays: String(saved.infoExpiryDays),
    playerChecksPerHour: String(saved.playerChecksPerHour),
    playerChecksPerDay: String(saved.playerChecksPerDay),
  }));
  const [invalid, setInvalid] = useState<Set<SettingsField>>(new Set());
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const { ref, focusInvalid } = useFocusInvalid();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    setDone(false);
    const parsed = merchantSettingsInputSchema.safeParse(
      Object.fromEntries(
        FIELDS.map(({ name, money }) => [
          name,
          money ? parseLimitInput(values[name]) : Number(values[name].trim() || Number.NaN),
        ]),
      ),
    );
    if (!parsed.success) {
      setInvalid(new Set(parsed.error.issues.map((issue) => issue.path[0] as SettingsField)));
      return focusInvalid();
    }
    setInvalid(new Set());
    try {
      await save.mutateAsync(parsed.data);
      setDone(true);
    } catch (error) {
      const fields =
        error instanceof ApiError && Array.isArray(error.details)
          ? (error.details as { path?: unknown[] }[]).map((issue) => issue.path?.[0])
          : [];
      const refused = FIELDS.map(({ name }) => name).filter((name) => fields.includes(name));
      if (refused.length > 0) {
        setInvalid(new Set(refused));
        return focusInvalid();
      }
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <Card className="max-w-2xl">
      <form ref={ref} className="flex flex-col gap-5" onSubmit={submit} noValidate>
        {FIELDS.map(({ name, money }) => (
          <Field key={name} invalid={invalid.has(name)}>
            <FieldLabel>{t(`merchants.settings.fields.${name}`)}</FieldLabel>
            <Input
              name={name}
              dir="ltr"
              inputMode={money ? 'decimal' : 'numeric'}
              value={values[name]}
              onChange={(event) => {
                const value = event.target.value;
                setValues((current) => ({ ...current, [name]: value }));
              }}
            />
            <FieldDescription>
              {t(`merchants.settings.hints.${name}`, {
                minimum: ltr(formatUsd(saved.minDepositUsdUnits)),
              })}
            </FieldDescription>
            <FieldError match={invalid.has(name)}>
              {t(`merchants.settings.errors.${name}`, {
                minimum: ltr(formatUsd(saved.minDepositUsdUnits)),
              })}
            </FieldError>
          </Field>
        ))}
        {failure && <FormAlert>{failure}</FormAlert>}
        {done && (
          <p className="flex items-center gap-2 text-sm text-status-success-foreground">
            <CircleCheckIcon className="size-4" aria-hidden="true" />
            {t('merchants.settings.saved')}
          </p>
        )}
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={save.isPending}>
            {t('merchants.settings.save')}
          </Button>
          <InvalidAlert show={invalid.size > 0} />
        </div>
      </form>
    </Card>
  );
}
