import type { SupplierDetail } from '@vertex-digital/contracts';
import {
  Card,
  CardTitle,
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@vertex-digital/ui';
import { ActivityIcon, WalletIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatDateTime, formatSince, ltr } from '../../lib/format';
import { formatPercentBp } from '../pricing/pricing-format';
import { BalanceLine, balanceText, HealthBadge } from './supplier-parts';

/**
 * "الصحة" (S07 screens): the state and why, the window figures of the change that set it, its
 * history (rules H1–H4) and the balance reads (rule H5), the newest 20 of each.
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
              {t('suppliers.healthTab.reason', { reason: ltr(latest.reason) })}
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
                  <TableCell>
                    <bdi dir="ltr">{change.reason}</bdi>
                  </TableCell>
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
