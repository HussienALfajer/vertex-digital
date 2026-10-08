import { useQuery } from '@tanstack/react-query';
import {
  type Currency,
  type DepositSettings,
  type DepositSettingsInput,
  depositSettingsInputSchema,
  formatAmountInput,
  parseUsd,
  type UsdtMethod,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardDescription,
  CardTitle,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  PageHeader,
  Skeleton,
  Switch,
} from '@vertex-digital/ui';
import { InfoIcon, UploadIcon } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import {
  depositCountsQuery,
  depositSettingsQuery,
  qrUrl,
  useSaveDepositSettings,
  useUploadQr,
} from './deposits.queries';

/** The limits and the threshold typed in dollars. */
const USD_FIELDS = [
  'minDepositUsdUnits',
  'newAccountPerDepositUsdUnits',
  'newAccountDailyUsdUnits',
  'establishedPerDepositUsdUnits',
  'establishedDailyUsdUnits',
  'flagNewAccountUsdUnits',
  'usdtMinDepositUsdUnits',
] as const;

type UsdField = (typeof USD_FIELDS)[number];

type Texts = Record<UsdField, string> & {
  shamCashAccountName: string;
  shamCashAccountNumber: string;
  reviewHoursStart: string;
  reviewHoursEnd: string;
  reviewTargetMinutes: string;
  flagVelocityCount: string;
};

type FieldName = keyof Texts | 'sypQrFileId' | 'usdQrFileId';

function textsOf(settings: DepositSettings): Texts {
  const usd = Object.fromEntries(
    USD_FIELDS.map((field) => [field, formatAmountInput('USD', settings[field])]),
  ) as Record<UsdField, string>;
  return {
    ...usd,
    shamCashAccountName: settings.shamCashAccountName,
    shamCashAccountNumber: settings.shamCashAccountNumber,
    reviewHoursStart: settings.reviewHoursStart,
    reviewHoursEnd: settings.reviewHoursEnd,
    reviewTargetMinutes: String(settings.reviewTargetMinutes),
    flagVelocityCount: String(settings.flagVelocityCount),
  };
}

const whole = (text: string) => (/^\d{1,4}$/.test(text.trim()) ? Number(text) : Number.NaN);

/**
 * "إعدادات الإيداع" (S03, S04): the Sham Cash account, the currencies with their QR images, the
 * USDT networks and minimum (rules U1, U5), the limits (rule SC3), the review hours and target
 * (SC13) and the flag thresholds (FL3, FL4). Saved as a new
 * version with re-authentication; before the first save Sham Cash deposits are unavailable (SC1).
 */
export function DepositSettingsPage() {
  const { t } = useTranslation();
  const settings = useQuery(depositSettingsQuery);
  return (
    <>
      <PageHeader title={t('depositSettings.title')} description={t('depositSettings.subtitle')} />
      {settings.isPending && (
        <div className="flex flex-col gap-4" aria-hidden="true">
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} className="h-40 w-full" />
          ))}
        </div>
      )}
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

function SettingsForm({ settings }: { settings: DepositSettings }) {
  const { t } = useTranslation();
  const save = useSaveDepositSettings();
  const counts = useQuery(depositCountsQuery);
  const [texts, setTexts] = useState(() => textsOf(settings));
  const [enabled, setEnabled] = useState({ SYP: settings.sypEnabled, USD: settings.usdEnabled });
  const [qr, setQr] = useState({ SYP: settings.sypQrFileId, USD: settings.usdQrFileId });
  const [usdtEnabled, setUsdtEnabled] = useState<Record<UsdtMethod, boolean>>({
    usdt_trc20: settings.usdtTrc20Enabled,
    usdt_bep20: settings.usdtBep20Enabled,
  });
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const text = (name: keyof Texts) => ({
    name,
    value: texts[name],
    onChange: (event: { target: { value: string } }) => {
      setTexts((previous) => ({ ...previous, [name]: event.target.value }));
      setSaved(false);
    },
  });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    setSaved(false);
    const body: DepositSettingsInput = {
      shamCashAccountName: texts.shamCashAccountName,
      shamCashAccountNumber: texts.shamCashAccountNumber,
      sypEnabled: enabled.SYP,
      usdEnabled: enabled.USD,
      sypQrFileId: qr.SYP,
      usdQrFileId: qr.USD,
      minDepositUsdUnits: parseUsd(texts.minDepositUsdUnits) ?? Number.NaN,
      newAccountPerDepositUsdUnits: parseUsd(texts.newAccountPerDepositUsdUnits) ?? Number.NaN,
      newAccountDailyUsdUnits: parseUsd(texts.newAccountDailyUsdUnits) ?? Number.NaN,
      establishedPerDepositUsdUnits: parseUsd(texts.establishedPerDepositUsdUnits) ?? Number.NaN,
      establishedDailyUsdUnits: parseUsd(texts.establishedDailyUsdUnits) ?? Number.NaN,
      usdtTrc20Enabled: usdtEnabled.usdt_trc20,
      usdtBep20Enabled: usdtEnabled.usdt_bep20,
      usdtMinDepositUsdUnits: parseUsd(texts.usdtMinDepositUsdUnits) ?? Number.NaN,
      reviewHoursStart: texts.reviewHoursStart,
      reviewHoursEnd: texts.reviewHoursEnd,
      reviewTargetMinutes: whole(texts.reviewTargetMinutes),
      flagNewAccountUsdUnits: parseUsd(texts.flagNewAccountUsdUnits) ?? Number.NaN,
      flagVelocityCount: whole(texts.flagVelocityCount),
    };
    const parsed = depositSettingsInputSchema.safeParse(body);
    const found: Partial<Record<FieldName, string>> = {};
    for (const issue of parsed.error?.issues ?? []) {
      const field = String(issue.path[0]) as FieldName;
      found[field] ??= t(`depositSettings.errors.${field}`);
    }
    setErrors(found);
    if (!parsed.success) return;
    try {
      await save.mutateAsync(parsed.data);
      setSaved(true);
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  const open = counts.data ? counts.data.pending + counts.data.submitted : null;
  return (
    <form className="flex flex-col gap-6" onSubmit={submit} noValidate>
      {!settings.saved && (
        <Callout
          tone="info"
          icon={<InfoIcon />}
          title={t('depositSettings.fresh.title')}
          description={t('depositSettings.fresh.body')}
        />
      )}
      <Card className="gap-4">
        <CardTitle>{t('depositSettings.account.title')}</CardTitle>
        <CardDescription>{t('depositSettings.account.description')}</CardDescription>
        <div className="grid gap-4 md:grid-cols-2">
          <TextField label={t('depositSettings.account.name')} error={errors.shamCashAccountName}>
            <Input autoComplete="off" maxLength={100} {...text('shamCashAccountName')} />
          </TextField>
          <TextField
            label={t('depositSettings.account.number')}
            error={errors.shamCashAccountNumber}
          >
            <Input
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              maxLength={64}
              {...text('shamCashAccountNumber')}
            />
          </TextField>
        </div>
      </Card>
      <Card className="gap-4">
        <CardTitle>{t('depositSettings.currencies.title')}</CardTitle>
        {open !== null && open > 0 && (
          <p className="text-sm text-status-warning-foreground">
            {t('depositSettings.currencies.open', { open })}
          </p>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          {(['SYP', 'USD'] as const).map((currency) => (
            <CurrencyCard
              key={currency}
              currency={currency}
              enabled={enabled[currency]}
              fileId={qr[currency]}
              error={errors[currency === 'SYP' ? 'sypQrFileId' : 'usdQrFileId']}
              onEnabled={(value) => {
                setEnabled((previous) => ({ ...previous, [currency]: value }));
                setSaved(false);
              }}
              onFile={(fileId) => {
                setQr((previous) => ({ ...previous, [currency]: fileId }));
                setSaved(false);
              }}
            />
          ))}
        </div>
      </Card>
      <Card className="gap-4">
        <CardTitle>{t('depositSettings.usdt.title')}</CardTitle>
        <CardDescription>{t('depositSettings.usdt.description')}</CardDescription>
        <div className="grid gap-4 md:grid-cols-2">
          {settings.usdt.map((network) => (
            <UsdtNetworkCard
              key={network.method}
              network={network}
              enabled={usdtEnabled[network.method]}
              onEnabled={(value) => {
                setUsdtEnabled((previous) => ({ ...previous, [network.method]: value }));
                setSaved(false);
              }}
            />
          ))}
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <TextField
            label={t('depositSettings.fields.usdtMinDepositUsdUnits')}
            error={errors.usdtMinDepositUsdUnits}
            hint={t('depositSettings.usdt.minimumHint')}
          >
            <Input
              dir="ltr"
              inputMode="decimal"
              autoComplete="off"
              {...text('usdtMinDepositUsdUnits')}
            />
          </TextField>
        </div>
      </Card>
      <Card className="gap-4">
        <CardTitle>{t('depositSettings.limits.title')}</CardTitle>
        <CardDescription>{t('depositSettings.limits.description')}</CardDescription>
        <div className="grid gap-4 md:grid-cols-2">
          {USD_FIELDS.filter(
            (field) => field !== 'flagNewAccountUsdUnits' && field !== 'usdtMinDepositUsdUnits',
          ).map((field) => (
            <TextField
              key={field}
              label={t(`depositSettings.fields.${field}`)}
              error={errors[field]}
            >
              <Input dir="ltr" inputMode="decimal" autoComplete="off" {...text(field)} />
            </TextField>
          ))}
        </div>
      </Card>
      <Card className="gap-4">
        <CardTitle>{t('depositSettings.review.title')}</CardTitle>
        <CardDescription>{t('depositSettings.review.description')}</CardDescription>
        <div className="grid gap-4 md:grid-cols-3">
          <TextField
            label={t('depositSettings.fields.reviewHoursStart')}
            error={errors.reviewHoursStart}
          >
            <Input type="time" dir="ltr" {...text('reviewHoursStart')} />
          </TextField>
          <TextField
            label={t('depositSettings.fields.reviewHoursEnd')}
            error={errors.reviewHoursEnd}
          >
            <Input type="time" dir="ltr" {...text('reviewHoursEnd')} />
          </TextField>
          <TextField
            label={t('depositSettings.fields.reviewTargetMinutes')}
            error={errors.reviewTargetMinutes}
          >
            <Input
              dir="ltr"
              inputMode="numeric"
              autoComplete="off"
              {...text('reviewTargetMinutes')}
            />
          </TextField>
        </div>
      </Card>
      <Card className="gap-4">
        <CardTitle>{t('depositSettings.flags.title')}</CardTitle>
        <div className="grid gap-4 md:grid-cols-2">
          <TextField
            label={t('depositSettings.fields.flagNewAccountUsdUnits')}
            error={errors.flagNewAccountUsdUnits}
            hint={t('depositSettings.flags.newAccountHint')}
          >
            <Input
              dir="ltr"
              inputMode="decimal"
              autoComplete="off"
              {...text('flagNewAccountUsdUnits')}
            />
          </TextField>
          <TextField
            label={t('depositSettings.fields.flagVelocityCount')}
            error={errors.flagVelocityCount}
            hint={t('depositSettings.flags.velocityHint')}
          >
            <Input
              dir="ltr"
              inputMode="numeric"
              autoComplete="off"
              {...text('flagVelocityCount')}
            />
          </TextField>
        </div>
      </Card>
      {failure && <FormAlert>{failure}</FormAlert>}
      {saved && (
        <p role="status" className="text-sm font-medium text-status-success-foreground">
          {t('depositSettings.saved')}
        </p>
      )}
      <Button type="submit" className="self-start" disabled={save.isPending}>
        {save.isPending ? t('depositSettings.saving') : t('depositSettings.save')}
      </Button>
    </form>
  );
}

function TextField({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <Field invalid={!!error}>
      <FieldLabel>{label}</FieldLabel>
      {children}
      {hint && <FieldDescription>{hint}</FieldDescription>}
      <FieldError match={!!error}>{error}</FieldError>
    </Field>
  );
}

/** A currency's switch and its QR image: uploaded, re-encoded by the API, previewed here. */
function CurrencyCard({
  currency,
  enabled,
  fileId,
  error,
  onEnabled,
  onFile,
}: {
  currency: Currency;
  enabled: boolean;
  fileId: string | null;
  error?: string;
  onEnabled: (enabled: boolean) => void;
  onFile: (fileId: string) => void;
}) {
  const { t } = useTranslation();
  const upload = useUploadQr();
  const input = useRef<HTMLInputElement>(null);
  const switchId = useId();
  const [failure, setFailure] = useState<string | null>(null);

  async function choose(file: File | undefined) {
    if (!file) return;
    setFailure(null);
    try {
      const stored = await upload.mutateAsync(file);
      onFile(stored.fileId);
    } catch (uploadError) {
      setFailure(errorMessage(t, uploadError));
    } finally {
      if (input.current) input.current.value = '';
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={switchId} className="text-base font-medium">
          {t(`depositSettings.currencies.${currency}`)}
        </label>
        <Switch id={switchId} checked={enabled} onCheckedChange={onEnabled} />
      </div>
      <div className="flex min-h-40 items-center justify-center rounded-md border border-dashed border-border bg-muted p-2">
        {fileId ? (
          <img
            src={qrUrl(fileId)}
            alt={t('depositSettings.currencies.qrAlt', {
              currency: t(`depositSettings.currencies.${currency}`),
            })}
            className="max-h-48 object-contain"
          />
        ) : (
          <p className="text-sm text-muted-foreground">{t('depositSettings.currencies.noQr')}</p>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => void choose(event.target.files?.[0])}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        disabled={upload.isPending}
        onClick={() => input.current?.click()}
      >
        <UploadIcon />
        {upload.isPending
          ? t('depositSettings.currencies.uploading')
          : fileId
            ? t('depositSettings.currencies.replace')
            : t('depositSettings.currencies.upload')}
      </Button>
      {(error || failure) && (
        <p role="alert" className="text-sm text-destructive-text">
          {failure ?? error}
        </p>
      )}
    </div>
  );
}

/**
 * A USDT network (S04 rule U1): the address from the server environment, read-only; the switch,
 * which needs that address; the last successful scan and whether verification is delayed.
 */
function UsdtNetworkCard({
  network,
  enabled,
  onEnabled,
}: {
  network: DepositSettings['usdt'][number];
  enabled: boolean;
  onEnabled: (enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const switchId = useId();
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={switchId} className="text-base font-medium">
          {t(`wallets.methods.${network.method}`)}
        </label>
        <Switch
          id={switchId}
          checked={enabled}
          disabled={!network.address && !enabled}
          onCheckedChange={onEnabled}
        />
      </div>
      <div className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">{t('depositSettings.usdt.address')}</span>
        {network.address ? (
          <code dir="ltr" className="text-end break-all">
            {network.address}
          </code>
        ) : (
          <span className="font-medium text-status-warning-foreground">
            {t('depositSettings.usdt.noAddress')}
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          {t('depositSettings.usdt.serverOnly')}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">{t('depositSettings.usdt.lastScan')}</span>
        <span className="font-medium">
          {network.lastScanAt
            ? formatDateTime(network.lastScanAt)
            : t('depositSettings.usdt.never')}
        </span>
        {network.delayed && <Badge tone="warning">{t('depositSettings.usdt.delayed')}</Badge>}
      </div>
    </div>
  );
}
