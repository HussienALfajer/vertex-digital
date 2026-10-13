import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { formatUsd, type SupplierDetail, type SupplierOrderMatch } from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  EmptyState,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@vertex-digital/ui';
import { ReceiptTextIcon, RefreshCwIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import type { StatementSearch } from './supplier-search';
import { statementOrdersQuery, statementTransactionsQuery } from './suppliers.queries';

/**
 * "كشف الحساب" (S16 SF3): the supplier's orders and wallet movements, read live one page at a
 * time (one read per 5 seconds per list; never stored). A supplier order matched to one of our
 * attempts links to our order with the attempt's state; an unmatched one is marked as a possible
 * double purchase; a match on a refunded order is marked too (edge case 20).
 */
export function StatementTab({
  supplier,
  search,
  onSearch,
}: {
  supplier: SupplierDetail;
  search: StatementSearch;
  onSearch: (next: StatementSearch) => void;
}) {
  const { t } = useTranslation();
  if (!supplier.capabilities.statement) {
    return <EmptyState icon={<ReceiptTextIcon />} title={t('suppliers.statement.unsupported')} />;
  }
  const list = search.list ?? 'orders';
  const page = search.spage ?? 1;
  const go = (next: StatementSearch) => onSearch(next);
  return (
    <div className="flex flex-col gap-4">
      <Tabs
        value={list}
        onValueChange={(value) => go(value === 'transactions' ? { list: 'transactions' } : {})}
      >
        <TabsList>
          <TabsTrigger value="orders">{t('suppliers.statement.orders')}</TabsTrigger>
          <TabsTrigger value="transactions">{t('suppliers.statement.transactions')}</TabsTrigger>
        </TabsList>
      </Tabs>
      {list === 'orders' ? (
        <OrdersList
          supplier={supplier}
          page={page}
          onPage={(next) => go({ spage: next > 1 ? next : undefined })}
        />
      ) : (
        <TransactionsList
          supplier={supplier}
          page={page}
          onPage={(next) => go({ list: 'transactions', spage: next > 1 ? next : undefined })}
        />
      )}
    </div>
  );
}

function OrdersList({
  supplier,
  page,
  onPage,
}: {
  supplier: SupplierDetail;
  page: number;
  onPage: (page: number) => void;
}) {
  const { t } = useTranslation();
  const orders = useQuery(statementOrdersQuery(supplier.code, page));
  return (
    <StatementFrame
      query={orders}
      page={page}
      onPage={onPage}
      empty={t('suppliers.statement.noOrders')}
    >
      {orders.data && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('suppliers.statement.columns.order')}</TableHead>
              <TableHead>{t('suppliers.statement.columns.offer')}</TableHead>
              <TableHead>{t('suppliers.statement.columns.quantity')}</TableHead>
              <TableHead>{t('suppliers.statement.columns.total')}</TableHead>
              <TableHead>{t('suppliers.statement.columns.status')}</TableHead>
              <TableHead>{t('suppliers.statement.columns.time')}</TableHead>
              <TableHead>{t('suppliers.statement.columns.match')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orders.data.items.map((order) => (
              <TableRow key={order.supplierOrderId}>
                <TableCell>
                  <bdi dir="ltr" className="text-sm">
                    {order.supplierOrderId}
                  </bdi>
                </TableCell>
                <TableCell>
                  <span className="flex flex-col gap-0.5">
                    {order.offerName && <bdi>{order.offerName}</bdi>}
                    {order.offerId && (
                      <bdi dir="ltr" className="text-xs text-muted-foreground">
                        {order.offerId}
                      </bdi>
                    )}
                    {!order.offerName && !order.offerId && '—'}
                  </span>
                </TableCell>
                <TableCell className="tabular-nums">{order.quantity ?? '—'}</TableCell>
                <TableCell>
                  <Money units={order.totalUsdUnits} />
                </TableCell>
                <TableCell>{order.status ? <bdi>{order.status}</bdi> : '—'}</TableCell>
                <TableCell className="text-sm">
                  {order.createdAt ? formatDateTime(order.createdAt) : '—'}
                </TableCell>
                <TableCell>
                  <MatchCell match={order.match} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </StatementFrame>
  );
}

function TransactionsList({
  supplier,
  page,
  onPage,
}: {
  supplier: SupplierDetail;
  page: number;
  onPage: (page: number) => void;
}) {
  const { t } = useTranslation();
  const transactions = useQuery(statementTransactionsQuery(supplier.code, page));
  return (
    <StatementFrame
      query={transactions}
      page={page}
      onPage={onPage}
      empty={t('suppliers.statement.noTransactions')}
    >
      {transactions.data && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('suppliers.statement.columns.type')}</TableHead>
              <TableHead>{t('suppliers.statement.columns.amount')}</TableHead>
              <TableHead>{t('suppliers.statement.columns.balanceAfter')}</TableHead>
              <TableHead>{t('suppliers.statement.columns.reference')}</TableHead>
              <TableHead>{t('suppliers.statement.columns.time')}</TableHead>
              <TableHead>{t('suppliers.statement.columns.match')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {transactions.data.items.map((item) => (
              <TableRow key={item.id}>
                <TableCell>{item.type ? <bdi>{item.type}</bdi> : '—'}</TableCell>
                <TableCell>
                  <Money units={item.amountUsdUnits} signed />
                </TableCell>
                <TableCell>
                  <Money units={item.balanceAfterUsdUnits} />
                </TableCell>
                <TableCell>
                  <span className="flex flex-col gap-0.5">
                    {item.reference ? <bdi className="text-sm">{item.reference}</bdi> : '—'}
                    {item.supplierOrderId && (
                      <bdi dir="ltr" className="text-xs text-muted-foreground">
                        {item.supplierOrderId}
                      </bdi>
                    )}
                  </span>
                </TableCell>
                <TableCell className="text-sm">
                  {item.createdAt ? formatDateTime(item.createdAt) : '—'}
                </TableCell>
                <TableCell>
                  {item.supplierOrderId ? (
                    <MatchCell match={item.match} />
                  ) : (
                    <span className="text-sm text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </StatementFrame>
  );
}

/** Loading, error with retry, empty, the table and paging by "previous" and "next". */
function StatementFrame({
  query,
  page,
  onPage,
  empty,
  children,
}: {
  query: {
    isPending: boolean;
    isError: boolean;
    isFetching: boolean;
    error: unknown;
    data?: { items: unknown[]; hasMore: boolean };
    refetch: () => unknown;
  };
  page: number;
  onPage: (page: number) => void;
  empty: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t('suppliers.statement.live')}</p>
        <Button
          variant="outline"
          size="sm"
          disabled={query.isFetching}
          onClick={() => query.refetch()}
        >
          <RefreshCwIcon />
          {t('suppliers.statement.refresh')}
        </Button>
      </div>
      {query.isPending && <Skeleton className="h-64 w-full" aria-hidden="true" />}
      {query.isError && <FormAlert>{errorMessage(t, query.error)}</FormAlert>}
      {query.data &&
        (query.data.items.length === 0 ? (
          <EmptyState icon={<ReceiptTextIcon />} title={empty} />
        ) : (
          children
        ))}
      {(page > 1 || query.data?.hasMore) && (
        <div className="flex items-center justify-between gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1 || query.isFetching}
            onClick={() => onPage(page - 1)}
          >
            {t('common.previous')}
          </Button>
          <span className="text-sm tabular-nums">{t('suppliers.statement.page', { page })}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={!query.data?.hasMore || query.isFetching}
            onClick={() => onPage(page + 1)}
          >
            {t('common.next')}
          </Button>
        </div>
      )}
    </div>
  );
}

function Money({ units, signed = false }: { units: number | null; signed?: boolean }) {
  if (units === null) return <span className="text-muted-foreground">—</span>;
  return (
    <bdi dir="ltr" className="font-medium tabular-nums">
      {signed && units > 0 ? '+' : ''}
      {formatUsd(units)}
    </bdi>
  );
}

/**
 * A supplier order matched to an attempt of ours: our order and the attempt's state; unmatched:
 * a possible double purchase (settled with an S13 supplier correction).
 */
export function MatchCell({ match }: { match: SupplierOrderMatch | null }) {
  const { t } = useTranslation();
  if (!match) return <Badge tone="danger">{t('suppliers.statement.unmatched')}</Badge>;
  return (
    <span className="flex flex-col items-start gap-1">
      <Link
        to="/orders/$id"
        params={{ id: match.orderId }}
        className="font-medium underline-offset-4 hover:underline"
      >
        <bdi dir="ltr">{match.orderNumber}</bdi>
      </Link>
      <span className="flex flex-wrap gap-1">
        <Badge tone="outline">{t(`orders.attempts.statuses.${match.attemptStatus}`)}</Badge>
        {(match.orderStatus === 'refunded' || match.orderStatus === 'partially_refunded') && (
          <Badge tone="warning">{t('suppliers.statement.matchedRefunded')}</Badge>
        )}
      </span>
    </span>
  );
}
