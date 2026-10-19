import { useQuery } from '@tanstack/react-query';
import type { SupplierDetail } from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Card,
  CardTitle,
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
import { ActivityIcon, CircleCheckIcon, WalletIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { formatDateTime, formatSince, ltr } from '../../lib/format';
import { formatPercentBp } from '../pricing/pricing-format';
import { healthReason } from './health-reason';
import { BalanceLine, balanceText, HealthBadge } from './supplier-parts';
import { callsQuery, LIST_PAGE_SIZE } from './suppliers.queries';

/**
 * "الصحة" (S07 screens): the state and why, the window figures of the change that set it, its
 * history (rules H1–H4) and the balance reads (rule H5), the newest 20 of each; S18 FK3: the calls
 * that failed and why, page by page, so an outage at the supplier is told from a network problem.
 */
export function HealthTab({ supplier }: { supplier: SupplierDetail }) {
  const { t } = useTranslation();
  const latest = supplier.healthHistory[0] ?? null;
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="gap-4">
          <CardTitle>{t('suppliers.healthTab.state')}</CardTitle>
          <span className="flex flex-wrap items-center gap-2">
            <HealthBadge health={supplier.health} />
            {supplier.healthSince && (
              <span className="text-sm text-muted-foreground">
                {t('suppliers.healthTab.since', { since: formatSince(supplier.healthSince) })}
              </span>
            )}
          </span>
          {latest ? (
            <dl className="grid grid-cols-3 gap-3 text-sm">
              <Figure label={t('suppliers.healthTab.calls')} value={latest.calls} />
              <Figure
                label={t('suppliers.healthTab.success')}
                value={latest.successBp === null ? null : `${formatPercentBp(latest.successBp)}%`}
              />
              <Figure
                label={t('suppliers.healthTab.p90')}
                value={
                  latest.p90Ms === null ? null : t('suppliers.healthTab.ms', { ms: latest.p90Ms })
                }
              />
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">{t('suppliers.healthTab.noChanges')}</p>
          )}
          {latest && (
            <p className="text-sm text-muted-foreground">
              {t('suppliers.healthTab.reason', { reason: reasonText(t, latest.reason) })}
            </p>
          )}
        </Card>
        {supplier.code !== 'manual' && (
          <Card className="gap-4">
            <CardTitle>{t('suppliers.balance.title')}</CardTitle>
            <BalanceLine supplier={supplier} />
          </Card>
        )}
      </div>
      {supplier.code !== 'manual' && <FailedCalls supplier={supplier} />}
      <section className="flex flex-col gap-3" aria-labelledby="health-history">
        <h2 id="health-history" className="text-lg font-bold">
          {t('suppliers.healthTab.history')}
        </h2>
        {supplier.healthHistory.length === 0 ? (
          <EmptyState icon={<ActivityIcon />} title={t('suppliers.healthTab.noChanges')} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('suppliers.healthTab.time')}</TableHead>
                <TableHead>{t('suppliers.healthTab.stateColumn')}</TableHead>
                <TableHead>{t('suppliers.healthTab.reasonColumn')}</TableHead>
                <TableHead>{t('suppliers.healthTab.calls')}</TableHead>
                <TableHead>{t('suppliers.healthTab.success')}</TableHead>
                <TableHead>{t('suppliers.healthTab.p90')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {supplier.healthHistory.map((change) => (
                <TableRow key={change.id}>
                  <TableCell className="whitespace-nowrap">
                    {formatDateTime(change.createdAt)}
                  </TableCell>
                  <TableCell>
                    <HealthBadge health={change.state} />
                  </TableCell>
                  <TableCell>{reasonText(t, change.reason)}</TableCell>
                  <TableCell className="tabular-nums">{change.calls ?? '—'}</TableCell>
                  <TableCell className="tabular-nums">
                    {change.successBp === null ? '—' : `${formatPercentBp(change.successBp)}%`}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {change.p90Ms === null
                      ? '—'
                      : t('suppliers.healthTab.ms', { ms: change.p90Ms })}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
      {supplier.code !== 'manual' && (
        <section className="flex flex-col gap-3" aria-labelledby="balance-history">
          <h2 id="balance-history" className="text-lg font-bold">
            {t('suppliers.healthTab.balances')}
          </h2>
          {supplier.balanceHistory.length === 0 ? (
            <EmptyState icon={<WalletIcon />} title={t('suppliers.balance.none')} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('suppliers.healthTab.time')}</TableHead>
                  <TableHead>{t('suppliers.healthTab.amount')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {supplier.balanceHistory.map((read) => (
                  <TableRow key={read.id}>
                    <TableCell className="whitespace-nowrap">
                      {formatDateTime(read.createdAt)}
                    </TableCell>
                    <TableCell className="font-medium tabular-nums">
                      <bdi dir="ltr">{balanceText(read)}</bdi>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      )}
    </div>
  );
}

/** S18 FK3: the calls with no trustworthy answer, newest first, with why. */
function FailedCalls({ supplier }: { supplier: SupplierDetail }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const calls = useQuery(callsQuery(supplier.code, page, 'error'));
  return (
    <section className="flex flex-col gap-3" aria-labelledby="failed-calls">
      <div className="flex flex-col gap-1">
        <h2 id="failed-calls" className="text-lg font-bold">
          {t('suppliers.healthTab.failedCalls')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('suppliers.healthTab.failedCallsHelp')}</p>
      </div>
      {calls.isPending && <Skeleton className="h-40 w-full" aria-hidden="true" />}
      {calls.isError && (
        <div className="flex flex-col items-start gap-3">
          <FormAlert>{errorMessage(t, calls.error)}</FormAlert>
          <Button variant="outline" onClick={() => calls.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {calls.isSuccess &&
        (calls.data.items.length === 0 ? (
          <EmptyState icon={<CircleCheckIcon />} title={t('suppliers.healthTab.noFailures')} />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="sticky start-0 z-10 bg-muted">
                    {t('suppliers.healthTab.time')}
                  </TableHead>
                  <TableHead>{t('suppliers.healthTab.operation')}</TableHead>
                  <TableHead>{t('suppliers.healthTab.failure')}</TableHead>
                  <TableHead>{t('suppliers.healthTab.httpStatus')}</TableHead>
                  <TableHead>{t('suppliers.healthTab.code')}</TableHead>
                  <TableHead>{t('suppliers.healthTab.latency')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {calls.data.items.map((call) => (
                  <TableRow key={call.id}>
                    <TableCell className="sticky start-0 z-10 whitespace-nowrap bg-surface">
                      {formatDateTime(call.createdAt)}
                    </TableCell>
                    <TableCell>{t(`suppliers.operations.${call.operation}`)}</TableCell>
                    <TableCell>
                      {call.failureKind ? (
                        <Badge tone="danger">{t(`suppliers.failures.${call.failureKind}`)}</Badge>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums">{call.httpStatus ?? '—'}</TableCell>
                    <TableCell>
                      {call.supplierCode ? <bdi dir="ltr">{call.supplierCode}</bdi> : '—'}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      <bdi dir="ltr">{t('suppliers.healthTab.ms', { ms: call.latencyMs })}</bdi>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {calls.data.total > LIST_PAGE_SIZE && (
              <Pagination
                page={page}
                pageCount={Math.ceil(calls.data.total / LIST_PAGE_SIZE)}
                onPageChange={setPage}
                summary={t('suppliers.healthTab.failedTotal', { total: calls.data.total })}
                previousLabel={t('common.previous')}
                nextLabel={t('common.next')}
              />
            )}
          </>
        ))}
    </section>
  );
}

function Figure({ label, value }: { label: string; value: string | number | null }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-lg font-bold tabular-nums">
        <bdi dir="ltr">{value ?? '—'}</bdi>
      </dd>
    </div>
  );
}

/** A health change's reason in Arabic, its figures kept whole (rules H1–H3). */
function reasonText(t: TFunction, reason: string): string {
  const { key, values } = healthReason(reason);
  const wrapped: Record<string, string> = Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name, ltr(value)]),
  );
  return t(`suppliers.healthTab.reasons.${key}`, { ...wrapped, defaultValue: '' });
}
