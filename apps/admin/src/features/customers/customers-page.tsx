import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  type AdminCustomerRow,
  CUSTOMER_FILTERS,
  type CustomerFilter,
  formatUsd,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  FieldLabel,
  Input,
  PageHeader,
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
import { SearchIcon, SearchXIcon, UsersRoundIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { formatDate, formatDateTime, formatSince } from '../../lib/format';
import { CHIP_TONES, statusChips } from './customer-labels';
import { type CustomerSearch, statusOf, withStatus, withText } from './customer-search';
import { customerListQuery } from './customers.queries';

/**
 * "العملاء" (S12 CS1, CS2): one search field (an order, deposit or ticket number, an email, a
 * phone or a name), the status tabs and the customers newest first with "load more". The search
 * and the tab are in the URL.
 */
export function CustomersPage({
  search,
  onSearch,
}: {
  search: CustomerSearch;
  onSearch: (search: CustomerSearch) => void;
}) {
  const { t } = useTranslation();
  const list = useInfiniteQuery(customerListQuery(search));
  const customers = list.data?.pages.flatMap((page) => page.items) ?? [];
  const filtered = !!search.q || !!search.status;

  return (
    <>
      <PageHeader
        title={t('customers.title')}
        description={t('customers.subtitle')}
        actions={
          <Button variant="outline" render={<Link to="/test-customers" />}>
            <UsersRoundIcon />
            {t('customers.testCustomersLink')}
          </Button>
        }
      />
      <div className="flex flex-col gap-4">
        {/* A new key resets the field when the URL changes (clear, back). */}
        <SearchForm key={search.q ?? ''} search={search} onSearch={onSearch} />
        <Tabs
          value={statusOf(search)}
          onValueChange={(value) => onSearch(withStatus(search, value as CustomerFilter))}
        >
          <TabsList>
            {CUSTOMER_FILTERS.map((item) => (
              <TabsTrigger key={item} value={item}>
                {t(`customers.statusTabs.${item}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      {list.isPending && (
        <div className="flex flex-col gap-2" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((row) => (
            <Skeleton key={row} className="h-14 w-full" />
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
      {list.isSuccess && customers.length === 0 && (
        <EmptyState
          icon={<SearchXIcon />}
          title={t('customers.empty')}
          description={filtered ? t('customers.emptyBody') : undefined}
          action={
            filtered && (
              <Button variant="outline" onClick={() => onSearch({})}>
                {t('customers.search.clear')}
              </Button>
            )
          }
        />
      )}
      {customers.length > 0 && <CustomerTable customers={customers} />}
      {list.hasNextPage && (
        <Button
          variant="outline"
          className="self-center"
          disabled={list.isFetchingNextPage}
          onClick={() => list.fetchNextPage()}
        >
          {list.isFetchingNextPage ? t('common.loadingMore') : t('common.loadMore')}
        </Button>
      )}
    </>
  );
}

function SearchForm({
  search,
  onSearch,
}: {
  search: CustomerSearch;
  onSearch: (search: CustomerSearch) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(search.q ?? '');

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSearch(withText(search, text));
  }

  return (
    <search>
      <form className="flex items-end gap-2" onSubmit={submit} noValidate>
        <Field className="flex-1 sm:max-w-lg">
          <FieldLabel className="sr-only">{t('customers.search.label')}</FieldLabel>
          <Input
            name="q"
            type="search"
            autoComplete="off"
            spellCheck={false}
            maxLength={100}
            placeholder={t('customers.search.placeholder')}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </Field>
        <Button type="submit" variant="outline">
          <SearchIcon />
          {t('customers.search.submit')}
        </Button>
      </form>
    </search>
  );
}

/** Rule CS2: name and email, phone, created, chips, balance, delivered orders, last order. */
function CustomerTable({ customers }: { customers: AdminCustomerRow[] }) {
  const { t } = useTranslation();
  const now = new Date();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('customers.columns.customer')}</TableHead>
          <TableHead>{t('customers.columns.phone')}</TableHead>
          <TableHead>{t('customers.columns.status')}</TableHead>
          <TableHead>{t('customers.columns.balance')}</TableHead>
          <TableHead>{t('customers.columns.delivered')}</TableHead>
          <TableHead>{t('customers.columns.lastOrder')}</TableHead>
          <TableHead>{t('customers.columns.createdAt')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {customers.map((customer) => {
          const chips = statusChips(customer.status, customer.isTest);
          return (
            <TableRow key={customer.id}>
              <TableCell className="min-w-48 whitespace-normal">
                <span className="flex flex-col gap-1">
                  <Link
                    to="/customers/$id"
                    params={{ id: customer.id }}
                    className="rounded-sm font-medium underline-offset-4 hover:underline"
                  >
                    {customer.name}
                  </Link>
                  <span dir="ltr" className="text-end text-sm text-muted-foreground">
                    {customer.email}
                  </span>
                </span>
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <bdi dir="ltr">{customer.phone}</bdi>
              </TableCell>
              <TableCell>
                {chips.length === 0 ? (
                  <span className="text-muted-foreground">{t('customers.active')}</span>
                ) : (
                  <span className="flex flex-wrap gap-1">
                    {chips.map((chip) => (
                      <Badge key={chip} tone={CHIP_TONES[chip]}>
                        {t(`customers.chips.${chip}`)}
                      </Badge>
                    ))}
                  </span>
                )}
              </TableCell>
              <TableCell className="tabular-nums">
                <bdi dir="ltr">{formatUsd(customer.balanceUnits)}</bdi>
              </TableCell>
              <TableCell className="tabular-nums">{customer.deliveredOrders}</TableCell>
              <TableCell className="whitespace-nowrap">
                {customer.lastOrderAt ? (
                  <time
                    dateTime={customer.lastOrderAt}
                    title={formatDateTime(customer.lastOrderAt)}
                  >
                    {formatSince(customer.lastOrderAt, now)}
                  </time>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="whitespace-nowrap">{formatDate(customer.createdAt)}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
