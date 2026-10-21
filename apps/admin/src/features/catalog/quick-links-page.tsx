import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { formatUsd, QUICK_LINK_STATS_DAYS, type QuickLinkStats } from '@vertex-digital/contracts';
import {
  Button,
  EmptyState,
  PageHeader,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@vertex-digital/ui';
import { CircleAlertIcon, LinkIcon, XIcon } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '../../lib/errors';
import { type Column, ReportTable } from '../reports/report-table';
import { quickLinksQuery } from './catalog.queries';
import { QUICK_LINK_PERIODS, type QuickLinksSearch, quickLinksRange } from './quick-links-search';

type Row = QuickLinkStats['items'][number];

/**
 * "روابط الشراء المباشر" (S22 DL5): per pack and campaign over the chosen days (30 by default,
 * within the 90 kept), the opens, the paid orders and their total net of refunds; sortable, with a
 * totals row. Test customers' orders are left out by the API.
 */
export function QuickLinksPage({
  search,
  onSearch,
}: {
  search: QuickLinksSearch;
  onSearch: (next: QuickLinksSearch) => void;
}) {
  const { t } = useTranslation();
  const days = search.days ?? QUICK_LINK_STATS_DAYS;
  // The range is fixed when the period is chosen, so the query key stays stable.
  const range = useMemo(() => quickLinksRange(days), [days]);
  const stats = useQuery(quickLinksQuery({ ...range, productId: search.productId }));
  const rows = stats.data?.items ?? [];
  const sum = (pick: (row: Row) => number) => rows.reduce((total, row) => total + pick(row), 0);

  const columns: Column<Row>[] = [
    {
      id: 'product',
      label: t('catalog.quickLinks.columns.product'),
      cell: (row) => (
        <span className="flex flex-col">
          <bdi className="font-medium">{row.productNameAr}</bdi>
          <bdi className="text-xs text-muted-foreground">{row.gameNameAr}</bdi>
        </span>
      ),
      sort: (row) => row.productNameAr,
    },
    {
      id: 'code',
      label: t('catalog.quickLinks.columns.code'),
      cell: (row) => (
        <bdi dir="ltr" className="text-sm tabular-nums">
          {row.quickCode}
        </bdi>
      ),
    },
    {
      id: 'campaign',
      label: t('catalog.quickLinks.columns.campaign'),
      cell: (row) =>
        row.campaign ? (
          <bdi dir="ltr">{row.campaign}</bdi>
        ) : (
          <span className="text-muted-foreground">{t('catalog.quickLinks.noCampaign')}</span>
        ),
      sort: (row) => row.campaign ?? '',
    },
    {
      id: 'opens',
      label: t('catalog.quickLinks.columns.opens'),
      cell: (row) => row.opens.toLocaleString('en-US'),
      sort: (row) => row.opens,
      total: sum((row) => row.opens).toLocaleString('en-US'),
      numeric: true,
    },
    {
      id: 'orders',
      label: t('catalog.quickLinks.columns.orders'),
      cell: (row) => row.orders.toLocaleString('en-US'),
      sort: (row) => row.orders,
      total: sum((row) => row.orders).toLocaleString('en-US'),
      numeric: true,
    },
    {
      id: 'revenue',
      label: t('catalog.quickLinks.columns.revenue'),
      cell: (row) => <bdi dir="ltr">{formatUsd(row.revenueUsdUnits)}</bdi>,
      sort: (row) => row.revenueUsdUnits,
      total: <bdi dir="ltr">{formatUsd(sum((row) => row.revenueUsdUnits))}</bdi>,
      numeric: true,
    },
  ];

  return (
    <>
      <PageHeader
        title={t('catalog.quickLinks.title')}
        description={t('catalog.quickLinks.subtitle')}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Tabs
          value={String(days)}
          onValueChange={(value) =>
            onSearch({
              ...search,
              days: Number(value) === QUICK_LINK_STATS_DAYS ? undefined : Number(value),
            })
          }
        >
          <TabsList className="w-auto">
            {QUICK_LINK_PERIODS.map((period) => (
              <TabsTrigger key={period} value={String(period)}>
                {t(`catalog.quickLinks.period.${period}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {search.productId && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onSearch({ ...search, productId: undefined })}
          >
            <XIcon />
            {t('catalog.quickLinks.allProducts')}
          </Button>
        )}
      </div>
      {stats.isPending && (
        <div className="flex flex-col gap-2" aria-hidden="true">
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} className="h-12 w-full" />
          ))}
        </div>
      )}
      {stats.isError && (
        <EmptyState
          icon={<CircleAlertIcon />}
          title={errorMessage(t, stats.error)}
          action={
            <Button variant="outline" onClick={() => stats.refetch()}>
              {t('common.retry')}
            </Button>
          }
        />
      )}
      {stats.isSuccess && rows.length === 0 && (
        <EmptyState
          icon={<LinkIcon />}
          title={t('catalog.quickLinks.empty')}
          description={t('catalog.quickLinks.emptyHint')}
          action={
            <Button variant="outline" render={<Link to="/catalog" />}>
              {t('catalog.quickLinks.toCatalog')}
            </Button>
          }
        />
      )}
      {rows.length > 0 && (
        <ReportTable
          rows={rows}
          columns={columns}
          rowKey={(row) => `${row.productId}:${row.campaign ?? ''}`}
          label={t('catalog.quickLinks.title')}
        />
      )}
    </>
  );
}
