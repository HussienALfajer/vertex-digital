import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  approveRateSuggestionSchema,
  type ExchangeRateRecord,
  formatRate,
  RATE_CONFIRMATION_THRESHOLD_PERCENT,
  type RateObservation,
  type RateSource,
  type RateSuggestion,
  rateChangePercent,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Card,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  Skeleton,
  Switch,
  useFocusInvalid,
} from '@vertex-digital/ui';
import { PencilIcon, RadioTowerIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { FormAlert, InvalidAlert } from '../../components/form-alert';
import { ApiError } from '../../lib/api/client';
import { errorMessage } from '../../lib/errors';
import { formatDateTime, formatSince, ltr } from '../../lib/format';
import {
  rateSourcesQuery,
  useApproveRateSuggestion,
  useRejectRateSuggestion,
  useUpdateRateSource,
} from './rates.queries';

/*
 * S27 (F46) on "سعر الصرف": whether automatic updates are on, the pending suggestion with its
 * approval (an editable value, FX2's typed confirmation above 5%) and rejection, and the sources
 * with their last reads.
 */

const signed = (percent: string) => ltr(`${Number(percent) > 0 ? '+' : ''}${percent}%`);

/** The automatic updates' state, with the way to the settings. */
export function AutoStatusCard({ autoEnabled }: { autoEnabled: boolean }) {
  const { t } = useTranslation();
  return (
    <Card className="gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>{t('rates.auto.title')}</CardTitle>
        <Badge tone={autoEnabled ? 'success' : 'neutral'}>
          {t(autoEnabled ? 'rates.auto.on' : 'rates.auto.off')}
        </Badge>
      </div>
      <p className="text-sm text-muted-foreground">
        {t(autoEnabled ? 'rates.auto.onHelp' : 'rates.auto.offHelp')}
      </p>
      <Button variant="outline" className="self-start" render={<Link to="/rates/settings" />}>
        {t('rates.auto.settings')}
      </Button>
    </Card>
  );
}

/** SG1–SG4 in the panel: the figures, approve (the value editable) or reject. */
export function SuggestionCard({
  suggestion,
  current,
}: {
  suggestion: RateSuggestion;
  current: ExchangeRateRecord | null;
}) {
  const { t } = useTranslation();
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const reject = useRejectRateSuggestion();
  return (
    <Card className="gap-4 border-status-warning-foreground/40 lg:col-span-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>{t('rates.suggestion.title')}</CardTitle>
        <Badge tone="warning">{t(`rates.reasons.${suggestion.reason}`)}</Badge>
      </div>
      <p className="text-2xl font-bold tabular-nums">
        {t('rates.current.value', { rate: formatRate(suggestion.proposedSypPerUsd) })}
      </p>
      <p className="text-sm text-muted-foreground">
        {t('rates.suggestion.against', {
          rate: formatRate(suggestion.baseSypPerUsd),
          change: signed(suggestion.changePercent),
          since: formatSince(suggestion.createdAt),
        })}
      </p>
      {suggestion.figures.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {suggestion.figures.map((figure) => (
            <li key={`${figure.sourceLabel}-${figure.at}`} className="flex flex-wrap gap-x-2">
              <span className="font-medium">{figure.sourceLabel}</span>
              <span className="tabular-nums">{formatRate(figure.sypPerUsd)}</span>
              <time className="text-muted-foreground" dateTime={figure.at}>
                {formatSince(figure.at)}
              </time>
            </li>
          ))}
        </ul>
      )}
      <fieldset aria-label={t('rates.suggestion.title')} className="flex flex-wrap gap-2">
        <Button onClick={() => setApproving(true)}>{t('rates.suggestion.approve')}</Button>
        <Button variant="outline" onClick={() => setRejecting(true)}>
          {t('rates.suggestion.reject')}
        </Button>
      </fieldset>
      <Dialog open={approving} onOpenChange={setApproving}>
        {approving && (
          <ApproveDialog
            suggestion={suggestion}
            current={current}
            onDone={() => setApproving(false)}
          />
        )}
      </Dialog>
      <ConfirmDialog
        open={rejecting}
        onClose={() => setRejecting(false)}
        title={t('rates.suggestion.rejectTitle')}
        body={t('rates.suggestion.rejectBody', { rate: formatRate(suggestion.proposedSypPerUsd) })}
        action={t('rates.suggestion.reject')}
        pending={reject.isPending}
        onConfirm={async () => {
          await reject.mutateAsync(suggestion.id);
        }}
      />
    </Card>
  );
}

type ApproveField = 'rate' | 'confirmation';

const FIELD_OF_CODE: Partial<Record<string, ApproveField>> = {
  RATE_CONFIRMATION_REQUIRED: 'confirmation',
  RATE_CONFIRMATION_MISMATCH: 'confirmation',
  DISPLAY_STEP_TOO_LARGE: 'rate',
};

function ApproveDialog({
  suggestion,
  current,
  onDone,
}: {
  suggestion: RateSuggestion;
  current: ExchangeRateRecord | null;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const approve = useApproveRateSuggestion();
  const [rateText, setRateText] = useState(suggestion.proposedSypPerUsd);
  const [confirmation, setConfirmation] = useState('');
  const [errors, setErrors] = useState<Partial<Record<ApproveField, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const { ref, focusInvalid } = useFocusInvalid();
  const valid = approveRateSuggestionSchema.shape.sypPerUsd.safeParse(rateText).success;
  const percent = valid && current ? rateChangePercent(current.sypPerUsd, rateText.trim()) : null;
  const needsConfirmation =
    percent !== null && Math.abs(Number(percent)) > RATE_CONFIRMATION_THRESHOLD_PERCENT;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const found: Partial<Record<ApproveField, string>> = {};
    if (!valid) found.rate = t('rates.form.errors.rate');
    if (needsConfirmation && !confirmation.trim()) {
      found.confirmation = t('rates.form.errors.confirmation');
    }
    setErrors(found);
    if (found.rate || found.confirmation) return focusInvalid();
    try {
      await approve.mutateAsync({
        id: suggestion.id,
        body: {
          sypPerUsd: rateText.trim(),
          rateConfirmation: needsConfirmation ? confirmation.trim() : undefined,
        },
      });
      onDone();
    } catch (error) {
      const field = error instanceof ApiError && error.code ? FIELD_OF_CODE[error.code] : undefined;
      if (!field) return setFailure(errorMessage(t, error));
      setErrors({ [field]: errorMessage(t, error) });
      focusInvalid();
    }
  }

  return (
    <DialogContent closeLabel={t('common.close')} className="max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{t('rates.suggestion.approveTitle')}</DialogTitle>
        <DialogDescription>{t('rates.suggestion.approveBody')}</DialogDescription>
      </DialogHeader>
      <form ref={ref} className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <Field invalid={!!errors.rate}>
          <FieldLabel>{t('rates.form.rate')}</FieldLabel>
          <Input
            name="sypPerUsd"
            dir="ltr"
            inputMode="decimal"
            autoComplete="off"
            value={rateText}
            onChange={(event) => setRateText(event.target.value)}
          />
          <FieldDescription>
            {t('rates.suggestion.proposed', { rate: formatRate(suggestion.proposedSypPerUsd) })}
          </FieldDescription>
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
            {t('rates.form.change', { percent: signed(percent) })}
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
        {failure && <FormAlert>{failure}</FormAlert>}
        <InvalidAlert show={Object.values(errors).some(Boolean)} />
        <DialogFooter>
          <Button type="submit" disabled={approve.isPending}>
            {approve.isPending
              ? t('rates.form.submitting')
              : t('rates.suggestion.approveRate', { rate: ltr(rateText.trim()) })}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

/** "المصادر": each live source with its health, enable switch, edit link and last reads. */
export function SourcesSection() {
  const { t } = useTranslation();
  const sources = useQuery(rateSourcesQuery);
  return (
    <section className="flex flex-col gap-3" aria-labelledby="rate-sources">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="rate-sources" className="text-lg font-bold">
          {t('rates.sources.title')}
        </h2>
        <Button variant="outline" render={<Link to="/rates/sources/new" />}>
          {t('rates.sources.add')}
        </Button>
      </div>
      {sources.isPending && <Skeleton className="h-32 w-full" aria-hidden="true" />}
      {sources.isError && (
        <div className="flex flex-col items-start gap-3">
          <FormAlert>{errorMessage(t, sources.error)}</FormAlert>
          <Button variant="outline" onClick={() => sources.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {sources.isSuccess &&
        (sources.data.items.length === 0 ? (
          <EmptyState icon={<RadioTowerIcon />} title={t('rates.sources.empty')} />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {sources.data.items.map((source) => (
              <SourceCard key={source.id} source={source} />
            ))}
          </div>
        ))}
    </section>
  );
}

const HEALTH_TONES = { ok: 'success', broken: 'danger', unknown: 'neutral' } as const;

function SourceCard({ source }: { source: RateSource }) {
  const { t } = useTranslation();
  const update = useUpdateRateSource();
  const [failure, setFailure] = useState<string | null>(null);
  const switchId = `source-${source.id}`;
  return (
    <Card className="gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <CardTitle className="truncate">{source.label}</CardTitle>
          <p className="text-sm text-muted-foreground">
            {t(`rates.kinds.${source.kind}`)} ·{' '}
            <bdi dir="ltr" className="break-all">
              {source.kind === 'telegram_channel' ? `@${source.handle}` : source.handle}
            </bdi>
          </p>
        </div>
        <Badge tone={HEALTH_TONES[source.health]}>{t(`rates.health.${source.health}`)}</Badge>
      </div>
      {source.observations.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('rates.sources.noReads')}</p>
      ) : (
        <ul className="flex flex-col gap-2 text-sm" aria-label={t('rates.sources.reads')}>
          {source.observations.map((read) => (
            <ReadLine key={read.id} read={read} />
          ))}
        </ul>
      )}
      <fieldset
        aria-label={source.label}
        className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3"
      >
        <label htmlFor={switchId} className="flex items-center gap-2 text-sm font-medium">
          <Switch
            id={switchId}
            checked={source.enabled}
            disabled={update.isPending}
            onCheckedChange={(enabled) => {
              setFailure(null);
              update
                .mutateAsync({ id: source.id, body: { enabled } })
                .catch((error: unknown) => setFailure(errorMessage(t, error)));
            }}
          />
          {t(source.enabled ? 'rates.sources.enabled' : 'rates.sources.disabled')}
        </label>
        <Button
          variant="ghost"
          render={<Link to="/rates/sources/$id" params={{ id: source.id }} />}
        >
          <PencilIcon aria-hidden="true" />
          {t('rates.sources.edit')}
        </Button>
      </fieldset>
      {failure && <FormAlert>{failure}</FormAlert>}
    </Card>
  );
}

/** One read: the figure or why it failed, its age, and the matched line. */
export function ReadLine({
  read,
}: {
  read: Pick<RateObservation, 'status' | 'sypPerUsd' | 'excerpt' | 'errorCode' | 'postedAt'> & {
    fetchedAt?: string;
  };
}) {
  const { t } = useTranslation();
  const at = read.postedAt ?? read.fetchedAt ?? null;
  return (
    <li className="flex flex-col gap-1 rounded-md bg-muted/50 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          tone={
            read.status === 'ok' ? 'success' : read.status === 'no_match' ? 'warning' : 'danger'
          }
        >
          {t(`rates.readStatus.${read.status}`)}
        </Badge>
        {read.sypPerUsd && (
          <span className="font-medium tabular-nums">{formatRate(read.sypPerUsd)}</span>
        )}
        {at && (
          <time className="text-muted-foreground" dateTime={at} title={formatDateTime(at)}>
            {formatSince(at)}
          </time>
        )}
        {read.errorCode && (
          <code dir="ltr" className="text-xs text-muted-foreground">
            {read.errorCode}
          </code>
        )}
      </div>
      {read.excerpt && <p className="text-muted-foreground break-words">{read.excerpt}</p>}
    </li>
  );
}
