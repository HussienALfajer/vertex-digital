import { useQuery } from '@tanstack/react-query';
import {
  type Currency,
  type MoneyPlaces,
  type OpenMismatch,
  type ReconciliationOverview,
  type SupplierCode,
  supplierOfPlace,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Card,
  CardTitle,
  Dialog,
  EmptyState,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from '@vertex-digital/ui';
import {
  CircleCheckIcon,
  LoaderCircleIcon,
  PlayIcon,
  ScaleIcon,
  SettingsIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '../../lib/errors';
import { formatDateTime, formatDay, formatSince, formatTime } from '../../lib/format';
import { CorrectionDialog } from './correction-dialog';
import { CountDialog } from './count-dialog';
import { ExplainDialog } from './explain-dialog';
import { HistoryTab } from './history-tab';
import { MovementDialog } from './movement-dialog';
import { MovementsTab } from './movements-tab';
import { overviewQuery, placesQuery, useAfterRunEnds, useStartRun } from './reconciliation.queries';
import { money, placeLabel, resultStatusLabel, subjectLabel } from './reconciliation-labels';
import { OpenMismatchList } from './reconciliation-results';
import {
  RECONCILIATION_TABS,
  type ReconciliationSearch,
  type ReconciliationTab,
  tabOf,
  withTab,
} from './reconciliation-search';
import { FailureLine, LoadError, OverviewSkeleton } from './reconciliation-states';
import { SettingsSheet } from './settings-sheet';

type Place = MoneyPlaces['places'][number];

type OpenDialog =
  | { kind: 'movement'; place: Place | null }
  | { kind: 'count'; currency: Currency }
  | { kind: 'correction'; supplier: SupplierCode }
  | { kind: 'explain'; result: OpenMismatch };

/**
 * `/reconciliation` (S13, F20): the state of the books, the open mismatches, the money places
 * with their movements and counts, the run history and the settings. Tabs live in the URL.
 */
export function ReconciliationPage({
  search,
  onSearch,
}: {
  search: ReconciliationSearch;
  onSearch: (search: ReconciliationSearch) => void;
}) {
  const { t } = useTranslation();
  const overview = useQuery(overviewQuery);
  const places = useQuery(placesQuery);
  useAfterRunEnds(overview.data);
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const close = () => setDialog(null);

  return (
    <>
      <PageHeader
        title={t('reconciliation.title')}
        description={t('reconciliation.subtitle')}
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => setDialog({ kind: 'movement', place: null })}
              disabled={!places.data}
            >
              {t('reconciliation.places.record')}
            </Button>
            <Button
              variant="outline"
              onClick={() => setSettingsOpen(true)}
              disabled={!overview.data}
            >
              <SettingsIcon aria-hidden="true" />
              {t('reconciliation.settings.open')}
            </Button>
          </>
        }
      />
      <Tabs
        value={tabOf(search)}
        onValueChange={(tab: ReconciliationTab) => onSearch(withTab(search, tab))}
      >
        <TabsList>
          {RECONCILIATION_TABS.map((tab) => (
            <TabsTrigger key={tab} value={tab}>
              {t(`reconciliation.tabs.${tab}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="overview" className="flex flex-col gap-6">
          {overview.isPending && <OverviewSkeleton />}
          {overview.isError && (
            <LoadError error={overview.error} onRetry={() => overview.refetch()} />
          )}
          {overview.data && (
            <Overview
              overview={overview.data}
              onExplain={(result) => setDialog({ kind: 'explain', result })}
            />
          )}
          <Card className="gap-4">
            <CardTitle>{t('reconciliation.places.title')}</CardTitle>
            {places.isPending && <OverviewSkeleton />}
            {places.isError && <LoadError error={places.error} onRetry={() => places.refetch()} />}
            {places.data && (
              <PlacesTable
                places={places.data.places}
                onMovement={(place) => setDialog({ kind: 'movement', place })}
                onCount={(currency) => setDialog({ kind: 'count', currency })}
                onCorrection={(supplier) => setDialog({ kind: 'correction', supplier })}
              />
            )}
          </Card>
        </TabsContent>
        <TabsContent value="movements">
          {tabOf(search) === 'movements' && (
            <MovementsTab
              place={search.place}
              onPlace={(place) =>
                onSearch(place ? { tab: 'movements', place } : { tab: 'movements' })
              }
            />
          )}
        </TabsContent>
        <TabsContent value="history">{tabOf(search) === 'history' && <HistoryTab />}</TabsContent>
      </Tabs>
      <Dialog open={dialog !== null} onOpenChange={(open) => !open && close()}>
        {dialog?.kind === 'movement' && places.data && (
          <MovementDialog places={places.data.places} place={dialog.place} onDone={close} />
        )}
        {dialog?.kind === 'count' && <CountDialog currency={dialog.currency} onDone={close} />}
        {dialog?.kind === 'correction' && (
          <CorrectionDialog supplier={dialog.supplier} onDone={close} />
        )}
        {dialog?.kind === 'explain' && <ExplainDialog result={dialog.result} onDone={close} />}
      </Dialog>
      {overview.data && (
        <SettingsSheet
          open={settingsOpen}
          settings={overview.data.settings}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </>
  );
}

function Overview({
  overview,
  onExplain,
}: {
  overview: ReconciliationOverview;
  onExplain: (result: OpenMismatch) => void;
}) {
  const { t } = useTranslation();
  const { lastRun, running, openMismatches } = overview;
  // Rule RN7 keeps a mismatch open until explained; "no run yet" means no run of any kind.
  if (!lastRun && !running && openMismatches.length === 0) {
    return (
      <EmptyState
        icon={<ScaleIcon />}
        title={t('reconciliation.empty.title')}
        description={t('reconciliation.empty.description')}
        action={<RunNowButton overview={overview} />}
      />
    );
  }
  return (
    <>
      <StatusCard overview={overview} />
      <Card className="gap-4">
        <CardTitle>{t('reconciliation.open.title')}</CardTitle>
        {openMismatches.length === 0 ? (
          <p className="flex items-center gap-2 text-status-success-foreground">
            <CircleCheckIcon className="size-5" aria-hidden="true" />
            {t('reconciliation.open.none')}
          </p>
        ) : (
          <OpenMismatchList mismatches={openMismatches} onExplain={onExplain} />
        )}
      </Card>
    </>
  );
}

/** The last nightly run, the run in progress, the warnings and the last Sham Cash counts. */
function StatusCard({ overview }: { overview: ReconciliationOverview }) {
  const { t } = useTranslation();
  const { lastNightly, running, warnings, shamCashCounts, openMismatches } = overview;
  const open = openMismatches.length;
  return (
    <Card className="gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          {lastNightly ? (
            <p className="text-base">
              {t('reconciliation.status.last', {
                night: lastNightly.businessDate ? formatDay(lastNightly.businessDate) : '',
                time: formatTime(lastNightly.finishedAt ?? lastNightly.startedAt),
              })}
            </p>
          ) : (
            <p className="text-base text-muted-foreground">
              {t('reconciliation.status.noNightly')}
              {overview.lastRun &&
                ` · ${t('reconciliation.status.lastRun', {
                  trigger: t(`reconciliation.triggers.${overview.lastRun.trigger}`),
                  time: formatDateTime(overview.lastRun.finishedAt ?? overview.lastRun.startedAt),
                })}`}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {lastNightly?.status === 'failed' ? (
              <Badge tone="danger">{t('reconciliation.status.failed')}</Badge>
            ) : open > 0 ? (
              <Badge tone="danger">{t('reconciliation.status.mismatches', { count: open })}</Badge>
            ) : (
              // "Clean" only once a night has checked every book, and not while a run waits to
              // read a balance again (audit A09-38).
              lastNightly &&
              !running?.recheckAt && (
                <Badge tone="success">{t('reconciliation.status.clean')}</Badge>
              )
            )}
            {warnings.length > 0 && (
              <Badge tone="warning">
                {t('reconciliation.status.warnings', { count: warnings.length })}
              </Badge>
            )}
          </div>
          {lastNightly?.status === 'failed' && lastNightly.failure && (
            <FailureLine failure={lastNightly.failure} />
          )}
        </div>
        <RunNowButton overview={overview} />
      </div>
      {running && (
        <p className="flex items-center gap-2 text-sm" role="status">
          <LoaderCircleIcon className="size-4 animate-spin" aria-hidden="true" />
          {running.recheckAt
            ? t('reconciliation.status.recheck', { time: formatTime(running.recheckAt) })
            : t('reconciliation.status.running', { since: formatSince(running.startedAt) })}
        </p>
      )}
      {warnings.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {warnings.map((warning) => (
            <li key={warning.id} className="flex items-start gap-2">
              <TriangleAlertIcon
                className="mt-0.5 size-4 shrink-0 text-status-warning-foreground"
                aria-hidden="true"
              />
              <span>
                {t(`reconciliation.checks.${warning.check}`)} ·{' '}
                <bdi>{subjectLabel(t, warning.subject)}</bdi> · {resultStatusLabel(t, warning)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {shamCashCounts.length > 0 && (
        <p className="text-sm text-muted-foreground">
          {shamCashCounts
            .map((count) =>
              t('reconciliation.status.count', {
                amount: money(t, count.currency, count.countedUnits),
                since: formatSince(count.at),
              }),
            )
            .join(' · ')}
        </p>
      )}
    </Card>
  );
}

/**
 * Re-renders once `at` has passed, so a wait that ends with no new read ends on screen too
 * (audit A09-28: the overview is not read again once no run is running).
 */
function usePassed(at: string | null): boolean {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!at) return;
    const left = Date.parse(at) - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), left + 500);
    return () => clearTimeout(timer);
  }, [at]);
  return !at || Date.parse(at) <= now;
}

/** Rule RN2: one run at a time, one manual run per 5 minutes. */
function RunNowButton({ overview }: { overview: ReconciliationOverview }) {
  const { t } = useTranslation();
  const start = useStartRun();
  const waiting = usePassed(overview.manualAvailableAt) ? null : overview.manualAvailableAt;
  const disabled = !!overview.running || !!waiting || start.isPending;
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        disabled={disabled}
        onClick={() =>
          start.mutate(undefined, {
            onError: (error) => toast.add({ title: errorMessage(t, error), type: 'error' }),
          })
        }
      >
        <PlayIcon aria-hidden="true" />
        {t('reconciliation.runNow')}
      </Button>
      {waiting && !overview.running && (
        <span className="text-xs text-muted-foreground">
          {t('reconciliation.runAvailable', { time: formatTime(waiting) })}
        </span>
      )}
    </div>
  );
}

/** "أماكن المال": books held, the last outside balance and the difference, with the actions. */
function PlacesTable({
  places,
  onMovement,
  onCount,
  onCorrection,
}: {
  places: Place[];
  onMovement: (place: Place) => void;
  onCount: (currency: Currency) => void;
  onCorrection: (supplier: SupplierCode) => void;
}) {
  const { t } = useTranslation();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('reconciliation.places.place')}</TableHead>
          <TableHead>{t('reconciliation.columns.books')}</TableHead>
          <TableHead>{t('reconciliation.places.external')}</TableHead>
          <TableHead>{t('reconciliation.columns.difference')}</TableHead>
          <TableHead>
            <span className="sr-only">{t('reconciliation.places.actions')}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {places.map((place) => {
          const supplier = supplierOfPlace(place.place);
          const shamCash = place.place.startsWith('sham_cash_');
          return (
            <TableRow key={place.place}>
              <TableCell>
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium">{placeLabel(t, place.place)}</span>
                  {!place.openingRecorded && !place.place.startsWith('outside_') && (
                    <span className="text-xs text-muted-foreground">
                      {t('reconciliation.places.noOpening')}
                    </span>
                  )}
                </span>
              </TableCell>
              <TableCell className="tabular-nums">
                <span className="flex items-center gap-2">
                  {money(t, place.currency, place.booksUnits)}
                  {supplier === 'manual' && place.booksUnits < 0 && (
                    <Badge tone="gold">{t('reconciliation.places.owedToYou')}</Badge>
                  )}
                </span>
              </TableCell>
              <TableCell>
                {place.external ? (
                  <span className="flex flex-col gap-0.5">
                    <span className="tabular-nums">
                      {money(t, place.currency, place.external.units)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t(`reconciliation.sources.${place.external.source}`)} ·{' '}
                      {formatDateTime(place.external.at)}
                    </span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="tabular-nums">
                {place.differenceUnits === null ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <span className={place.differenceUnits !== 0 ? 'text-destructive-text' : ''}>
                    {money(t, place.currency, place.differenceUnits)}
                  </span>
                )}
              </TableCell>
              <TableCell>
                <span className="flex justify-end gap-2">
                  {shamCash && (
                    <Button variant="outline" size="sm" onClick={() => onCount(place.currency)}>
                      {t('reconciliation.places.count')}
                    </Button>
                  )}
                  {supplier && (
                    <Button variant="outline" size="sm" onClick={() => onCorrection(supplier)}>
                      {t('reconciliation.places.correct')}
                    </Button>
                  )}
                  <Button variant="outline" size="sm" onClick={() => onMovement(place)}>
                    {t('reconciliation.places.record')}
                  </Button>
                </span>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
