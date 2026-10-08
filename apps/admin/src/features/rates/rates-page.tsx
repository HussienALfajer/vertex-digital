import { useInfiniteQuery } from '@tanstack/react-query';
import {
  type ChangeRate,
  CURRENCY_SCALE,
  changeRateSchema,
  DISPLAY_STEP_MAX_SYP_UNITS,
  DISPLAY_STEP_MIN_SYP_UNITS,
  type ExchangeRateRecord,
  formatRate,
  formatSyp,
  parseWholeSyp,
  RATE_CONFIRMATION_THRESHOLD_PERCENT,
  rateChangePercent,
} from '@vertex-digital/contracts';
import {
  Button,
  Card,
  CardTitle,
  EmptyState,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  PageHeader,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@vertex-digital/ui';
import { ArrowLeftRightIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { ApiError } from '../../lib/api/client';
import { errorMessage } from '../../lib/errors';
import { formatDateTime, ltr } from '../../lib/format';
import { ratesQuery, useChangeRate } from './rates.queries';

/**
 * "سعر الصرف" (S03, F04): the current rate, step and age, the change form with the typed
 * confirmation above 5% (rule FX2) and re-authentication, and the history.
 */
export function RatesPage() {
  const { t } = useTranslation();
  const list = useInfiniteQuery(ratesQuery);
  const current = list.data?.pages[0]?.current ?? null;
  const history = list.data?.pages.flatMap((page) => page.history.items) ?? [];

  return (
    <>
      <PageHeader title={t('rates.title')} description={t('rates.subtitle')} />
      {list.isPending && (
        <div className="flex flex-col gap-4" aria-hidden="true">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      )}
      {list.isError && (
        <div className="flex flex-col items-start gap-3">
          <FormAlert>{errorMessage(t, list.error)}</FormAlert>
          <Button variant="outline" onClick={() => list.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {list.isSuccess && (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <CurrentRate current={current} />
            {/* A new key empties the form once a change is saved. */}
            <ChangeRateForm key={current?.id ?? 'none'} current={current} />
          </div>
          <section className="flex flex-col gap-3" aria-labelledby="rate-history">
            <h2 id="rate-history" className="text-lg font-bold">
              {t('rates.history.title')}
            </h2>
            {history.length === 0 ? (
              <EmptyState icon={<ArrowLeftRightIcon />} title={t('rates.history.empty')} />
            ) : (
              <HistoryTable rates={history} />
            )}
            {list.hasNextPage && (
              <Button
                variant="outline"
                className="self-center"
                disabled={list.isFetchingNextPage}
                onClick={() => list.fetchNextPage()}
              >
                {list.isFetchingNextPage ? t('common.loadingMore') : t('common.loadMore')}
              </Button>
            )}
          </section>
        </>
      )}
    </>
  );
}

function CurrentRate({ current }: { current: ExchangeRateRecord | null }) {
  const { t } = useTranslation();
  if (!current) {
    return (
      <Card className="gap-2">
        <CardTitle>{t('rates.current.title')}</CardTitle>
        <p className="text-base text-muted-foreground">{t('rates.current.none')}</p>
      </Card>
    );
  }
  return (
    <Card className="gap-4">
      <CardTitle>{t('rates.current.title')}</CardTitle>
      <p className="text-3xl font-bold tabular-nums">
        {t('rates.current.value', { rate: formatRate(current.sypPerUsd) })}
      </p>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div className="flex flex-col gap-1">
          <dt className="text-muted-foreground">{t('rates.current.step')}</dt>
          <dd className="font-medium tabular-nums">
            {t('rates.syp', { amount: formatSyp(current.displayStepSypUnits) })}
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-muted-foreground">{t('rates.current.since')}</dt>
          <dd className="font-medium">{formatDateTime(current.createdAt)}</dd>
        </div>
      </dl>
    </Card>
  );
}

type FormField = 'rate' | 'step' | 'confirmation';

/** Codes that belong under one field rather than above the button. */
const FIELD_OF_CODE: Partial<Record<string, FormField>> = {
  RATE_CONFIRMATION_REQUIRED: 'confirmation',
  RATE_CONFIRMATION_MISMATCH: 'confirmation',
};

/** The change, in percent of the current rate, once the new rate is valid. */
function changeOf(current: ExchangeRateRecord | null, rateText: string): string | null {
  if (!current || !changeRateSchema.shape.sypPerUsd.safeParse(rateText).success) return null;
  return rateChangePercent(current.sypPerUsd, rateText.trim());
}

function ChangeRateForm({ current }: { current: ExchangeRateRecord | null }) {
  const { t } = useTranslation();
  const change = useChangeRate();
  const [rateText, setRateText] = useState('');
  const [stepText, setStepText] = useState(
    String((current?.displayStepSypUnits ?? 5 * CURRENCY_SCALE.SYP) / CURRENCY_SCALE.SYP),
  );
  const [confirmation, setConfirmation] = useState('');
  const [errors, setErrors] = useState<Partial<Record<FormField, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const percent = changeOf(current, rateText);
  const needsConfirmation =
    percent !== null && Math.abs(Number(percent)) > RATE_CONFIRMATION_THRESHOLD_PERCENT;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    setSaved(false);
    const body: ChangeRate = {
      sypPerUsd: rateText.trim(),
      displayStepSypUnits: parseWholeSyp(stepText) ?? Number.NaN,
      rateConfirmation: needsConfirmation ? confirmation.trim() : undefined,
    };
    const parsed = changeRateSchema.safeParse(body);
    const found: Partial<Record<FormField, string>> = {};
    for (const issue of parsed.error?.issues ?? []) {
      if (issue.path[0] === 'sypPerUsd') found.rate = t('rates.form.errors.rate');
      if (issue.path[0] === 'displayStepSypUnits') found.step = t('rates.form.errors.step');
    }
    if (needsConfirmation && !confirmation.trim()) {
      found.confirmation = t('rates.form.errors.confirmation');
    }
    setErrors(found);
    if (!parsed.success || found.confirmation) return;
    try {
      await change.mutateAsync(parsed.data);
      setSaved(true);
    } catch (error) {
      const field = error instanceof ApiError && error.code ? FIELD_OF_CODE[error.code] : undefined;
      if (field) setErrors({ [field]: errorMessage(t, error) });
      else setFailure(errorMessage(t, error));
    }
  }

  return (
    <Card className="gap-4">
      <CardTitle>{current ? t('rates.form.title') : t('rates.form.firstTitle')}</CardTitle>
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <Field invalid={!!errors.rate}>
          <FieldLabel>{t('rates.form.rate')}</FieldLabel>
          <Input
            name="sypPerUsd"
            dir="ltr"
            inputMode="decimal"
            autoComplete="off"
            value={rateText}
            onChange={(event) => {
              setRateText(event.target.value);
              setSaved(false);
            }}
          />
          <FieldDescription>{t('rates.form.rateHint')}</FieldDescription>
          <FieldError match={!!errors.rate}>{errors.rate}</FieldError>
        </Field>
        {percent !== null && (
          <p
            className={
              needsConfirmation
                ? 'text-sm font-medium text-status-warning-foreground'
                : 'text-sm text-muted-foreground'
            }
          >
            {t('rates.form.change', {
              percent: ltr(`${Number(percent) > 0 ? '+' : ''}${percent}%`),
            })}
          </p>
        )}
        {needsConfirmation && (
          <Field invalid={!!errors.confirmation}>
            <FieldLabel>{t('rates.form.confirmation')}</FieldLabel>
            <Input
              name="rateConfirmation"
              dir="ltr"
              inputMode="decimal"
              autoComplete="off"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              onPaste={(event) => event.preventDefault()}
              onDrop={(event) => event.preventDefault()}
            />
            <FieldDescription>
              {t('rates.form.confirmationHint', { threshold: RATE_CONFIRMATION_THRESHOLD_PERCENT })}
            </FieldDescription>
            <FieldError match={!!errors.confirmation}>{errors.confirmation}</FieldError>
          </Field>
        )}
        <Field invalid={!!errors.step}>
          <FieldLabel>{t('rates.form.step')}</FieldLabel>
          <Input
            name="displayStep"
            dir="ltr"
            inputMode="numeric"
            autoComplete="off"
            value={stepText}
            onChange={(event) => setStepText(event.target.value)}
          />
          <FieldDescription>
            {t('rates.form.stepHint', {
              min: DISPLAY_STEP_MIN_SYP_UNITS / CURRENCY_SCALE.SYP,
              max: DISPLAY_STEP_MAX_SYP_UNITS / CURRENCY_SCALE.SYP,
            })}
          </FieldDescription>
          <FieldError match={!!errors.step}>{errors.step}</FieldError>
        </Field>
        {failure && <FormAlert>{failure}</FormAlert>}
        {saved && (
          <p role="status" className="text-sm font-medium text-status-success-foreground">
            {t('rates.form.saved')}
          </p>
        )}
        <Button type="submit" className="self-start" disabled={change.isPending}>
          {change.isPending ? t('rates.form.submitting') : t('rates.form.submit')}
        </Button>
      </form>
    </Card>
  );
}

function HistoryTable({ rates }: { rates: ExchangeRateRecord[] }) {
  const { t } = useTranslation();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('rates.history.time')}</TableHead>
          <TableHead>{t('rates.history.rate')}</TableHead>
          <TableHead>{t('rates.history.step')}</TableHead>
          <TableHead>{t('rates.history.change')}</TableHead>
          <TableHead>{t('rates.history.admin')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rates.map((rate) => (
          <TableRow key={rate.id}>
            <TableCell className="whitespace-nowrap">{formatDateTime(rate.createdAt)}</TableCell>
            <TableCell className="font-medium tabular-nums">{formatRate(rate.sypPerUsd)}</TableCell>
            <TableCell className="tabular-nums">
              {t('rates.syp', { amount: formatSyp(rate.displayStepSypUnits) })}
            </TableCell>
            <TableCell className="tabular-nums">
              {rate.changePercent === null ? (
                '—'
              ) : (
                <bdi dir="ltr">
                  {Number(rate.changePercent) > 0 ? '+' : ''}
                  {rate.changePercent}%
                </bdi>
              )}
            </TableCell>
            <TableCell>{rate.adminName ?? t('common.unknown')}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
