import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { formatUsdCents, type MerchantTierReport } from '@vertex-digital/contracts';
import {
  Button,
  EmptyState,
  Field,
  FieldLabel,
  Input,
  PageHeader,
  Skeleton,
  toast,
} from '@vertex-digital/ui';
import { ArrowRightIcon, CircleAlertIcon, DownloadIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '../../lib/errors';
import { formatDateTime, ltr } from '../../lib/format';
import { TierChip } from '../merchants/tier-chip';
import { type TierReportSearch, tierReportMonth } from './report-search';
import { type Column, ReportTable } from './report-table';
import { merchantTierReportQuery, useExportMerchantTierReport } from './reports.queries';

type Row = MerchantTierReport['rows'][number];

const usd = (units: number) => ltr(formatUsdCents(units));

/**
 * "حسب فئة التاجر" (S23 AD4): for a month, per tier the merchants holding it at the month's end
 * (today for the current month) and their net purchases, the sales, cost and profit of the orders
 * priced by the tier's list, and the rises and falls; test merchants left out. Excel as S13's.
 */
export function MerchantTierReportPage({
  search,
  onSearch,
}: {
  search: TierReportSearch;
  onSearch: (search: TierReportSearch) => void;
}) {
  const { t } = useTranslation();
  const month = tierReportMonth(search, new Date());
  const report = useQuery(merchantTierReportQuery(month));
  const exporter = useExportMerchantTierReport();
  const sum = (pick: (row: Row) => number) =>
    (report.data?.rows ?? []).reduce((total, row) => total + pick(row), 0);
  const columns: Column<Row>[] = [
    {
      id: 'tier',
      label: t('reports.merchantTiers.tier'),
      cell: (row) => <TierChip tier={row.tier} />,
      total: t('reports.totals'),
    },
    {
      id: 'merchants',
      label: t('reports.merchantTiers.merchants'),
      cell: (row) => row.merchants,
      sort: (row) => row.merchants,
      total: sum((row) => row.merchants),
      numeric: true,
    },
    {
      id: 'net',
      label: t('reports.merchantTiers.net'),
      cell: (row) => usd(row.netPurchasesUsdUnits),
      sort: (row) => row.netPurchasesUsdUnits,
      total: usd(sum((row) => row.netPurchasesUsdUnits)),
      numeric: true,
    },
    {
      id: 'delivered',
      label: t('reports.merchantTiers.delivered'),
      cell: (row) => row.delivered,
      sort: (row) => row.delivered,
      total: sum((row) => row.delivered),
      numeric: true,
    },
    {
      id: 'sales',
      label: t('reports.merchantTiers.sales'),
      cell: (row) => usd(row.salesUsdUnits),
      sort: (row) => row.salesUsdUnits,
      total: usd(sum((row) => row.salesUsdUnits)),
      numeric: true,
    },
    {
      id: 'profit',
      label: t('reports.merchantTiers.profit'),
      cell: (row) => usd(row.profitUsdUnits),
      sort: (row) => row.profitUsdUnits,
      total: usd(sum((row) => row.profitUsdUnits)),
      numeric: true,
    },
    {
      id: 'rises',
      label: t('reports.merchantTiers.rises'),
      cell: (row) => row.rises,
      sort: (row) => row.rises,
      total: sum((row) => row.rises),
      numeric: true,
    },
    {
      id: 'falls',
      label: t('reports.merchantTiers.falls'),
      cell: (row) => row.falls,
      sort: (row) => row.falls,
      total: sum((row) => row.falls),
      numeric: true,
    },
  ];

  return (
    <>
      <PageHeader
        title={t('reports.merchantTiers.title')}
        description={t('reports.merchantTiers.subtitle')}
        actions={
          <>
            <Button variant="ghost" render={<Link to="/reports" />}>
              <ArrowRightIcon aria-hidden="true" />
              {t('reports.title')}
            </Button>
            <Button
              variant="outline"
              disabled={exporter.isPending}
              onClick={() =>
                exporter.mutate(month, {
                  onError: (error) => toast.add({ title: errorMessage(t, error), type: 'error' }),
                })
              }
            >
              <DownloadIcon aria-hidden="true" />
              {exporter.isPending ? t('reports.exporting') : t('reports.export')}
            </Button>
          </>
        }
      />
      <Field className="max-w-56">
        <FieldLabel>{t('reports.merchantTiers.month')}</FieldLabel>
        <Input
          type="month"
          dir="ltr"
          value={month}
          onChange={(event) => {
            const value = event.target.value;
            if (/^\d{4}-\d{2}$/.test(value)) onSearch({ month: value });
          }}
        />
      </Field>
      {report.isPending && <Skeleton className="h-64 w-full" aria-hidden="true" />}
      {report.isError && !report.data && (
        <EmptyState
          icon={<CircleAlertIcon />}
          title={errorMessage(t, report.error)}
          action={
            <Button variant="outline" onClick={() => report.refetch()}>
              {t('common.retry')}
            </Button>
          }
        />
      )}
      {report.data && (
        <>
          <p className="text-sm text-muted-foreground">
            {report.data.current
              ? t('reports.merchantTiers.current')
              : t('reports.merchantTiers.ended')}{' '}
            {t('reports.merchantTiers.generated', {
              time: formatDateTime(report.data.generatedAt),
            })}
          </p>
          <ReportTable
            rows={report.data.rows}
            columns={columns}
            rowKey={(row) => row.tier}
            label={t('reports.merchantTiers.title')}
          />
        </>
      )}
    </>
  );
}
