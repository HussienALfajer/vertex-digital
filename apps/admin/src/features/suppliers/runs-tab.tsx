import { useQuery } from '@tanstack/react-query';
import type { SupplierCode, SyncRun } from '@vertex-digital/contracts';
import {
  Button,
  EmptyState,
  Pagination,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@vertex-digital/ui';
import type { TFunction } from 'i18next';
import { RefreshCwIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import { RunError, RunStatusBadge } from './supplier-parts';
import { LIST_PAGE_SIZE, runsQuery } from './suppliers.queries';

/** "المزامنة" (S07 screens): the runs, newest first, with trigger, duration, counts and error. */
export function RunsTab({ code }: { code: SupplierCode }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const runs = useQuery(runsQuery(code, page));
  const pageCount = Math.max(1, Math.ceil((runs.data?.total ?? 0) / LIST_PAGE_SIZE));

  if (runs.isPending) return <Skeleton className="h-64 w-full" aria-hidden="true" />;
  if (runs.isError) {
    return (
      <div className="flex flex-col items-start gap-3">
        <FormAlert>{errorMessage(t, runs.error)}</FormAlert>
        <Button variant="outline" onClick={() => runs.refetch()}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }
  if (runs.data.items.length === 0) {
    return <EmptyState icon={<RefreshCwIcon />} title={t('suppliers.runs.empty')} />;
  }
  return (
    <div className="flex flex-col gap-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('suppliers.runs.columns.started')}</TableHead>
            <TableHead>{t('suppliers.runs.columns.trigger')}</TableHead>
            <TableHead>{t('suppliers.runs.columns.status')}</TableHead>
            <TableHead>{t('suppliers.runs.columns.duration')}</TableHead>
            <TableHead>{t('suppliers.runs.columns.seen')}</TableHead>
            <TableHead>{t('suppliers.runs.columns.added')}</TableHead>
            <TableHead>{t('suppliers.runs.columns.changed')}</TableHead>
            <TableHead>{t('suppliers.runs.columns.missing')}</TableHead>
            <TableHead>{t('suppliers.runs.columns.reviews')}</TableHead>
            <TableHead>{t('suppliers.runs.columns.repriced')}</TableHead>
            <TableHead>{t('suppliers.runs.columns.error')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.data.items.map((run) => (
            <TableRow key={run.id}>
              <TableCell className="whitespace-nowrap">{formatDateTime(run.startedAt)}</TableCell>
              <TableCell>{t(`suppliers.runs.triggers.${run.trigger}`)}</TableCell>
              <TableCell>
                <RunStatusBadge status={run.status} />
              </TableCell>
              <TableCell className="tabular-nums">{duration(t, run)}</TableCell>
              <TableCell className="tabular-nums">{run.offersSeen}</TableCell>
              <TableCell className="tabular-nums">{run.offersNew}</TableCell>
              <TableCell className="tabular-nums">{run.costsChanged}</TableCell>
              <TableCell className="tabular-nums">{run.offersMissing}</TableCell>
              <TableCell className="tabular-nums">{run.reviewsOpened}</TableCell>
              <TableCell className="tabular-nums">{run.productsRepriced}</TableCell>
              <TableCell className="text-sm">
                {run.errorCode ? <RunError code={run.errorCode} /> : '—'}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Pagination
        page={page}
        pageCount={pageCount}
        onPageChange={setPage}
        summary={t('suppliers.runs.total', { total: runs.data.total })}
        previousLabel={t('common.previous')}
        nextLabel={t('common.next')}
      />
    </div>
  );
}

/** How long a finished run took, in seconds; "—" while it runs. */
function duration(t: TFunction, run: SyncRun): string {
  if (!run.finishedAt) return '—';
  const seconds = Math.max(
    0,
    Math.round((new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000),
  );
  return t('suppliers.runs.seconds', { count: seconds });
}
