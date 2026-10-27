import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import type { AdminMerchantApplicationRow } from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  EmptyState,
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
import { InboxIcon, SettingsIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { formatDateTime, formatSince } from '../../lib/format';
import { applicationsQuery } from './merchants.queries';
import {
  APPLICATION_TABS,
  type ApplicationsSearch,
  type ApplicationTab,
  tabOf,
} from './merchants-search';

/** The status chip's tone (brand §2). */
export const APPLICATION_TONES = {
  under_review: 'info',
  info_requested: 'warning',
  approved: 'success',
  rejected: 'danger',
  expired: 'neutral',
  withdrawn: 'neutral',
} as const;

/**
 * "طلبات التجّار" (S20 MA8, screens): tabs in the URL (under review oldest first, waiting for
 * information, all), each row with the form's headline and the customer's flags; a row opens the
 * application.
 */
export function ApplicationsPage({
  search,
  onSearch,
}: {
  search: ApplicationsSearch;
  onSearch: (search: ApplicationsSearch) => void;
}) {
  const { t } = useTranslation();
  const list = useInfiniteQuery(applicationsQuery(search));
  const tab = tabOf(search);
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <>
      <PageHeader
        title={t('merchants.applications.title')}
        description={t('merchants.applications.subtitle')}
        actions={
          <Button variant="outline" render={<Link to="/settings/merchants" />}>
            <SettingsIcon />
            {t('nav.merchantSettings')}
          </Button>
        }
      />
      <Tabs
        value={tab}
        onValueChange={(value) =>
          onSearch(
            value === 'under_review'
              ? {}
              : { tab: value as Exclude<ApplicationTab, 'under_review'> },
          )
        }
      >
        <TabsList>
          {APPLICATION_TABS.map((item) => (
            <TabsTrigger key={item} value={item}>
              {t(`merchants.applications.tabs.${item}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
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
        <EmptyState icon={<InboxIcon />} title={t(`merchants.applications.empty.${tab}`)} />
      )}
      {rows.length > 0 && <ApplicationsTable rows={rows} loading={list.isPlaceholderData} />}
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

function ApplicationsTable({
  rows,
  loading,
}: {
  rows: AdminMerchantApplicationRow[];
  /** Another tab's rows, kept while this one loads (audit A06-47). */
  loading: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const now = new Date();
  return (
    <Table className={loading ? 'opacity-60' : undefined} aria-busy={loading}>
      <TableHeader>
        <TableRow>
          <TableHead>{t('merchants.columns.tradeName')}</TableHead>
          <TableHead>{t('merchants.columns.customer')}</TableHead>
          <TableHead>{t('merchants.columns.governorate')}</TableHead>
          <TableHead>{t('merchants.columns.activity')}</TableHead>
          <TableHead>{t('merchants.columns.volume')}</TableHead>
          <TableHead>{t('merchants.columns.status')}</TableHead>
          <TableHead>{t('merchants.columns.submitted')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow
            key={row.id}
            className="cursor-pointer"
            onClick={() => navigate({ to: '/merchants/applications/$id', params: { id: row.id } })}
          >
            <TableCell>
              <Link
                to="/merchants/applications/$id"
                params={{ id: row.id }}
                className="rounded-sm font-medium underline-offset-4 hover:underline"
                onClick={(event) => event.stopPropagation()}
              >
                {row.tradeName}
              </Link>
            </TableCell>
            <TableCell className="min-w-44 whitespace-normal">
              <span className="flex flex-col gap-1">
                <span>{row.customer.name}</span>
                <span className="flex flex-wrap gap-1">
                  {row.customer.frozen && (
                    <Badge tone="danger">{t('merchants.flags.frozen')}</Badge>
                  )}
                  {row.customer.newAccount && (
                    <Badge tone="warning">{t('merchants.flags.newAccount')}</Badge>
                  )}
                  {row.customer.sharedPhone > 0 && (
                    <Badge tone="warning">
                      {t('merchants.flags.sharedPhone', { count: row.customer.sharedPhone })}
                    </Badge>
                  )}
                </span>
              </span>
            </TableCell>
            <TableCell>{t(`merchants.governorates.${row.governorate}`)}</TableCell>
            <TableCell>{t(`merchants.activities.${row.activity}`)}</TableCell>
            <TableCell>{t(`merchants.volumes.${row.monthlyVolume}`)}</TableCell>
            <TableCell>
              <Badge tone={APPLICATION_TONES[row.status]}>
                {t(`merchants.statuses.${row.status}`)}
              </Badge>
            </TableCell>
            <TableCell title={formatDateTime(row.submittedAt)}>
              {formatSince(row.submittedAt, now)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
