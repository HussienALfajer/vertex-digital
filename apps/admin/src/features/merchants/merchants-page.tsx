import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type AdminMerchantRow, formatUsd } from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Dialog,
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
} from '@vertex-digital/ui';
import { InboxIcon, SearchIcon, StoreIcon, UserRoundXIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { formatDate } from '../../lib/format';
import { Picker } from '../pricing/picker';
import { RevokeMerchantDialog, useListItems } from './merchant-dialogs';
import { merchantLevelsQuery, merchantsQuery } from './merchants.queries';
import type { MerchantsSearch } from './merchants-search';

const ALL = 'all';

/**
 * "التجّار" (S20 screens): the merchants with search and list filter in the URL, each with its
 * trade name, governorate, list, since when and 30 days of sales; revoke from the row.
 */
export function MerchantsPage({
  search,
  onSearch,
}: {
  search: MerchantsSearch;
  onSearch: (search: MerchantsSearch) => void;
}) {
  const { t } = useTranslation();
  const list = useInfiniteQuery(merchantsQuery(search));
  const { items: listItems, lists: listsRead } = useListItems();
  const lists = [{ value: ALL, label: t('merchants.list.allLists') }, ...listItems];
  // S21: the live levels, and the merchants without one.
  const levels = useQuery(merchantLevelsQuery);
  const levelItems = [
    { value: ALL, label: t('merchants.list.allLevels') },
    { value: 'none', label: t('merchants.list.noLevel') },
    ...(levels.data?.items ?? [])
      .filter((level) => level.archivedAt === null)
      .map((level) => ({ value: level.id, label: level.nameAr })),
  ];
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  const [revoking, setRevoking] = useState<AdminMerchantRow | null>(null);

  return (
    <>
      <PageHeader
        title={t('merchants.list.title')}
        description={t('merchants.list.subtitle')}
        actions={
          <Button variant="outline" render={<Link to="/merchants/applications" />}>
            <StoreIcon />
            {t('nav.merchantApplications')}
          </Button>
        }
      />
      <div className="flex flex-wrap items-end gap-4">
        <TextSearch key={search.q ?? ''} search={search} onSearch={onSearch} />
        <Field className="w-52">
          <FieldLabel render={<span />}>{t('merchants.list.listFilter')}</FieldLabel>
          <Picker
            label={t('merchants.list.listFilter')}
            items={lists}
            value={search.listId ?? ALL}
            onChange={(value) => onSearch({ ...search, listId: value === ALL ? undefined : value })}
            read={listsRead}
          />
        </Field>
        <Field className="w-52">
          <FieldLabel render={<span />}>{t('merchants.list.levelFilter')}</FieldLabel>
          <Picker
            label={t('merchants.list.levelFilter')}
            items={levelItems}
            value={search.levelId ?? ALL}
            onChange={(value) =>
              onSearch({ ...search, levelId: value === ALL ? undefined : value })
            }
            read={levels}
          />
        </Field>
      </div>
      {list.isPending && (
        <div className="flex flex-col gap-2" aria-hidden="true">
          {[0, 1, 2].map((row) => (
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
          title={
            search.q || search.listId || search.levelId
              ? t('merchants.list.emptyFiltered')
              : t('merchants.list.empty')
          }
        />
      )}
      {rows.length > 0 && (
        <Table
          // Audit A06-47: another search's or filter's rows stay while the next load, dimmed.
          className={list.isPlaceholderData ? 'opacity-60' : undefined}
          aria-busy={list.isPlaceholderData}
        >
          <TableHeader>
            <TableRow>
              <TableHead>{t('merchants.columns.tradeName')}</TableHead>
              <TableHead>{t('merchants.columns.customer')}</TableHead>
              <TableHead>{t('merchants.columns.governorate')}</TableHead>
              <TableHead>{t('merchants.columns.list')}</TableHead>
              <TableHead>{t('merchants.columns.level')}</TableHead>
              <TableHead>{t('merchants.columns.since')}</TableHead>
              <TableHead>{t('merchants.columns.sales30d')}</TableHead>
              <TableHead>
                <span className="sr-only">{t('merchants.columns.actions')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.customerId}>
                <TableCell className="font-medium">{row.tradeName}</TableCell>
                <TableCell className="min-w-44 whitespace-normal">
                  <span className="flex flex-col gap-1">
                    <Link
                      to="/customers/$id"
                      params={{ id: row.customerId }}
                      className="underline-offset-4 hover:underline"
                    >
                      {row.name}
                    </Link>
                    <span className="flex flex-wrap gap-1">
                      {row.frozen && <Badge tone="danger">{t('merchants.flags.frozen')}</Badge>}
                      {!row.termsAccepted && (
                        <Badge tone="warning">{t('merchants.flags.termsPending')}</Badge>
                      )}
                    </span>
                  </span>
                </TableCell>
                <TableCell>
                  {t(`merchants.governorates.${row.governorate}`)} · {row.city}
                </TableCell>
                <TableCell>
                  <Link
                    to="/pricing/lists/$id"
                    params={{ id: row.priceList.id }}
                    className="underline-offset-4 hover:underline"
                  >
                    {row.priceList.name}
                  </Link>
                </TableCell>
                <TableCell>
                  {row.level ? (
                    <Badge tone="neutral">{row.level.nameAr}</Badge>
                  ) : (
                    <span className="text-muted-foreground">{t('merchants.list.noLevel')}</span>
                  )}
                </TableCell>
                <TableCell>{formatDate(row.grantedAt)}</TableCell>
                <TableCell className="tabular-nums">
                  <bdi dir="ltr">{formatUsd(row.sales30dUsdUnits)}</bdi>
                </TableCell>
                <TableCell>
                  <Button variant="ghost" size="sm" onClick={() => setRevoking(row)}>
                    <UserRoundXIcon />
                    {t('merchants.revoke.action')}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
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
      <Dialog open={revoking !== null} onOpenChange={(open) => !open && setRevoking(null)}>
        {revoking && (
          <RevokeMerchantDialog
            customer={{ id: revoking.customerId, name: revoking.name }}
            onDone={() => setRevoking(null)}
          />
        )}
      </Dialog>
    </>
  );
}

function TextSearch({
  search,
  onSearch,
}: {
  search: MerchantsSearch;
  onSearch: (search: MerchantsSearch) => void;
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
          <FieldLabel>{t('merchants.list.search')}</FieldLabel>
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
          {t('merchants.list.searchSubmit')}
        </Button>
      </form>
    </search>
  );
}
