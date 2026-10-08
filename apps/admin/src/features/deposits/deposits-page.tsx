import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  type AdminDepositListItem,
  DEPOSIT_METHODS,
  type DepositMethod,
  formatUsd,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  FieldError,
  FieldLabel,
  Input,
  PageHeader,
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
import { InboxIcon, SearchIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { formatDateTime, formatSince } from '../../lib/format';
import { depositAmount, STATUS_TONES } from './deposit-labels';
import {
  DEPOSIT_TABS,
  type DepositSearch,
  type DepositTab,
  tabOf,
  withMethod,
  withTab,
} from './deposit-search';
import { depositListQuery } from './deposits.queries';

/**
 * "الإيداعات" (S03 screens): the review queue (flagged first, then the oldest, rule RV10), the
 * deposits waiting for a receipt, and all of them, with a search by reference code or email.
 */
export function DepositsPage({
  search,
  onSearch,
}: {
  search: DepositSearch;
  onSearch: (search: DepositSearch) => void;
}) {
  const { t } = useTranslation();
  const list = useInfiniteQuery(depositListQuery(search));
  const tab = tabOf(search);
  const deposits = list.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <>
      <PageHeader title={t('deposits.title')} description={t('deposits.subtitle')} />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <Tabs value={tab} onValueChange={(value) => onSearch(withTab(search, value as DepositTab))}>
          <TabsList>
            {DEPOSIT_TABS.map((item) => (
              <TabsTrigger key={item} value={item}>
                {t(`deposits.tabs.${item}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <MethodFilter search={search} onSearch={onSearch} />
        {/* A new key resets the field when the URL changes (clear, back). */}
        <SearchForm key={search.q ?? ''} search={search} onSearch={onSearch} />
      </div>
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
      {list.isSuccess && deposits.length === 0 && (
        <EmptyState
          icon={<InboxIcon />}
          title={search.q ? t('deposits.empty.search') : t(`deposits.empty.${tab}`)}
        />
      )}
      {deposits.length > 0 && <DepositTable deposits={deposits} tab={tab} />}
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

/** S04: one payment method, or all of them. */
function MethodFilter({
  search,
  onSearch,
}: {
  search: DepositSearch;
  onSearch: (search: DepositSearch) => void;
}) {
  const { t } = useTranslation();
  const items = [
    { value: 'all', label: t('deposits.methodFilter.all') },
    ...DEPOSIT_METHODS.map((item) => ({ value: item, label: t(`wallets.methods.${item}`) })),
  ];
  return (
    <Select
      items={items}
      value={search.method ?? 'all'}
      onValueChange={(value) =>
        onSearch(withMethod(search, value === 'all' ? null : (value as DepositMethod)))
      }
    >
      <SelectTrigger aria-label={t('deposits.methodFilter.label')} className="w-44">
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
  );
}

function SearchForm({
  search,
  onSearch,
}: {
  search: DepositSearch;
  onSearch: (search: DepositSearch) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(search.q ?? '');
  const [short, setShort] = useState(false);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const q = text.trim();
    if (q && q.length < 3) return setShort(true);
    setShort(false);
    const { q: _previous, ...rest } = search;
    onSearch(q ? { ...rest, q } : rest);
  }

  return (
    <search className="w-full sm:w-auto">
      <form className="flex items-start gap-2" onSubmit={submit} noValidate>
        <Field invalid={short} className="flex-1 sm:w-64">
          <FieldLabel className="sr-only">{t('deposits.search.label')}</FieldLabel>
          <Input
            name="q"
            type="search"
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            maxLength={254}
            placeholder={t('deposits.search.placeholder')}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <FieldError match={short}>{t('deposits.search.short')}</FieldError>
        </Field>
        <Button type="submit" variant="outline">
          <SearchIcon />
          {t('deposits.search.submit')}
        </Button>
      </form>
    </search>
  );
}

function DepositTable({ deposits, tab }: { deposits: AdminDepositListItem[]; tab: DepositTab }) {
  const { t } = useTranslation();
  const now = new Date();
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('deposits.columns.reference')}</TableHead>
          <TableHead>{t('deposits.columns.customer')}</TableHead>
          <TableHead>{t('deposits.columns.amount')}</TableHead>
          <TableHead>
            {tab === 'submitted' ? t('deposits.columns.waiting') : t('deposits.columns.created')}
          </TableHead>
          {tab !== 'submitted' && <TableHead>{t('deposits.columns.status')}</TableHead>}
          <TableHead>{t('deposits.columns.flags')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {deposits.map((deposit) => (
          <TableRow key={deposit.id}>
            <TableCell>
              <Link
                to="/deposits/$id"
                params={{ id: deposit.id }}
                className="rounded-sm font-medium underline-offset-4 hover:underline"
              >
                <bdi dir="ltr">{deposit.referenceCode}</bdi>
              </Link>
              <Badge tone="neutral" className="ms-2">
                {t(`wallets.methods.${deposit.method}`)}
              </Badge>
            </TableCell>
            <TableCell className="min-w-44 whitespace-normal">
              <span className="flex flex-col gap-1">
                <span className="flex items-center gap-2">
                  {deposit.customer.name}
                  {deposit.customer.isTest && <Badge tone="info">{t('wallets.testBadge')}</Badge>}
                </span>
                <span dir="ltr" className="text-end text-sm text-muted-foreground">
                  {deposit.customer.email}
                </span>
              </span>
            </TableCell>
            <TableCell className="whitespace-nowrap">
              <span className="flex flex-col gap-1">
                <span className="font-medium tabular-nums">
                  {depositAmount(t, deposit.currency, deposit.declaredAmountUnits)}
                </span>
                {deposit.currency === 'SYP' && (
                  <span className="text-sm text-muted-foreground tabular-nums">
                    ≈ <bdi dir="ltr">{formatUsd(deposit.declaredUsdUnits)}</bdi>
                  </span>
                )}
              </span>
            </TableCell>
            <TableCell className="whitespace-nowrap">
              {tab === 'submitted' && deposit.submittedAt ? (
                <time dateTime={deposit.submittedAt} title={formatDateTime(deposit.submittedAt)}>
                  {formatSince(deposit.submittedAt, now)}
                </time>
              ) : (
                formatDateTime(deposit.createdAt)
              )}
            </TableCell>
            {tab !== 'submitted' && (
              <TableCell>
                <Badge tone={STATUS_TONES[deposit.status]}>
                  {t(`deposits.statuses.${deposit.status}`)}
                </Badge>
              </TableCell>
            )}
            <TableCell className="min-w-40 whitespace-normal">
              {deposit.flags.length === 0 ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                <span className="flex flex-wrap gap-1">
                  {deposit.flags.map((flag) => (
                    <Badge key={flag} tone="warning">
                      {t(`deposits.flags.${flag}.label`)}
                    </Badge>
                  ))}
                </span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
