import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  REPORT_BREAKDOWNS,
  REPORT_KINDS,
  type ReportBreakdown,
  type ReportKind,
  reportPeriodError,
} from '@vertex-digital/contracts';
import {
  Button,
  Card,
  Field,
  FieldError,
  FieldLabel,
  Input,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  ToggleGroup,
  ToggleGroupItem,
  toast,
  useFocusInvalid,
} from '@vertex-digital/ui';
import { DownloadIcon } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '../../lib/errors';
import { formatDay } from '../../lib/format';
import { LoadError, OverviewSkeleton } from '../reconciliation/reconciliation-states';
import {
  breakdownOf,
  kindOf,
  periodOf,
  presetOf,
  presetPeriod,
  REPORT_PRESETS,
  type ReportPreset,
  type ReportSearch,
  withKind,
} from './report-search';
import { ReportView } from './report-views';
import { type ReportRequest, reportQuery, useExportReport } from './reports.queries';

const CUSTOM = 'custom';

/**
 * `/reports` (S13, F22): R1–R6 as tabs, a period with the presets (rule RP1), the breakdown on
 * R2, a table with its totals and the Excel export. The report and period live in the URL.
 */
export function ReportsPage({
  search,
  onSearch,
}: {
  search: ReportSearch;
  onSearch: (search: ReportSearch) => void;
}) {
  const { t } = useTranslation();
  const now = useNow();
  const kind = kindOf(search);
  const period = periodOf(search, now);
  const by = breakdownOf(search);
  const request: ReportRequest = { kind, ...period, by };
  const exporter = useExportReport();

  function exportReport() {
    exporter.mutate(request, {
      onError: (error) => toast.add({ title: errorMessage(t, error), type: 'error' }),
    });
  }

  return (
    <>
      <PageHeader
        title={t('reports.title')}
        description={t('reports.subtitle')}
        actions={
          <>
            {/* S23 AD4: the report by tier, a month at a time. */}
            <Button variant="ghost" render={<Link to="/reports/merchant-tiers" />}>
              {t('reports.merchantTiers.title')}
            </Button>
            <Button variant="outline" onClick={exportReport} disabled={exporter.isPending}>
              <DownloadIcon aria-hidden="true" />
              {exporter.isPending ? t('reports.exporting') : t('reports.export')}
            </Button>
          </>
        }
      />
      <PeriodPicker
        key={`${period.from}:${period.to}`}
        period={period}
        now={now}
        onPeriod={(next) => onSearch({ ...search, ...next })}
      />
      <Tabs value={kind} onValueChange={(next: ReportKind) => onSearch(withKind(search, next))}>
        <TabsList>
          {REPORT_KINDS.map((item) => (
            <TabsTrigger key={item} value={item}>
              {t(`reports.kinds.${item}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value={kind} className="flex flex-col gap-4">
          {kind === 'breakdown' && (
            <ToggleGroup<ReportBreakdown>
              aria-label={t('reports.breakdown.label')}
              value={[by]}
              onValueChange={(value) => {
                const next = value[0];
                if (!next) return;
                const { by: _by, ...rest } = search;
                onSearch(next === 'game' ? rest : { ...rest, by: next });
              }}
            >
              {REPORT_BREAKDOWNS.map((item) => (
                <ToggleGroupItem key={item} value={item}>
                  {t(`reports.breakdown.by.${item}`)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          )}
          <Report request={request} />
        </TabsContent>
      </Tabs>
    </>
  );
}

/**
 * The time the presets and the default period are read at, kept current every minute and when
 * the tab is seen again, so a page left open past midnight names the right days (audit A09-30).
 */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = () => setNow(new Date());
    const timer = setInterval(tick, 60_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return now;
}

function Report({ request }: { request: ReportRequest }) {
  const { t } = useTranslation();
  const report = useQuery(reportQuery(request));
  if (report.isPending) return <OverviewSkeleton />;
  if (!report.data) return <LoadError error={report.error} onRetry={() => report.refetch()} />;
  return (
    <>
      {/* A failed read again keeps the report shown, with the retry (audit A09-36). */}
      {report.isError && <LoadError error={report.error} onRetry={() => report.refetch()} />}
      {/* The previous period stays while the new one loads, marked as such (audit A09-36). */}
      <div
        aria-busy={report.isPlaceholderData}
        className={report.isPlaceholderData ? 'opacity-60 transition-opacity' : undefined}
      >
        {report.isPlaceholderData && (
          <p className="sr-only" role="status">
            {t('reports.loading')}
          </p>
        )}
        <ReportView kind={request.kind} report={report.data} />
      </div>
    </>
  );
}

/** Rule RP1: a preset, or two Damascus dates, both included, at most 366 days. */
function PeriodPicker({
  period,
  now,
  onPeriod,
}: {
  period: { from: string; to: string };
  now: Date;
  onPeriod: (period: { from: string; to: string }) => void;
}) {
  const { t } = useTranslation();
  const preset = presetOf(period, now);
  const [custom, setCustom] = useState(preset === null);
  const [invalid, setInvalid] = useState(false);
  const { ref, focusInvalid } = useFocusInvalid();
  const items = [
    ...REPORT_PRESETS.map((item) => ({ value: item, label: t(`reports.presets.${item}`) })),
    { value: CUSTOM, label: t('reports.presets.custom') },
  ];

  function choose(value: string | null) {
    if (!value) return;
    if (value === CUSTOM) {
      setCustom(true);
      return;
    }
    setCustom(false);
    // The day of the choice, whatever day the page was opened (audit A09-30).
    onPeriod(presetPeriod(value as ReportPreset, new Date()));
  }

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const from = String(data.get('from') ?? '');
    const to = String(data.get('to') ?? '');
    const bad = !from || !to || reportPeriodError(from, to) !== null;
    setInvalid(bad);
    if (bad) return focusInvalid();
    onPeriod({ from, to });
  }

  return (
    <Card>
      <form
        ref={ref}
        className="flex flex-wrap items-end gap-4"
        onSubmit={apply}
        noValidate
        aria-label={t('reports.period.label')}
      >
        <Field className="w-48">
          <FieldLabel>{t('reports.period.label')}</FieldLabel>
          <Select items={items} value={custom ? CUSTOM : (preset ?? CUSTOM)} onValueChange={choose}>
            <SelectTrigger aria-label={t('reports.period.label')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {items.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {custom ? (
          <>
            <Field invalid={invalid}>
              <FieldLabel>{t('reports.period.from')}</FieldLabel>
              <Input name="from" type="date" dir="ltr" defaultValue={period.from} />
            </Field>
            <Field invalid={invalid}>
              <FieldLabel>{t('reports.period.to')}</FieldLabel>
              <Input name="to" type="date" dir="ltr" defaultValue={period.to} />
              <FieldError match={invalid}>{t('errors.api.REPORT_PERIOD_INVALID')}</FieldError>
            </Field>
            <Button type="submit">{t('reports.period.apply')}</Button>
          </>
        ) : (
          <p className="pb-2 text-sm text-muted-foreground">
            {t('reports.period.range', { from: formatDay(period.from), to: formatDay(period.to) })}
          </p>
        )}
      </form>
    </Card>
  );
}
