import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Badge, Button, Card, EmptyState, PageHeader } from '@vertex-digital/ui';
import { ArrowRightIcon, SearchXIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../lib/api/client';
import { formatDateTime, formatDay } from '../../lib/format';
import { runQuery } from './reconciliation.queries';
import { runTone } from './reconciliation-labels';
import { ResultsTable } from './reconciliation-results';
import { LoadError, OverviewSkeleton } from './reconciliation-states';

/** A run's page (S13 "السجل"): when, why and how it ended, and every check with its result. */
export function RunPage({ id }: { id: string }) {
  const { t } = useTranslation();
  const run = useQuery(runQuery(id));
  const back = (
    <Button variant="ghost" render={<Link to="/reconciliation" search={{ tab: 'history' }} />}>
      <ArrowRightIcon aria-hidden="true" />
      {t('reconciliation.history.back')}
    </Button>
  );

  if (run.isError && run.error instanceof ApiError && run.error.status === 404) {
    return (
      <EmptyState
        icon={<SearchXIcon />}
        title={t('reconciliation.history.notFound')}
        action={back}
      />
    );
  }

  return (
    <>
      <PageHeader
        title={
          run.data
            ? t('reconciliation.history.runTitle', { when: formatDateTime(run.data.startedAt) })
            : t('reconciliation.history.runTitleLoading')
        }
        actions={back}
      />
      {run.isPending && <OverviewSkeleton />}
      {run.isError && <LoadError error={run.error} onRetry={() => run.refetch()} />}
      {run.data && (
        <>
          <Card className="flex-row flex-wrap items-center gap-3">
            <Badge tone={runTone(run.data)}>
              {t(`reconciliation.runStatuses.${run.data.status}`)}
            </Badge>
            <span>
              {t(`reconciliation.triggers.${run.data.trigger}`)}
              {run.data.businessDate && ` · ${formatDay(run.data.businessDate)}`}
            </span>
            <span className="text-muted-foreground">
              {t('reconciliation.history.counts', {
                mismatches: run.data.mismatchCount,
                warnings: run.data.warningCount,
              })}
            </span>
            {run.data.failure && (
              <span className="text-sm text-destructive-text">{run.data.failure}</span>
            )}
          </Card>
          {run.data.results.length > 0 ? (
            <ResultsTable results={run.data.results} />
          ) : (
            <p className="text-muted-foreground">{t('reconciliation.history.noResults')}</p>
          )}
        </>
      )}
    </>
  );
}
