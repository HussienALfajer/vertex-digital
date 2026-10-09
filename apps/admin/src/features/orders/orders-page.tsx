import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  ADMIN_ORDER_TABS,
  type AdminOrderSummary,
  type AdminOrderTab,
  formatUsd,
  SUPPLIER_CODES,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  FieldLabel,
  Input,
  PageHeader,
  Pagination,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
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
import { InboxIcon, SlidersHorizontalIcon, XIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { formatDateTime, formatSince } from '../../lib/format';
import { STATUS_TONES } from './order-labels';
import { type OrderSearch, tabOf, withFilter } from './order-search';
import { orderListQuery } from './orders.queries';

const ALL = 'all';

/**
 * "الطلبات" (S08 screens): the tabs (every order, held for review, manual waiting, in progress,
 * delivered, refunded), the filters and search, the table, a page at a time; all in the URL.
 */
export function OrdersPage({
  search,
  onSearch,
}: {
  search: OrderSearch;
  onSearch: (search: OrderSearch) => void;
}) {
  const { t } = useTranslation();
  const list = useQuery(orderListQuery(search));
  const tab = tabOf(search);
  const orders = list.data?.items ?? [];

  return (
    <>
      <PageHeader
        title={t('orders.title')}
        description={t('orders.subtitle')}
        actions={
          <Button variant="outline" render={<Link to="/orders/policy" />}>
            <SlidersHorizontalIcon />
            {t('orders.policy.link')}
          </Button>
        }
      />
      <Tabs
        value={tab}
        onValueChange={(value) => onSearch(withFilter(search, { tab: value as AdminOrderTab }))}
      >
        <TabsList className="flex-wrap">
          {ADMIN_ORDER_TABS.map((item) => (
            <TabsTrigger key={item} value={item}>
              {t(`orders.tabs.${item}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {/* A new key resets the form when the URL changes (clear, back). */}
      <Filters key={JSON.stringify(search)} search={search} onSearch={onSearch} />
      {list.isPending && (
        <div className="flex flex-col gap-2" aria-hidden="true">
          {[0, 1, 2, 3].map((row) => (
            <Skeleton key={row} className="h-12 w-full" />
          ))}
        </div>
      )}
      {list.isError && (
        <div className="flex flex-col items-start gap-3">
          <FormAlert>{errorMessage(t, list.error)}</FormAlert>
          <Button variant="outline" onClick={() => list.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {list.isSuccess && orders.length === 0 && (
        <EmptyState icon={<InboxIcon />} title={t(`orders.empty.${tab}`)} />
      )}
      {list.isSuccess && orders.length > 0 && (
        <div className="flex flex-col gap-3">
          <OrderTable orders={orders} />
          <Pagination
            page={list.data.page}
            pageCount={Math.max(1, Math.ceil(list.data.total / list.data.pageSize))}
            onPageChange={(page) =>
              onSearch({ ...search, ...(page > 1 ? { page } : { page: undefined }) })
            }
            summary={t('orders.total', { total: list.data.total })}
            previousLabel={t('common.previous')}
            nextLabel={t('common.next')}
          />
        </div>
      )}
    </>
  );
}

function Filters({
  search,
  onSearch,
}: {
  search: OrderSearch;
  onSearch: (search: OrderSearch) => void;
}) {
  const { t } = useTranslation();
  const [supplier, setSupplier] = useState<string>(search.supplier ?? ALL);
  const [test, setTest] = useState<string>(search.test ?? ALL);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => {
      const value = String(form.get(name) ?? '').trim();
      return value === '' ? undefined : value;
    };
    onSearch(
      withFilter(search, {
        q: text('q'),
        from: text('from'),
        to: text('to'),
        supplier: supplier === ALL ? undefined : (supplier as OrderSearch['supplier']),
        test: test === ALL ? undefined : (test as OrderSearch['test']),
      }),
    );
  }

  return (
    <Card>
      <search>
        <form
          className="grid items-end gap-4 sm:grid-cols-2 lg:grid-cols-3"
          onSubmit={submit}
          noValidate
        >
          <Field>
            <FieldLabel>{t('orders.filters.search')}</FieldLabel>
            <Input
              name="q"
              type="search"
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              maxLength={100}
              placeholder={t('orders.filters.searchPlaceholder')}
              defaultValue={search.q}
            />
          </Field>
          <FilterSelect
            label={t('orders.filters.supplier')}
            value={supplier}
            onChange={setSupplier}
            options={SUPPLIER_CODES.map((code) => ({
              value: code,
              label: t(`orders.suppliers.${code}`),
            }))}
          />
          <FilterSelect
            label={t('orders.filters.test')}
            value={test}
            onChange={setTest}
            options={[
              { value: 'false', label: t('orders.filters.realOnly') },
              { value: 'true', label: t('orders.filters.testOnly') },
            ]}
          />
          <Field>
            <FieldLabel>{t('orders.filters.from')}</FieldLabel>
            <Input name="from" type="date" dir="ltr" defaultValue={search.from} />
          </Field>
          <Field>
            <FieldLabel>{t('orders.filters.to')}</FieldLabel>
            <Input name="to" type="date" dir="ltr" defaultValue={search.to} />
          </Field>
          <div className="flex flex-wrap items-end gap-2">
            <Button type="submit">{t('orders.filters.apply')}</Button>
            <Button variant="ghost" onClick={() => onSearch(search.tab ? { tab: search.tab } : {})}>
              {t('orders.filters.clear')}
            </Button>
          </div>
          {search.productId && (
            <div className="flex items-center gap-2 sm:col-span-2 lg:col-span-3">
              <Badge tone="info">{t('orders.filters.oneProduct')}</Badge>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onSearch(withFilter(search, { productId: undefined }))}
              >
                <XIcon />
                {t('orders.filters.clearProduct')}
              </Button>
            </div>
          )}
        </form>
      </search>
    </Card>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  const { t } = useTranslation();
  const items = [{ value: ALL, label: t('orders.filters.all') }, ...options];
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Select items={items} value={value} onValueChange={(next) => onChange(next ?? ALL)}>
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

function OrderTable({ orders }: { orders: AdminOrderSummary[] }) {
  const { t } = useTranslation();
  const now = new Date();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('orders.columns.number')}</TableHead>
          <TableHead>{t('orders.columns.customer')}</TableHead>
          <TableHead>{t('orders.columns.product')}</TableHead>
          <TableHead>{t('orders.columns.quantity')}</TableHead>
          <TableHead>{t('orders.columns.total')}</TableHead>
          <TableHead>{t('orders.columns.status')}</TableHead>
          <TableHead>{t('orders.columns.supplier')}</TableHead>
          <TableHead>{t('orders.columns.since')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {orders.map((order) => (
          <TableRow key={order.id}>
            <TableCell>
              <Link
                to="/orders/$id"
                params={{ id: order.id }}
                className="rounded-sm font-medium underline-offset-4 hover:underline"
              >
                <bdi dir="ltr">{order.number}</bdi>
              </Link>
            </TableCell>
            <TableCell className="min-w-44 whitespace-normal">
              <span className="flex flex-col gap-1">
                <span className="flex items-center gap-2">
                  {order.customer.name}
                  {order.customer.isTest && <Badge tone="info">{t('wallets.testBadge')}</Badge>}
                </span>
                <span dir="ltr" className="text-end text-sm text-muted-foreground">
                  {order.customer.email}
                </span>
              </span>
            </TableCell>
            <TableCell className="min-w-40 whitespace-normal">
              <span className="flex flex-col gap-1">
                <bdi>{order.product.nameAr}</bdi>
                <span className="text-sm text-muted-foreground">{order.game.nameAr}</span>
              </span>
            </TableCell>
            <TableCell className="tabular-nums">{order.quantity}</TableCell>
            <TableCell className="tabular-nums">
              <bdi dir="ltr">{formatUsd(order.totalUsdUnits)}</bdi>
            </TableCell>
            <TableCell>
              <span className="flex flex-col items-start gap-1">
                <Badge tone={STATUS_TONES[order.status]}>
                  {t(`orders.statuses.${order.status}`)}
                </Badge>
                {order.manualWaiting && <Badge tone="gold">{t('orders.manualWaiting')}</Badge>}
              </span>
            </TableCell>
            <TableCell>
              {order.supplierCode ? t(`orders.suppliers.${order.supplierCode}`) : '—'}
            </TableCell>
            <TableCell className="whitespace-nowrap">
              <time dateTime={order.since} title={formatDateTime(order.since)}>
                {formatSince(order.since, now)}
              </time>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
