import { useQuery } from '@tanstack/react-query';
import { Link, type LinkProps } from '@tanstack/react-router';
import {
  type AttentionItem,
  type AttentionKind,
  type Compared,
  type Dashboard,
  formatUsd,
  LIVE_COLUMNS,
  type LiveColumn,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Card,
  CardTitle,
  cn,
  EmptyState,
  PageHeader,
  Skeleton,
  Sparkline,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@vertex-digital/ui';
import type { TFunction } from 'i18next';
import {
  ArrowDownToLineIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CoinsIcon,
  HandIcon,
  HourglassIcon,
  type LucideIcon,
  ScaleIcon,
  SendIcon,
  ShieldAlertIcon,
  ToggleRightIcon,
  TriangleAlertIcon,
  TruckIcon,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdminStream, useDebounced, useVisibleAgain } from '../../lib/admin-stream';
import { useSession } from '../../lib/auth';
import { errorMessage } from '../../lib/errors';
import { formatDateTime, formatDuration, formatSince, ltr } from '../../lib/format';
import { dashboardQuery } from './dashboard.queries';

/** Rule DB9: a burst of order events is one read, ten seconds after the first. */
const EVENT_DEBOUNCE_MS = 10_000;
/** Data older than this (failed refetches) says when it was read. */
const STALE_AFTER_MS = 2 * 60_000;

const ATTENTION_ICONS: Record<AttentionKind, LucideIcon> = {
  orders_review: HourglassIcon,
  orders_manual: HandIcon,
  deposits_overdue: ArrowDownToLineIcon,
  deposits_flagged: ShieldAlertIcon,
  usdt_unmatched: CoinsIcon,
  supplier_down: TruckIcon,
  supplier_degraded: TruckIcon,
  supplier_balance_low: TruckIcon,
  supplier_sync_failing: TruckIcon,
  validation_quota_reached: TruckIcon,
  price_reviews: ScaleIcon,
  rate_stale: TriangleAlertIcon,
  switches_active: ToggleRightIcon,
  order_conflicts: TriangleAlertIcon,
  telegram_unlinked: SendIcon,
};

const HEALTH_TONES = { healthy: 'success', degraded: 'warning', down: 'danger' } as const;

/**
 * The panel's home page (S11, F18): what needs the admin first, then today against yesterday at
 * the same hour, the orders now, deposits, suppliers and the rate (rules DB1–DB8). Read every
 * minute, when the tab comes back, and ten seconds after order events (DB9).
 */
export function DashboardPage() {
  const { t } = useTranslation();
  const { user } = useSession();
  const dashboard = useQuery(dashboardQuery);
  const refetch = useDebounced(() => void dashboard.refetch(), EVENT_DEBOUNCE_MS);
  useAdminStream(refetch);
  useVisibleAgain(() => void dashboard.refetch());
  const now = useMinuteClock();
  const stale = dashboard.isSuccess && now - dashboard.dataUpdatedAt > STALE_AFTER_MS;

  return (
    <>
      <PageHeader
        title={t('home.title', { name: user.name })}
        description={
          stale
            ? t('dashboard.stale', {
                since: formatSince(new Date(dashboard.dataUpdatedAt).toISOString()),
              })
            : t('home.subtitle')
        }
      />
      {dashboard.isPending && <Loading />}
      {dashboard.isError && !dashboard.data && (
        <EmptyState
          icon={<CircleAlertIcon />}
          title={errorMessage(t, dashboard.error)}
          action={
            <Button variant="outline" onClick={() => dashboard.refetch()}>
              {t('common.retry')}
            </Button>
          }
        />
      )}
      {dashboard.data && <Content data={dashboard.data} />}
    </>
  );
}

/** Re-renders every 30 seconds, for the stale note. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function Loading() {
  return (
    <div className="flex flex-col gap-6" aria-hidden="true">
      <Skeleton className="h-28 w-full" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-36 w-full" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className="h-48 w-full" />
        ))}
      </div>
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

function Content({ data }: { data: Dashboard }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-6">
      <Attention items={data.attention} />
      <section
        aria-label={t('dashboard.kpis')}
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        <Kpi
          label={t('dashboard.sales')}
          value={formatUsd(data.sales.today)}
          compared={data.sales}
          format={formatUsd}
        >
          <Sparkline
            values={data.salesLine.map((point) => point.salesUsdUnits)}
            label={t('dashboard.salesLine', {
              values: data.salesLine.map((point) => formatUsd(point.salesUsdUnits)).join('، '),
            })}
          />
        </Kpi>
        <Kpi
          label={t('dashboard.profit')}
          value={formatUsd(data.profit.today)}
          compared={data.profit}
          format={formatUsd}
        >
          <p className="text-sm text-muted-foreground">
            {data.marginPercent === null
              ? t('dashboard.marginNone')
              : t('dashboard.margin', { percent: ltr(`${data.marginPercent}%`) })}
          </p>
        </Kpi>
        <Kpi
          label={t('dashboard.delivered')}
          value={String(data.delivered.today)}
          compared={data.delivered}
          format={String}
        />
        <Kpi
          label={t('dashboard.refunds')}
          value={String(data.refunds.today)}
          compared={data.refunds}
          format={String}
          upIsBad
        >
          <p className="text-sm text-muted-foreground">
            {t('dashboard.refundedAmount', { amount: ltr(formatUsd(data.refundedUsd.today)) })}
          </p>
        </Kpi>
      </section>
      <div className="grid gap-4 lg:grid-cols-3">
        <OrdersNow data={data} />
        <Deposits deposits={data.deposits} />
        <Rate rate={data.rate} />
      </div>
      <Suppliers suppliers={data.suppliers} />
    </div>
  );
}

function Attention({ items }: { items: AttentionItem[] }) {
  const { t } = useTranslation();
  return (
    <Card className="gap-3">
      <CardTitle>{t('dashboard.attention.title')}</CardTitle>
      {items.length === 0 ? (
        <p className="flex items-center gap-2 text-status-success-foreground">
          <CircleCheckIcon className="size-5" aria-hidden="true" />
          {t('dashboard.attention.none')}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {items.map((item) => {
            const Icon = ATTENTION_ICONS[item.kind];
            return (
              <li
                key={`${item.kind}:${item.params.supplier ?? item.params.switch ?? ''}`}
                className="flex flex-wrap items-center justify-between gap-3 py-2"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <Icon
                    className="size-5 shrink-0 text-status-warning-foreground"
                    aria-hidden="true"
                  />
                  <span className="flex flex-col">
                    <span className="font-medium">{attentionText(t, item)}</span>
                    {item.oldestAt && (
                      <span className="text-sm text-muted-foreground">
                        {t('dashboard.attention.oldest', { since: formatSince(item.oldestAt) })}
                      </span>
                    )}
                    {item.orders.length > 0 && (
                      <span className="flex flex-wrap gap-2 text-sm">
                        {item.orders.map((order) => (
                          <Link
                            key={order.id}
                            to="/orders/$id"
                            params={{ id: order.id }}
                            className="underline-offset-4 hover:underline"
                          >
                            <bdi dir="ltr">{order.number}</bdi>
                          </Link>
                        ))}
                      </span>
                    )}
                  </span>
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  render={<Link to={item.target as LinkProps['to']} />}
                >
                  {t('dashboard.attention.open')}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function attentionText(t: TFunction, item: AttentionItem): string {
  const name = item.params.nameAr ?? '';
  const switchName = item.params.switch
    ? t(`switches.names.${item.params.switch as 'purchases_stopped'}`)
    : '';
  return t(`dashboard.attention.kinds.${item.kind}`, {
    count: item.count,
    name,
    switch: switchName,
  });
}

function Delta({ compared, upIsBad = false }: { compared: Compared; upIsBad?: boolean }) {
  const { t } = useTranslation();
  const { deltaPercent } = compared;
  if (deltaPercent === null) {
    return (
      <span className="text-sm text-muted-foreground" title={t('dashboard.deltaNone')}>
        —
      </span>
    );
  }
  const good = upIsBad ? deltaPercent < 0 : deltaPercent > 0;
  const bad = upIsBad ? deltaPercent > 0 : deltaPercent < 0;
  return (
    <span
      className={cn(
        'text-sm font-medium tabular-nums',
        good && 'text-status-success-foreground',
        bad && 'text-destructive-text',
        !good && !bad && 'text-muted-foreground',
      )}
    >
      <bdi dir="ltr">{`${deltaPercent > 0 ? '+' : deltaPercent < 0 ? '−' : ''}${Math.abs(deltaPercent)}%`}</bdi>
    </span>
  );
}

function Kpi({
  label,
  value,
  compared,
  format,
  upIsBad,
  children,
}: {
  label: string;
  value: string;
  compared: Compared;
  format: (value: number) => string;
  upIsBad?: boolean;
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Card className="gap-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="flex items-baseline justify-between gap-2">
        <bdi dir="ltr" className="text-2xl font-bold tabular-nums">
          {value}
        </bdi>
        <Delta compared={compared} upIsBad={upIsBad} />
      </span>
      <span className="text-xs text-muted-foreground">
        {t('dashboard.yesterday', { value: ltr(format(compared.yesterday)) })}
      </span>
      {children}
    </Card>
  );
}

const NOW_COUNTS: Record<LiveColumn, keyof Dashboard['now']> = {
  at_supplier: 'atSupplier',
  manual: 'manual',
  review: 'review',
  finished: 'finished',
};

function OrdersNow({ data }: { data: Dashboard }) {
  const { t } = useTranslation();
  return (
    <Card className="gap-3">
      <CardTitle>{t('dashboard.now.title')}</CardTitle>
      <div className="flex flex-wrap gap-2">
        {LIVE_COLUMNS.map((column) => {
          const count = data.now[NOW_COUNTS[column]];
          return (
            <Badge
              key={column}
              tone={column === 'review' && count > 0 ? 'danger' : 'neutral'}
              render={<Link to="/orders/live" />}
            >
              {t(`orders.live.columns.${column}`)}: {count}
            </Badge>
          );
        })}
      </div>
      <dl className="flex flex-col gap-2 text-sm">
        <Line label={t('dashboard.now.awaitingBalance')}>{data.now.awaitingBalance}</Line>
        <Line label={t('dashboard.now.openValue')}>
          <bdi dir="ltr">{formatUsd(data.now.openValueUsdUnits)}</bdi>
        </Line>
        <Line label={t('dashboard.now.median')}>
          {data.medianDeliveryMs === null ? '—' : formatDuration(data.medianDeliveryMs)}
        </Line>
      </dl>
    </Card>
  );
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{children}</dd>
    </div>
  );
}

function Deposits({ deposits }: { deposits: Dashboard['deposits'] }) {
  const { t } = useTranslation();
  return (
    <Card className="gap-3">
      <CardTitle>{t('dashboard.deposits.title')}</CardTitle>
      <dl className="flex flex-col gap-2 text-sm">
        <Line label={t('dashboard.deposits.shamCashWaiting')}>
          <Link to="/deposits" className="underline-offset-4 hover:underline">
            {deposits.shamCashWaiting}
          </Link>
          {deposits.shamCashOldestAt && (
            <span className="block text-xs font-normal text-muted-foreground">
              {t('dashboard.attention.oldest', { since: formatSince(deposits.shamCashOldestAt) })}
            </span>
          )}
        </Line>
        <Line label={t('dashboard.deposits.flagged')}>{deposits.shamCashFlagged}</Line>
        <Line label={t('dashboard.deposits.usdtWaiting')}>{deposits.usdtWaiting}</Line>
        <Line label={t('dashboard.deposits.unmatched')}>
          <Link to="/deposits/transfers" className="underline-offset-4 hover:underline">
            {deposits.unmatchedTransfers}
          </Link>
        </Line>
      </dl>
      <h3 className="text-sm font-bold">{t('dashboard.deposits.creditedToday')}</h3>
      {deposits.creditedToday.every((item) => item.count === 0) ? (
        <p className="text-sm text-muted-foreground">{t('dashboard.deposits.noneToday')}</p>
      ) : (
        <dl className="flex flex-col gap-2 text-sm">
          {deposits.creditedToday
            .filter((item) => item.count > 0)
            .map((item) => (
              <Line key={item.method} label={t(`wallets.methods.${item.method}`)}>
                {t('dashboard.deposits.credited', {
                  count: item.count,
                  amount: ltr(formatUsd(item.usdUnits)),
                })}
              </Line>
            ))}
        </dl>
      )}
    </Card>
  );
}

function Rate({ rate }: { rate: Dashboard['rate'] }) {
  const { t } = useTranslation();
  return (
    <Card className="gap-3">
      <CardTitle>{t('dashboard.rate.title')}</CardTitle>
      {rate ? (
        <>
          <span className="text-2xl font-bold tabular-nums">
            {t('rates.current.value', { rate: rate.sypPerUsd })}
          </span>
          <span className="text-sm text-muted-foreground">
            {t('dashboard.rate.setAt', { date: formatDateTime(rate.setAt) })}
          </span>
          {rate.stale && <Badge tone="warning">{t('dashboard.rate.stale')}</Badge>}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{t('rates.current.none')}</p>
      )}
      <Button variant="outline" size="sm" className="w-fit" render={<Link to="/rates" />}>
        {t('dashboard.rate.open')}
      </Button>
    </Card>
  );
}

function Suppliers({ suppliers }: { suppliers: Dashboard['suppliers'] }) {
  const { t } = useTranslation();
  return (
    <Card className="gap-3">
      <CardTitle>{t('dashboard.suppliers.title')}</CardTitle>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('dashboard.suppliers.supplier')}</TableHead>
            <TableHead>{t('dashboard.suppliers.health')}</TableHead>
            <TableHead>{t('dashboard.suppliers.balance')}</TableHead>
            <TableHead>{t('dashboard.suppliers.lastSync')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {suppliers.map((supplier) => (
            <TableRow key={supplier.code}>
              <TableCell>
                <Link
                  to="/suppliers/$code"
                  params={{ code: supplier.code }}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {supplier.nameAr}
                </Link>
              </TableCell>
              <TableCell>
                <span className="flex flex-wrap items-center gap-1">
                  <Badge tone={HEALTH_TONES[supplier.health]}>
                    {t(`suppliers.health.${supplier.health}`)}
                  </Badge>
                  {supplier.paused && <Badge tone="warning">{t('suppliers.chips.paused')}</Badge>}
                </span>
                {supplier.healthSince && (
                  <span className="block text-xs text-muted-foreground">
                    {formatSince(supplier.healthSince)}
                  </span>
                )}
              </TableCell>
              <TableCell className="tabular-nums">
                {supplier.balanceUsdUnits === null ? (
                  '—'
                ) : (
                  <span className="flex flex-col">
                    <span className="flex items-center gap-2">
                      <bdi dir="ltr">{formatUsd(supplier.balanceUsdUnits)}</bdi>
                      {supplier.balanceLow && (
                        <Badge tone="danger">{t('dashboard.suppliers.low')}</Badge>
                      )}
                    </span>
                    {supplier.balanceAt && (
                      <span className="text-xs text-muted-foreground">
                        {formatSince(supplier.balanceAt)}
                      </span>
                    )}
                  </span>
                )}
              </TableCell>
              <TableCell>
                {supplier.lastSync ? (
                  <span className="flex flex-col">
                    <span
                      className={
                        supplier.lastSync.status === 'failed' ? 'text-destructive-text' : undefined
                      }
                    >
                      {t(`suppliers.runs.statuses.${supplier.lastSync.status}`)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatSince(supplier.lastSync.at)}
                    </span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">{t('suppliers.runs.never')}</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}
