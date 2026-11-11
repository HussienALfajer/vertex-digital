import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { type AdminShopRow, formatUsd } from '@vertex-digital/contracts';
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
import { InboxIcon, SearchIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { formatDateTime, formatSince } from '../../lib/format';
import { SHOP_STATUS_TONES } from './shop-labels';
import { shopsQuery } from './shops.queries';
import { SHOP_TABS, type ShopsSearch, type ShopTab, tabOf } from './shops-search';

/**
 * "المتاجر" (S26 Screens): the requests first (the default tab), then the shops by state, with a
 * search by slug or name; columns: merchant, slug, state, customers, total balances, held margin,
 * today's transfers. A row opens the shop.
 */
export function ShopsPage({
  search,
  onSearch,
}: {
  search: ShopsSearch;
  onSearch: (search: ShopsSearch) => void;
}) {
  const { t } = useTranslation();
  const list = useInfiniteQuery(shopsQuery(search));
  const tab = tabOf(search);
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <>
      <PageHeader title={t('shops.title')} description={t('shops.subtitle')} />
      <Tabs
        value={tab}
        onValueChange={(value) =>
          onSearch({
            ...search,
            tab: value === 'requested' ? undefined : (value as Exclude<ShopTab, 'requested'>),
          })
        }
      >
        <TabsList>
          {SHOP_TABS.map((item) => (
            <TabsTrigger key={item} value={item}>
              {t(`shops.tabs.${item}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <TextSearch key={search.q ?? ''} search={search} onSearch={onSearch} />
      {list.isPending && (
        <div className="flex flex-col gap-2" aria-hidden="true">
          {[0, 1, 2, 3].map((row) => (
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
      {list.isSuccess && rows.length === 0 && !list.isPlaceholderData && (
        <EmptyState
          icon={<InboxIcon />}
          title={search.q ? t('shops.emptyFiltered') : t(`shops.empty.${tab}`)}
        />
      )}
      {rows.length > 0 && <ShopsTable rows={rows} loading={list.isPlaceholderData} />}
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

function ShopsTable({ rows, loading }: { rows: AdminShopRow[]; loading: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const now = new Date();
  return (
    <Table className={loading ? 'opacity-60' : undefined} aria-busy={loading}>
      <TableHeader>
        <TableRow>
          <TableHead>{t('shops.columns.shop')}</TableHead>
          <TableHead>{t('shops.columns.merchant')}</TableHead>
          <TableHead>{t('shops.columns.status')}</TableHead>
          <TableHead>{t('shops.columns.customers')}</TableHead>
          <TableHead>{t('shops.columns.balances')}</TableHead>
          <TableHead>{t('shops.columns.heldMargin')}</TableHead>
          <TableHead>{t('shops.columns.today')}</TableHead>
          <TableHead>{t('shops.columns.requested')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow
            key={row.id}
            className="cursor-pointer"
            onClick={() => navigate({ to: '/shops/$id', params: { id: row.id } })}
          >
            <TableCell className="min-w-44 whitespace-normal">
              <span className="flex items-center gap-2">
                <span
                  className="size-4 shrink-0 rounded-full border border-border"
                  style={{ backgroundColor: row.brandColor }}
                  aria-hidden="true"
                />
                <span className="flex flex-col">
                  <Link
                    to="/shops/$id"
                    params={{ id: row.id }}
                    className="rounded-sm font-medium underline-offset-4 hover:underline"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {row.tradeName}
                  </Link>
                  <bdi dir="ltr" className="text-sm text-muted-foreground">
                    /s/{row.slug}
                  </bdi>
                </span>
              </span>
            </TableCell>
            <TableCell>{row.merchantName}</TableCell>
            <TableCell>
              <Badge tone={SHOP_STATUS_TONES[row.status]}>
                {t(`shops.statuses.${row.status}`)}
              </Badge>
            </TableCell>
            <TableCell className="tabular-nums">{row.customerCount}</TableCell>
            <TableCell>
              <bdi dir="ltr" className="tabular-nums">
                {formatUsd(row.totalBalanceUsdUnits)}
              </bdi>
            </TableCell>
            <TableCell>
              <bdi dir="ltr" className="tabular-nums">
                {formatUsd(row.heldMarginUsdUnits)}
              </bdi>
            </TableCell>
            <TableCell>
              <bdi dir="ltr" className="tabular-nums">
                {formatUsd(row.transferredTodayUsdUnits)}
              </bdi>
            </TableCell>
            <TableCell title={formatDateTime(row.requestedAt)}>
              {formatSince(row.requestedAt, now)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function TextSearch({
  search,
  onSearch,
}: {
  search: ShopsSearch;
  onSearch: (search: ShopsSearch) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(search.q ?? '');

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const q = text.trim();
    onSearch({ ...search, q: q || undefined });
  }

  return (
    <search>
      <form className="flex items-end gap-2" onSubmit={submit} noValidate>
        <Field className="w-64">
          <FieldLabel>{t('shops.search')}</FieldLabel>
          <Input
            name="q"
            type="search"
            autoComplete="off"
            maxLength={100}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </Field>
        <Button type="submit" variant="outline">
          <SearchIcon />
          {t('shops.searchSubmit')}
        </Button>
      </form>
    </search>
  );
}
