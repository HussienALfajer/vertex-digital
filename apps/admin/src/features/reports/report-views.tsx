import { Link } from '@tanstack/react-router';
import {
  type BreakdownReport,
  type CustomersReport,
  type DepositsReport,
  formatSyp,
  formatUsdCents,
  type LedgerReport,
  type RefundsReport,
  type Report,
  type ReportKind,
  type SalesReport,
} from '@vertex-digital/contracts';
import { Card, CardTitle, EmptyState, Sparkline } from '@vertex-digital/ui';
import type { TFunction } from 'i18next';
import { ChartNoAxesColumnIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDay, ltr } from '../../lib/format';
import { money, placeLabel } from '../reconciliation/reconciliation-labels';
import { type Column, ReportTable } from './report-table';

/*
 * R1–R6 as the panel shows them (S13 rules RP3–RP9): USD rounded half-up to the cent, pounds only
 * for R3's Sham Cash receipts and the places' own currency in R6, test customers' share apart.
 */

/** Rule RP9: dollars to the cent, kept whole inside a sentence. */
const usd = (units: number) => ltr(formatUsdCents(units));

const percent = (value: number | null) => (value === null ? '—' : ltr(`${value.toFixed(1)}%`));

const minutes = (t: TFunction, value: number | null) =>
  value === null ? '—' : t('reports.deposits.minutes', { count: Math.round(value) });

export function ReportView({ kind, report }: { kind: ReportKind; report: Report<ReportKind> }) {
  switch (kind) {
    case 'sales':
      return <SalesView report={report as SalesReport} />;
    case 'breakdown':
      return <BreakdownView report={report as BreakdownReport} />;
    case 'deposits':
      return <DepositsView report={report as DepositsReport} />;
    case 'refunds':
      return <RefundsView report={report as RefundsReport} />;
    case 'customers':
      return <CustomersView report={report as CustomersReport} />;
    default:
      return <LedgerView report={report as LedgerReport} />;
  }
}

function Empty() {
  const { t } = useTranslation();
  return <EmptyState icon={<ChartNoAxesColumnIcon />} title={t('reports.empty')} />;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="gap-4">
      <CardTitle>{title}</CardTitle>
      {children}
    </Card>
  );
}

/** R1 (rule RP3): by day, as the dashboard counts, with the daily lines above the table. */
function SalesView({ report }: { report: SalesReport }) {
  const { t } = useTranslation();
  if (report.totals.delivered === 0) {
    return (
      <>
        <Empty />
        <OwnerFunded figures={report.ownerFunded} />
      </>
    );
  }
  const columns: Column<SalesReport['rows'][number]>[] = [
    {
      id: 'date',
      label: t('reports.columns.date'),
      cell: (row) => formatDay(row.date),
      sort: (row) => row.date,
    },
    {
      id: 'delivered',
      label: t('reports.columns.delivered'),
      cell: (row) => row.delivered,
      sort: (row) => row.delivered,
      total: report.totals.delivered,
      numeric: true,
    },
    ...moneyColumns(t, report.totals),
  ];
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="gap-2">
          <CardTitle>{t('reports.columns.sales')}</CardTitle>
          <Sparkline
            values={report.rows.map((row) => row.salesUsdUnits)}
            label={t('reports.sales.salesLine')}
          />
        </Card>
        <Card className="gap-2">
          <CardTitle>{t('reports.columns.profit')}</CardTitle>
          <Sparkline
            values={report.rows.map((row) => row.profitUsdUnits)}
            label={t('reports.sales.profitLine')}
          />
        </Card>
      </div>
      <ReportTable
        rows={report.rows}
        columns={columns}
        rowKey={(row) => row.date}
        label={t('reports.kinds.sales')}
      />
      <OwnerFunded figures={report.ownerFunded} />
    </>
  );
}

type SalesFigures = SalesReport['totals'];

/**
 * S16 AP14: owner-funded orders, left out of the sales above, on their own line (value at store
 * prices, cost, profit); nothing without any.
 */
function OwnerFunded({ figures }: { figures: SalesFigures }) {
  const { t } = useTranslation();
  if (figures.delivered === 0 && figures.salesUsdUnits === 0) return null;
  return (
    <Card className="gap-3">
      <div className="flex flex-col gap-1">
        <CardTitle>{t('reports.ownerFunded.title')}</CardTitle>
        <p className="text-sm text-muted-foreground">{t('reports.ownerFunded.help')}</p>
      </div>
      <dl className="grid gap-4 sm:grid-cols-4">
        {(
          [
            ['delivered', String(figures.delivered)],
            ['value', usd(figures.salesUsdUnits)],
            ['cost', usd(figures.costUsdUnits)],
            ['profit', usd(figures.profitUsdUnits)],
          ] as const
        ).map(([key, value]) => (
          <div key={key} className="flex flex-col gap-1">
            <dt className="text-sm text-muted-foreground">{t(`reports.ownerFunded.${key}`)}</dt>
            <dd className="font-medium tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

/** Sales, cost, profit and margin: R1 and R2 share them. */
function moneyColumns<Row extends SalesFigures>(t: TFunction, totals: SalesFigures): Column<Row>[] {
  return [
    {
      id: 'sales',
      label: t('reports.columns.sales'),
      cell: (row) => usd(row.salesUsdUnits),
      sort: (row) => row.salesUsdUnits,
      total: usd(totals.salesUsdUnits),
      numeric: true,
    },
    {
      id: 'cost',
      label: t('reports.columns.cost'),
      cell: (row) => usd(row.costUsdUnits),
      sort: (row) => row.costUsdUnits,
      total: usd(totals.costUsdUnits),
      numeric: true,
    },
    {
      id: 'profit',
      label: t('reports.columns.profit'),
      cell: (row) => usd(row.profitUsdUnits),
      sort: (row) => row.profitUsdUnits,
      total: usd(totals.profitUsdUnits),
      numeric: true,
    },
    {
      id: 'margin',
      label: t('reports.columns.margin'),
      cell: (row) => percent(row.marginPercent),
      sort: (row) => row.marginPercent ?? -Infinity,
      total: percent(totals.marginPercent),
      numeric: true,
    },
  ];
}

/** R2 (rule RP4): by game, product or supplier, sorted by sales. */
function BreakdownView({ report }: { report: BreakdownReport }) {
  const { t } = useTranslation();
  if (report.rows.length === 0) {
    return (
      <>
        <Empty />
        <OwnerFunded figures={report.ownerFunded} />
      </>
    );
  }
  type Row = BreakdownReport['rows'][number];
  const columns: Column<Row>[] = [
    {
      id: 'name',
      label: t(`reports.breakdown.by.${report.by}`),
      sort: (row) => row.nameAr,
      cell: (row) =>
        row.gameId ? (
          <Link
            to="/catalog/games/$id"
            params={{ id: row.gameId }}
            className="underline-offset-4 hover:underline"
          >
            {row.nameAr}
            {row.gameNameAr && <span className="text-muted-foreground"> · {row.gameNameAr}</span>}
          </Link>
        ) : row.supplier ? (
          <Link
            to="/suppliers/$code"
            params={{ code: row.supplier }}
            className="underline-offset-4 hover:underline"
          >
            {row.nameAr}
          </Link>
        ) : (
          row.nameAr
        ),
    },
    {
      id: 'delivered',
      label: t('reports.columns.delivered'),
      cell: (row) => row.delivered,
      sort: (row) => row.delivered,
      total: report.totals.delivered,
      numeric: true,
    },
    {
      id: 'units',
      label: t('reports.columns.units'),
      cell: (row) => row.deliveredUnits,
      sort: (row) => row.deliveredUnits,
      total: report.totals.deliveredUnits,
      numeric: true,
    },
    ...moneyColumns<Row>(t, report.totals),
  ];
  if (report.by === 'supplier') {
    columns.push(
      {
        id: 'sent',
        label: t('reports.columns.attemptsSent'),
        cell: (row) => row.attemptsSent ?? '—',
        sort: (row) => row.attemptsSent ?? 0,
        total: report.totals.attemptsSent ?? '—',
        numeric: true,
      },
      {
        id: 'failed',
        label: t('reports.columns.attemptsFailed'),
        cell: (row) => row.attemptsFailed ?? '—',
        sort: (row) => row.attemptsFailed ?? 0,
        total: report.totals.attemptsFailed ?? '—',
        numeric: true,
      },
      {
        id: 'failureRate',
        label: t('reports.columns.failureRate'),
        cell: (row) => percent(row.failureRatePercent),
        sort: (row) => row.failureRatePercent ?? -Infinity,
        total: percent(report.totals.failureRatePercent),
        numeric: true,
      },
    );
  }
  return (
    <>
      <ReportTable
        rows={report.rows}
        columns={columns}
        rowKey={(row) => row.key}
        label={t('reports.kinds.breakdown')}
      />
      <OwnerFunded figures={report.ownerFunded} />
    </>
  );
}

/** R3 (rule RP5): per method, with the manual deposits on their own line. */
function DepositsView({ report }: { report: DepositsReport }) {
  const { t } = useTranslation();
  const { totals, manualDeposits } = report;
  if (totals.credited + totals.rejected + totals.expired === 0 && manualDeposits.count === 0) {
    return <Empty />;
  }
  type Row = DepositsReport['rows'][number];
  const columns: Column<Row>[] = [
    {
      id: 'method',
      label: t('reports.columns.method'),
      cell: (row) => t(`wallets.methods.${row.method}`),
    },
    {
      id: 'credited',
      label: t('reports.columns.credited'),
      cell: (row) => row.credited,
      sort: (row) => row.credited,
      total: totals.credited,
      numeric: true,
    },
    {
      id: 'creditedUsd',
      label: t('reports.columns.creditedUsd'),
      cell: (row) => usd(row.creditedUsdUnits),
      sort: (row) => row.creditedUsdUnits,
      total: usd(totals.creditedUsdUnits),
      numeric: true,
    },
    {
      id: 'receivedSyp',
      label: t('reports.columns.receivedSyp'),
      cell: (row) =>
        row.receivedSypUnits === null
          ? '—'
          : t('rates.syp', { amount: formatSyp(row.receivedSypUnits) }),
      numeric: true,
    },
    {
      id: 'rejected',
      label: t('reports.columns.rejected'),
      cell: (row) => row.rejected,
      sort: (row) => row.rejected,
      total: totals.rejected,
      numeric: true,
    },
    {
      id: 'expired',
      label: t('reports.columns.expired'),
      cell: (row) => row.expired,
      sort: (row) => row.expired,
      total: totals.expired,
      numeric: true,
    },
    {
      id: 'review',
      label: t('reports.columns.medianReview'),
      cell: (row) => minutes(t, row.medianReviewMinutes),
      numeric: true,
    },
  ];
  return (
    <>
      <ReportTable
        rows={report.rows}
        columns={columns}
        rowKey={(row) => row.method}
        label={t('reports.kinds.deposits')}
      />
      <p className="text-sm">
        {t('reports.deposits.manual', {
          count: manualDeposits.count,
          amount: usd(manualDeposits.usdUnits),
        })}
      </p>
    </>
  );
}

/** R4 (rule RP6): refunds by reason, the refund rate per product, the failure rate per supplier. */
function RefundsView({ report }: { report: RefundsReport }) {
  const { t } = useTranslation();
  if (
    report.byReason.length === 0 &&
    report.products.length === 0 &&
    report.suppliers.length === 0
  ) {
    return <Empty />;
  }
  return (
    <>
      <Section title={t('reports.refunds.byReason')}>
        <ReportTable
          rows={report.byReason}
          rowKey={(row) => row.reason}
          label={t('reports.refunds.byReason')}
          columns={[
            {
              id: 'reason',
              label: t('reports.columns.reason'),
              cell: (row) => t(`orders.refundReasons.${row.reason}`),
            },
            {
              id: 'orders',
              label: t('reports.columns.orders'),
              cell: (row) => row.orders,
              sort: (row) => row.orders,
              total: report.totals.orders,
              numeric: true,
            },
            {
              id: 'usd',
              label: t('reports.columns.refundedUsd'),
              cell: (row) => usd(row.usdUnits),
              sort: (row) => row.usdUnits,
              total: usd(report.totals.usdUnits),
              numeric: true,
            },
          ]}
        />
      </Section>
      <Section title={t('reports.refunds.products')}>
        <ReportTable
          rows={report.products}
          rowKey={(row) => row.productId}
          label={t('reports.refunds.products')}
          totals={false}
          columns={[
            {
              id: 'product',
              label: t('reports.breakdown.by.product'),
              sort: (row) => row.nameAr,
              cell: (row) => (
                <Link
                  to="/catalog/games/$id"
                  params={{ id: row.gameId }}
                  className="underline-offset-4 hover:underline"
                >
                  {row.nameAr}
                  <span className="text-muted-foreground"> · {row.gameNameAr}</span>
                </Link>
              ),
            },
            {
              id: 'finished',
              label: t('reports.columns.finished'),
              cell: (row) => row.finished,
              sort: (row) => row.finished,
              numeric: true,
            },
            {
              id: 'refunded',
              label: t('reports.columns.refunded'),
              cell: (row) => row.refunded,
              sort: (row) => row.refunded,
              numeric: true,
            },
            {
              id: 'rate',
              label: t('reports.columns.refundRate'),
              cell: (row) => percent(row.refundRatePercent),
              sort: (row) => row.refundRatePercent ?? -Infinity,
              numeric: true,
            },
          ]}
        />
      </Section>
      <Section title={t('reports.refunds.suppliers')}>
        <ReportTable
          rows={report.suppliers}
          rowKey={(row) => row.supplier}
          label={t('reports.refunds.suppliers')}
          totals={false}
          columns={[
            {
              id: 'supplier',
              label: t('reports.breakdown.by.supplier'),
              cell: (row) => row.nameAr,
            },
            {
              id: 'resolved',
              label: t('reports.columns.resolved'),
              cell: (row) => row.resolved,
              sort: (row) => row.resolved,
              numeric: true,
            },
            {
              id: 'failed',
              label: t('reports.columns.attemptsFailed'),
              cell: (row) => row.failed,
              sort: (row) => row.failed,
              numeric: true,
            },
            {
              id: 'rate',
              label: t('reports.columns.failureRate'),
              cell: (row) => percent(row.failureRatePercent),
              sort: (row) => row.failureRatePercent ?? -Infinity,
              numeric: true,
            },
          ]}
        />
      </Section>
    </>
  );
}

/** R5 (rule RP7): the top customers by sales; name and email only, linked to the profile. */
function CustomersView({ report }: { report: CustomersReport }) {
  const { t } = useTranslation();
  if (report.rows.length === 0) return <Empty />;
  const { totals } = report;
  return (
    <ReportTable
      rows={report.rows}
      rowKey={(row) => row.customerId}
      label={t('reports.kinds.customers')}
      columns={[
        {
          id: 'name',
          label: t('reports.columns.customer'),
          sort: (row) => row.name,
          cell: (row) => (
            <Link
              to="/customers/$id"
              params={{ id: row.customerId }}
              className="flex flex-col underline-offset-4 hover:underline"
            >
              <span className="font-medium">{row.name}</span>
              <span className="text-sm text-muted-foreground" dir="ltr">
                {row.email}
              </span>
            </Link>
          ),
        },
        {
          id: 'delivered',
          label: t('reports.columns.delivered'),
          cell: (row) => row.delivered,
          sort: (row) => row.delivered,
          total: totals.delivered,
          numeric: true,
        },
        {
          id: 'sales',
          label: t('reports.columns.sales'),
          cell: (row) => usd(row.salesUsdUnits),
          sort: (row) => row.salesUsdUnits,
          total: usd(totals.salesUsdUnits),
          numeric: true,
        },
        {
          id: 'profit',
          label: t('reports.columns.profit'),
          cell: (row) => usd(row.profitUsdUnits),
          sort: (row) => row.profitUsdUnits,
          total: usd(totals.profitUsdUnits),
          numeric: true,
        },
        {
          id: 'deposits',
          label: t('reports.columns.depositsUsd'),
          cell: (row) => usd(row.depositsUsdUnits),
          sort: (row) => row.depositsUsdUnits,
          total: usd(totals.depositsUsdUnits),
          numeric: true,
        },
      ]}
    />
  );
}

type LedgerLine = LedgerReport['totals'][number];

/** A line of R6 with its deposit method or adjustment category. */
function lineLabel(t: TFunction, line: LedgerLine): string {
  const name = t(`reports.ledger.lines.${line.line}`);
  if (!line.detail) return name;
  const detail =
    line.line === 'deposit'
      ? t(`wallets.methods.${line.detail as 'sham_cash'}`)
      : t(`wallets.categories.${line.detail as 'compensation'}`);
  return `${name} · ${detail}`;
}

/** R6 (rule RP8): the ledger by day, the period's totals per line and each place's start and end. */
function LedgerView({ report }: { report: LedgerReport }) {
  const { t } = useTranslation();
  if (report.rows.length === 0) return <Empty />;
  const lineColumns = (withDate: boolean): Column<LedgerLine & { date?: string }>[] => [
    ...(withDate
      ? [
          {
            id: 'date',
            label: t('reports.columns.date'),
            cell: (row: LedgerLine & { date?: string }) => (row.date ? formatDay(row.date) : ''),
            sort: (row: LedgerLine & { date?: string }) => row.date ?? '',
          },
        ]
      : []),
    {
      id: 'line',
      label: t('reports.columns.line'),
      cell: (row) => lineLabel(t, row),
      sort: (row) => lineLabel(t, row),
    },
    {
      id: 'usd',
      label: t('reports.columns.amount'),
      cell: (row) => usd(row.usdUnits),
      sort: (row) => row.usdUnits,
      numeric: true,
    },
    {
      id: 'test',
      label: t('reports.columns.testShare'),
      cell: (row) => (row.testUsdUnits === null ? '—' : usd(row.testUsdUnits)),
      numeric: true,
    },
  ];
  const key = (row: LedgerLine & { date?: string }) =>
    `${row.date ?? ''}:${row.line}:${row.detail ?? ''}`;
  return (
    <>
      <Section title={t('reports.ledger.totals')}>
        <ReportTable
          rows={report.totals}
          columns={lineColumns(false)}
          rowKey={key}
          label={t('reports.ledger.totals')}
          totals={false}
        />
      </Section>
      <Section title={t('reports.ledger.places')}>
        <ReportTable
          rows={report.places}
          rowKey={(row) => row.place}
          label={t('reports.ledger.places')}
          totals={false}
          columns={[
            {
              id: 'place',
              label: t('reconciliation.places.place'),
              cell: (row) => placeLabel(t, row.place),
            },
            {
              id: 'start',
              label: t('reports.ledger.start'),
              cell: (row) =>
                row.currency === 'USD'
                  ? usd(row.startUnits)
                  : money(t, row.currency, row.startUnits),
              numeric: true,
            },
            {
              id: 'end',
              label: t('reports.ledger.end'),
              cell: (row) =>
                row.currency === 'USD' ? usd(row.endUnits) : money(t, row.currency, row.endUnits),
              numeric: true,
            },
          ]}
        />
      </Section>
      <p className="text-sm text-muted-foreground">
        {t('reports.ledger.ownerDrawings', {
          start: usd(report.ownerDrawings.startUnits),
          end: usd(report.ownerDrawings.endUnits),
        })}
      </p>
      <Section title={t('reports.ledger.daily')}>
        <ReportTable
          rows={report.rows}
          columns={lineColumns(true)}
          rowKey={key}
          label={t('reports.ledger.daily')}
          totals={false}
        />
      </Section>
    </>
  );
}
