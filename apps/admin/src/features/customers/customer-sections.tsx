import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  type AdminCustomer,
  type AuditEntry,
  describeUserAgent,
  formatUsd,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@vertex-digital/ui';
import {
  InboxIcon,
  LifeBuoyIcon,
  MonitorSmartphoneIcon,
  PencilIcon,
  PinIcon,
  WalletIcon,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { formatDate, formatDateTime, formatSince, ltr } from '../../lib/format';
import { AuditDetailSheet } from '../audit/audit-detail-sheet';
import { actorLabel } from '../audit/audit-labels';
import { DepositTable } from '../deposits/deposits-page';
import { OrderTable } from '../orders/orders-page';
import { ticketListQuery } from '../support/support.queries';
import { TicketTable } from '../support/support-page';
import { LIMIT_SOURCE_KEYS } from './customer-labels';
import {
  customerDepositsQuery,
  customerHistoryQuery,
  customerOrdersQuery,
  customerSessionsQuery,
  customerSignInsQuery,
} from './customers.queries';

/*
 * The profile's tabs (S12 CS3–CS5): each reads its own route, with a skeleton while loading and
 * an error with retry.
 */

export function SectionSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      {[0, 1, 2, 3].map((row) => (
        <Skeleton key={row} className="h-12 w-full" />
      ))}
    </div>
  );
}

export function SectionError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-start gap-3">
      <FormAlert>{errorMessage(t, error)}</FormAlert>
      <Button variant="outline" onClick={onRetry}>
        {t('common.retry')}
      </Button>
    </div>
  );
}

function LoadMore({
  list,
}: {
  list: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown };
}) {
  const { t } = useTranslation();
  if (!list.hasNextPage) return null;
  return (
    <Button
      variant="outline"
      className="self-center"
      disabled={list.isFetchingNextPage}
      onClick={() => list.fetchNextPage()}
    >
      {list.isFetchingNextPage ? t('common.loadingMore') : t('common.loadMore')}
    </Button>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}

/** "الملخص": the account, the counts, the limits with their sources, the pinned note, the signals. */
export function SummarySection({
  customer,
  onEditLimits,
  onChangePriceList,
}: {
  customer: AdminCustomer;
  onEditLimits?: () => void;
  /** S20 AT2: absent for an archived customer. */
  onChangePriceList?: () => void;
}) {
  const { t } = useTranslation();
  const { counts, limits } = customer;
  const limitRows = [
    ['customers.limits.perDeposit', limits.effective.perDeposit],
    ['customers.limits.dailyDeposit', limits.effective.dailyDeposit],
    ['customers.limits.dailyPurchase', limits.effective.dailyPurchase],
  ] as const;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card className="gap-4">
        <CardTitle>{t('customers.summary.account')}</CardTitle>
        <dl className="grid grid-cols-2 gap-4">
          <Fact label={t('customers.summary.createdAt')}>{formatDate(customer.createdAt)}</Fact>
          <Fact label={t('customers.summary.age')}>{formatSince(customer.createdAt)}</Fact>
          <Fact label={t('customers.summary.email')}>
            {customer.emailVerified
              ? t('customers.summary.verified')
              : t('customers.summary.unverified')}
          </Fact>
          <Fact label={t('customers.summary.tier')}>
            <Badge tone={customer.established ? 'success' : 'warning'}>
              {customer.established
                ? t('customers.summary.established')
                : t('customers.summary.new')}
            </Badge>
          </Fact>
        </dl>
      </Card>
      <Card className="gap-4">
        <CardTitle>{t('customers.summary.counts')}</CardTitle>
        <dl className="grid grid-cols-2 gap-4 tabular-nums">
          <Fact label={t('customers.summary.delivered')}>
            {t('customers.summary.countTotal', {
              count: counts.deliveredOrders,
              total: ltr(formatUsd(counts.deliveredTotalUsdUnits)),
            })}
          </Fact>
          <Fact label={t('customers.summary.credited')}>
            {t('customers.summary.countTotal', {
              count: counts.creditedDeposits,
              total: ltr(formatUsd(counts.creditedTotalUsdUnits)),
            })}
          </Fact>
          <Fact label={t('customers.summary.refunded')}>{counts.refundedOrders}</Fact>
          <Fact label={t('customers.summary.reservations')}>{counts.reservations}</Fact>
          <Fact label={t('customers.summary.openTickets')}>{counts.openTickets}</Fact>
          <Fact label={t('customers.summary.sessions')}>{counts.activeSessions}</Fact>
          {/* S15: devices of unexpired sessions with push on. */}
          <Fact label={t('customers.summary.push')}>
            {counts.pushDevices > 0
              ? t('customers.summary.pushOn', { count: counts.pushDevices })
              : t('customers.summary.pushOff')}
          </Fact>
        </dl>
      </Card>
      <Card className="gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>{t('customers.limits.title')}</CardTitle>
          {onEditLimits && (
            <Button variant="outline" size="sm" onClick={onEditLimits}>
              <PencilIcon />
              {t('customers.actions.limits')}
            </Button>
          )}
        </div>
        <dl className="flex flex-col gap-3">
          {limitRows.map(([label, limit]) => (
            <div key={label} className="flex flex-wrap items-center justify-between gap-2">
              <dt className="text-muted-foreground">{t(label)}</dt>
              <dd className="flex items-center gap-2">
                <span className="font-medium tabular-nums">
                  {limit.units === null ? (
                    t('customers.limits.noCap')
                  ) : (
                    <bdi dir="ltr">{formatUsd(limit.units)}</bdi>
                  )}
                </span>
                <Badge tone={limit.source === 'custom' ? 'gold' : 'neutral'}>
                  {t(LIMIT_SOURCE_KEYS[limit.source])}
                </Badge>
              </dd>
            </div>
          ))}
        </dl>
      </Card>
      <Card className="gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>{t('customers.pricing.title')}</CardTitle>
          {onChangePriceList && (
            <Button variant="outline" size="sm" onClick={onChangePriceList}>
              <PencilIcon />
              {t('customers.pricing.change')}
            </Button>
          )}
        </div>
        <dl className="grid grid-cols-2 gap-4">
          <Fact label={t('customers.pricing.accountType')}>
            {t(`customers.pricing.accountTypes.${customer.pricing.accountType}`)}
          </Fact>
          <Fact label={t('customers.pricing.list')}>
            <span className="flex flex-wrap items-center gap-2">
              <Link
                to="/pricing/lists/$id"
                params={{ id: customer.pricing.effectiveList.id }}
                className="underline-offset-4 hover:underline"
              >
                {customer.pricing.effectiveList.name}
              </Link>
              <Badge tone={customer.pricing.assignedListId ? 'gold' : 'neutral'}>
                {customer.pricing.assignedListId
                  ? t('customers.pricing.assigned')
                  : t('customers.pricing.default')}
              </Badge>
            </span>
          </Fact>
          <Fact label={t('customers.pricing.kind')}>
            {t(`customers.pricing.kinds.${customer.pricing.priceKind}`)}
          </Fact>
        </dl>
      </Card>
      <Card className="gap-4">
        <CardTitle>{t('customers.summary.pinned')}</CardTitle>
        {customer.pinnedNote ? (
          <div className="flex flex-col gap-2">
            <p className="flex items-start gap-2 whitespace-pre-wrap break-words">
              <PinIcon className="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span>{customer.pinnedNote.body}</span>
            </p>
            <span className="text-sm text-muted-foreground">
              {formatDateTime(customer.pinnedNote.createdAt)}
            </span>
          </div>
        ) : (
          <p className="text-muted-foreground">{t('customers.summary.noPinned')}</p>
        )}
      </Card>
      <SignalsCard customer={customer} />
    </div>
  );
}

/** Rule CS5: shared phone and shared IP, with links and the NAT hint; never acted on. */
function SignalsCard({ customer }: { customer: AdminCustomer }) {
  const { t } = useTranslation();
  const { sharedPhone, sharedIp } = customer.signals;
  const none = sharedPhone.count === 0 && sharedIp.count === 0;
  return (
    <Card className="gap-4 lg:col-span-2">
      <CardHeader>
        <CardTitle>{t('customers.signals.title')}</CardTitle>
        <CardDescription>{t('customers.signals.hint')}</CardDescription>
      </CardHeader>
      {none && <p className="text-muted-foreground">{t('customers.signals.none')}</p>}
      {sharedPhone.count > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="font-medium text-status-warning-foreground">
            {t('customers.signals.sharedPhone', { count: sharedPhone.count })}
          </h3>
          <OtherCustomers
            customers={sharedPhone.customers}
            more={sharedPhone.count - sharedPhone.customers.length}
          />
        </div>
      )}
      {sharedIp.count > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="font-medium text-status-warning-foreground">
            {t('customers.signals.sharedIp', { count: sharedIp.count })}
          </h3>
          <p className="text-sm text-muted-foreground">{t('customers.signals.natHint')}</p>
          <OtherCustomers
            customers={sharedIp.customers}
            more={sharedIp.count - sharedIp.customers.length}
          />
        </div>
      )}
    </Card>
  );
}

function OtherCustomers({
  customers,
  more,
}: {
  customers: { id: string; name: string; email: string; ipAddresses?: string[] }[];
  more: number;
}) {
  const { t } = useTranslation();
  return (
    <ul className="flex flex-col divide-y divide-border text-sm">
      {customers.map((other) => (
        <li key={other.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
          <Link
            to="/customers/$id"
            params={{ id: other.id }}
            className="rounded-sm font-medium underline-offset-4 hover:underline"
          >
            {other.name}
          </Link>
          <span dir="ltr" className="text-muted-foreground">
            {other.email}
          </span>
          {other.ipAddresses && other.ipAddresses.length > 0 && (
            <span dir="ltr" className="text-muted-foreground tabular-nums">
              {other.ipAddresses.join(', ')}
            </span>
          )}
        </li>
      ))}
      {more > 0 && (
        <li className="py-2 text-muted-foreground">
          {t('customers.signals.more', { count: more })}
        </li>
      )}
    </ul>
  );
}

/** "المحفظة": the balance and the S02 wallet page. */
export function WalletSection({ customer }: { customer: AdminCustomer }) {
  const { t } = useTranslation();
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>{t('customers.wallet.title')}</CardTitle>
        <CardDescription>{t('customers.wallet.body')}</CardDescription>
      </CardHeader>
      <p className="text-3xl font-bold tabular-nums">
        <bdi dir="ltr">{formatUsd(customer.balanceUnits)}</bdi>
      </p>
      <Button
        className="self-start"
        render={<Link to="/wallets/$customerId" params={{ customerId: customer.id }} />}
      >
        <WalletIcon />
        {t('customers.wallet.open')}
      </Button>
    </Card>
  );
}

/** "الطلبات": the S08 list filtered to the customer. */
export function OrdersSection({ customerId }: { customerId: string }) {
  const { t } = useTranslation();
  const list = useInfiniteQuery(customerOrdersQuery(customerId));
  const orders = list.data?.pages.flatMap((page) => page.items) ?? [];
  if (list.isPending) return <SectionSkeleton />;
  if (list.isError) return <SectionError error={list.error} onRetry={() => list.refetch()} />;
  if (orders.length === 0) {
    return <EmptyState icon={<InboxIcon />} title={t('customers.lists.noOrders')} />;
  }
  return (
    <>
      <OrderTable orders={orders} withCustomer={false} />
      <LoadMore list={list} />
    </>
  );
}

/** "الإيداعات": the S03 list filtered to the customer, both methods. */
export function DepositsSection({ customerId }: { customerId: string }) {
  const { t } = useTranslation();
  const list = useInfiniteQuery(customerDepositsQuery(customerId));
  const deposits = list.data?.pages.flatMap((page) => page.items) ?? [];
  if (list.isPending) return <SectionSkeleton />;
  if (list.isError) return <SectionError error={list.error} onRetry={() => list.refetch()} />;
  if (deposits.length === 0) {
    return <EmptyState icon={<InboxIcon />} title={t('customers.lists.noDeposits')} />;
  }
  return (
    <>
      <DepositTable deposits={deposits} tab="all" withCustomer={false} />
      <LoadMore list={list} />
    </>
  );
}

/** "التذاكر": the queue filtered to the customer, every status. */
export function TicketsSection({ customerId }: { customerId: string }) {
  const { t } = useTranslation();
  const list = useInfiniteQuery(ticketListQuery({ status: 'all', customerId }));
  const tickets = list.data?.pages.flatMap((page) => page.items) ?? [];
  if (list.isPending) return <SectionSkeleton />;
  if (list.isError) return <SectionError error={list.error} onRetry={() => list.refetch()} />;
  if (tickets.length === 0) {
    return <EmptyState icon={<LifeBuoyIcon />} title={t('customers.lists.noTickets')} />;
  }
  return (
    <>
      <TicketTable tickets={tickets} withCustomer={false} />
      <LoadMore list={list} />
    </>
  );
}

/** "الأجهزة": the active sessions and the sign-in log (the last 50 first). */
export function DevicesSection({ customerId }: { customerId: string }) {
  const { t } = useTranslation();
  const sessions = useQuery(customerSessionsQuery(customerId));
  const signIns = useInfiniteQuery(customerSignInsQuery(customerId));
  const rows = signIns.data?.pages.flatMap((page) => page.items) ?? [];
  const device = (userAgent: string | null) => {
    const { browser, system } = describeUserAgent(userAgent);
    const unknown = t('common.unknown');
    return t('customers.devices.device', {
      browser: browser === 'Unknown' ? unknown : browser,
      system: system === 'Unknown' ? unknown : system,
    });
  };
  return (
    <div className="flex flex-col gap-6">
      <Card className="gap-4">
        <CardTitle>{t('customers.devices.sessions')}</CardTitle>
        {sessions.isPending && <SectionSkeleton />}
        {sessions.isError && (
          <SectionError error={sessions.error} onRetry={() => sessions.refetch()} />
        )}
        {sessions.data?.length === 0 && (
          <p className="text-muted-foreground">{t('customers.devices.noSessions')}</p>
        )}
        {sessions.data && sessions.data.length > 0 && (
          <ul className="flex flex-col divide-y divide-border">
            {sessions.data.map((session) => (
              <li key={session.id} className="flex items-start gap-3 py-3">
                <MonitorSmartphoneIcon
                  className="mt-0.5 size-5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="font-medium">{device(session.userAgent)}</span>
                  <span className="text-sm text-muted-foreground">
                    {t('customers.devices.started', { date: formatDateTime(session.createdAt) })}
                    {' · '}
                    {t('customers.devices.lastActive', {
                      date: formatDateTime(session.lastActiveAt),
                    })}
                  </span>
                  {session.ipAddress && (
                    <span dir="ltr" className="text-end text-sm text-muted-foreground">
                      {session.ipAddress}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-bold">{t('customers.devices.signIns')}</h2>
        {signIns.isPending && <SectionSkeleton />}
        {signIns.isError && (
          <SectionError error={signIns.error} onRetry={() => signIns.refetch()} />
        )}
        {signIns.isSuccess && rows.length === 0 && (
          <p className="text-muted-foreground">{t('customers.devices.noSignIns')}</p>
        )}
        {rows.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('customers.devices.columns.time')}</TableHead>
                <TableHead>{t('customers.devices.columns.device')}</TableHead>
                <TableHead>{t('customers.devices.columns.ip')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="whitespace-nowrap">
                    {formatDateTime(row.createdAt)}
                  </TableCell>
                  <TableCell>{device(row.userAgent)}</TableCell>
                  <TableCell className="tabular-nums">
                    <bdi dir="ltr">{row.ipAddress ?? '—'}</bdi>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <LoadMore list={signIns} />
      </section>
    </div>
  );
}

/** "السجل": the audit entries of the customer and its records, newest first, with their detail. */
export function HistorySection({ customerId }: { customerId: string }) {
  const { t } = useTranslation();
  const list = useInfiniteQuery(customerHistoryQuery(customerId));
  const [open, setOpen] = useState<AuditEntry | null>(null);
  const entries = list.data?.pages.flatMap((page) => page.items) ?? [];
  if (list.isPending) return <SectionSkeleton />;
  if (list.isError) return <SectionError error={list.error} onRetry={() => list.refetch()} />;
  if (entries.length === 0) {
    return <EmptyState icon={<InboxIcon />} title={t('customers.history.empty')} />;
  }
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('audit.columns.time')}</TableHead>
            <TableHead>{t('audit.columns.actor')}</TableHead>
            <TableHead>{t('audit.columns.action')}</TableHead>
            <TableHead>{t('audit.columns.entity')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((entry) => (
            <TableRow key={entry.id} className="cursor-pointer" onClick={() => setOpen(entry)}>
              <TableCell className="whitespace-nowrap">
                {formatDateTime(entry.occurredAt)}
              </TableCell>
              <TableCell>{actorLabel(t, entry)}</TableCell>
              <TableCell>
                <button
                  type="button"
                  className="rounded-sm text-start font-medium text-foreground hover:underline"
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpen(entry);
                  }}
                >
                  {t(`audit.actions.${entry.action}`)}
                </button>
                {entry.reason && (
                  <span className="block text-sm whitespace-normal text-muted-foreground">
                    {entry.reason}
                  </span>
                )}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {t(`audit.entityTypes.${entry.entityType}`)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <LoadMore list={list} />
      <AuditDetailSheet entry={open} onClose={() => setOpen(null)} />
    </>
  );
}
