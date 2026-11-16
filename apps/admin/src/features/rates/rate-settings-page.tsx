import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  type RateSettings,
  type RateSettingsValues,
  rateSettingsValuesSchema,
} from '@vertex-digital/contracts';
import {
  Button,
  Card,
  CardTitle,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  PageHeader,
  Skeleton,
  Switch,
  useFocusInvalid,
} from '@vertex-digital/ui';
import { ArrowRightIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert, InvalidAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import { rateSettingsQuery, useChangeRateSettings } from './rates.queries';

/** The thresholds of ST2, in the order the page shows them. */
const NUMBERS = [
  'autoMaxMoveBps',
  'agreementMaxSpreadBps',
  'minAgreeingSources',
  'driftWindowHours',
  'driftMaxBps',
  'minMoveBps',
  'freshnessMinutes',
  'silentAlertHours',
  'telegramApproveMaxBps',
  'pollMinutes',
] as const satisfies readonly (keyof RateSettingsValues)[];

type NumberField = (typeof NUMBERS)[number];

/** Basis points are shown and typed as percent (200 bp = 2%). */
const isBps = (field: NumberField) => field.endsWith('Bps');

function toText(field: NumberField, value: number): string {
  return isBps(field) ? String(value / 100) : String(value);
}

/** The typed text as the setting's integer, or NaN (percent with up to 2 decimals for bp). */
function fromText(field: NumberField, text: string): number {
  const trimmed = text.trim();
  if (isBps(field)) {
    const match = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(trimmed);
    return match ? Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0')) : Number.NaN;
  }
  return /^\d{1,4}$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/** S27 "/rates/settings": the automatic switch and the thresholds of ST2, re-authenticated. */
export function RateSettingsPage() {
  const { t } = useTranslation();
  const settings = useQuery(rateSettingsQuery);
  return (
    <>
      <PageHeader
        title={t('rates.settings.title')}
        description={t('rates.settings.subtitle')}
        actions={
          <Button variant="ghost" render={<Link to="/rates" />}>
            <ArrowRightIcon className="ltr:-scale-x-100" aria-hidden="true" />
            {t('rates.sourceForm.back')}
          </Button>
        }
      />
      {settings.isPending && <Skeleton className="h-96 w-full" aria-hidden="true" />}
      {settings.isError && (
        <div className="flex flex-col items-start gap-3">
          <FormAlert>{errorMessage(t, settings.error)}</FormAlert>
          <Button variant="outline" onClick={() => settings.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {settings.isSuccess && <SettingsForm settings={settings.data} />}
    </>
  );
}

function SettingsForm({ settings }: { settings: RateSettings }) {
  const { t } = useTranslation();
  const change = useChangeRateSettings();
  const [autoEnabled, setAutoEnabled] = useState(settings.autoEnabled);
  const [texts, setTexts] = useState<Record<NumberField, string>>(
    () =>
      Object.fromEntries(NUMBERS.map((field) => [field, toText(field, settings[field])])) as Record<
        NumberField,
        string
      >,
  );
  const [errors, setErrors] = useState<Partial<Record<NumberField, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const { ref, focusInvalid } = useFocusInvalid();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    setSaved(false);
    const body = {
      autoEnabled,
      ...Object.fromEntries(NUMBERS.map((field) => [field, fromText(field, texts[field])])),
    };
    const parsed = rateSettingsValuesSchema.safeParse(body);
    const found: Partial<Record<NumberField, string>> = {};
    for (const issue of parsed.error?.issues ?? []) {
      const field = issue.path[0] as NumberField;
      found[field] = t(`rates.settings.fields.${field}.error`);
    }
    setErrors(found);
    if (!parsed.success) return focusInvalid();
    try {
      await change.mutateAsync(parsed.data);
      setSaved(true);
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <form ref={ref} className="flex flex-col gap-6" onSubmit={submit} noValidate>
      <Card className="gap-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="auto-enabled" className="text-base font-medium">
              {t('rates.settings.autoEnabled')}
            </label>
            <p className="text-sm text-muted-foreground">{t('rates.settings.autoEnabledHelp')}</p>
          </div>
          <Switch
            id="auto-enabled"
            checked={autoEnabled}
            onCheckedChange={(checked) => {
              setAutoEnabled(checked);
              setSaved(false);
            }}
            className="mt-1"
          />
        </div>
        {settings.createdAt && (
          <p className="text-sm text-muted-foreground">
            {t('rates.settings.savedBy', {
              time: formatDateTime(settings.createdAt),
              admin: settings.adminName ?? t('common.unknown'),
            })}
          </p>
        )}
      </Card>
      <Card className="gap-5">
        <CardTitle>{t('rates.settings.thresholds')}</CardTitle>
        <div className="grid gap-5 sm:grid-cols-2">
          {NUMBERS.map((field) => (
            <Field key={field} invalid={!!errors[field]}>
              <FieldLabel>{t(`rates.settings.fields.${field}.label`)}</FieldLabel>
              <Input
                name={field}
                dir="ltr"
                inputMode={isBps(field) ? 'decimal' : 'numeric'}
                autoComplete="off"
                value={texts[field]}
                onChange={(event) => {
                  setTexts((previous) => ({ ...previous, [field]: event.target.value }));
                  setSaved(false);
                }}
              />
              <FieldDescription>{t(`rates.settings.fields.${field}.help`)}</FieldDescription>
              <FieldError match={!!errors[field]}>{errors[field]}</FieldError>
            </Field>
          ))}
        </div>
      </Card>
      {failure && <FormAlert>{failure}</FormAlert>}
      <InvalidAlert show={Object.values(errors).some(Boolean)} />
      {saved && (
        <p role="status" className="text-sm font-medium text-status-success-foreground">
          {t('rates.settings.saved')}
        </p>
      )}
      <Button type="submit" className="self-start" disabled={change.isPending}>
        {change.isPending ? t('rates.form.submitting') : t('rates.settings.save')}
      </Button>
    </form>
  );
}
