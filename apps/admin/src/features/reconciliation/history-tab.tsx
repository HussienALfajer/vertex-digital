import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  Badge,
  Button,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@vertex-digital/ui';
import { HistoryIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatDateTime, formatDay } from '../../lib/format';
import { runsQuery } from './reconciliation.queries';
import { runTone } from './reconciliation-labels';
import { LoadError, OverviewSkeleton } from './reconciliation-states';

/** "السجل": past runs, newest first, with their counts; a run opens its page. */
export function HistoryTab() {
  const { t } = useTranslation();
  const list = useInfiniteQuery(runsQuery);
  const runs = list.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <div className="flex flex-col gap-4">
      {list.isPending && <OverviewSkeleton />}
      {list.isError && <LoadError error={list.error} onRetry={() => list.refetch()} />}
      {list.isSuccess && runs.length === 0 && (
        <EmptyState icon={<HistoryIcon />} title={t('reconciliation.empty.title')} />
      )}
      {runs.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('reconciliation.history.started')}</TableHead>
              <TableHead>{t('reconciliation.history.trigger')}</TableHead>
              <TableHead>{t('reconciliation.history.status')}</TableHead>
              <TableHead>{t('reconciliation.history.mismatches')}</TableHead>
              <TableHead>{t('reconciliation.history.warnings')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => (
              <TableRow key={run.id}>
                <TableCell>
                  <Link
                    to="/reconciliation/runs/$id"
                    params={{ id: run.id }}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    {formatDateTime(run.startedAt)}
                  </Link>
                </TableCell>
                <TableCell>
                  {t(`reconciliation.triggers.${run.trigger}`)}
                  {run.businessDate && (
                    <span className="text-muted-foreground"> · {formatDay(run.businessDate)}</span>
                  )}
                </TableCell>
                <TableCell>
                  <Badge tone={runTone(run)}>{t(`reconciliation.runStatuses.${run.status}`)}</Badge>
                </TableCell>
                <TableCell className="tabular-nums">{run.mismatchCount}</TableCell>
                <TableCell className="tabular-nums">{run.warningCount}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
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
    </div>
  );
}
