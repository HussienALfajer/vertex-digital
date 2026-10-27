import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  ADMIN_TICKET_TABS,
  type AdminTicketSummary,
  type AdminTicketTab,
  ORDER_PROBLEMS,
  type OrderProblem,
  TICKET_CATEGORIES,
  type TicketCategory,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  EmptyState,
  Field,
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
import { InboxIcon, SearchIcon, SettingsIcon, XIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { useVisibleAgain } from '../../lib/admin-stream';
import { errorMessage } from '../../lib/errors';
import { formatDateTime, formatSince } from '../../lib/format';
import { CHIP_TONES } from '../customers/customer-labels';
import { customerQuery } from '../customers/customers.queries';
import { ticketListQuery } from './support.queries';
import { type SupportSearch, tabOf, withFilter } from './support-search';
import { TICKET_STATUS_TONES } from './ticket-labels';

const ALL = 'all';

/**
 * "الدعم" (S12 TK12): the queue's tabs ("بانتظار ردّك" oldest first), the type and customer
 * filters and the search by ticket number, all in the URL; a row opens the thread. Read again in
 * the background when the tab is seen again (audit A07-10).
 */
export function SupportPage({
  search,
  onSearch,
}: {
  search: SupportSearch;
  onSearch: (search: SupportSearch) => void;
}) {
  const { t } = useTranslation();
  const list = useInfiniteQuery(ticketListQuery(search));
  useVisibleAgain(() => void list.refetch());
  const tab = tabOf(search);
  const tickets = list.data?.pages.flatMap((page) => page.items) ?? [];
  const filtered = !!search.category || !!search.problem || !!search.customerId || !!search.q;
  const categories = [
    { value: ALL, label: t('support.filters.allCategories') },
    ...TICKET_CATEGORIES.map((item) => ({ value: item, label: t(`support.categories.${item}`) })),
  ];
  const problems = [
    { value: ALL, label: t('support.filters.allProblems') },
    ...ORDER_PROBLEMS.map((item) => ({ value: item, label: t(`support.problems.${item}`) })),
  ];

  return (
    <>
      <PageHeader
        title={t('support.title')}
        description={t('support.subtitle')}
        actions={
          <Button variant="outline" render={<Link to="/settings/support" />}>
            <SettingsIcon />
            {t('nav.supportSettings')}
          </Button>
        }
      />
      <Tabs
        value={tab}
        onValueChange={(value) => onSearch(withFilter(search, { status: value as AdminTicketTab }))}
      >
        <TabsList>
          {ADMIN_TICKET_TABS.map((item) => (
            <TabsTrigger key={item} value={item}>
              {t(`support.tabs.${item}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div className="flex flex-wrap items-end gap-4">
        <Field className="w-44">
          <FieldLabel>{t('support.filters.category')}</FieldLabel>
          <Select
            items={categories}
            value={search.category ?? ALL}
            onValueChange={(value) =>
              onSearch(
                withFilter(search, {
                  category: value === ALL || !value ? undefined : (value as TicketCategory),
                }),
              )
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {categories.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field className="w-52">
          <FieldLabel>{t('support.filters.problem')}</FieldLabel>
          <Select
            items={problems}
            value={search.problem ?? ALL}
            onValueChange={(value) =>
              onSearch(
                withFilter(search, {
                  problem: value === ALL || !value ? undefined : (value as OrderProblem),
                }),
              )
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {problems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {/* A new key resets the field when the URL changes (clear, back). */}
        <NumberSearch key={search.q ?? ''} search={search} onSearch={onSearch} />
        {search.customerId && (
          <div className="flex items-center gap-2">
            <CustomerChip
              customerId={search.customerId}
              name={
                tickets.find((ticket) => ticket.customer.id === search.customerId)?.customer.name
              }
            />
            <Button
              variant="ghost"
              size="sm"
              className="h-11"
              onClick={() => onSearch(withFilter(search, { customerId: undefined }))}
            >
              <XIcon />
              {t('support.filters.clearCustomer')}
            </Button>
          </div>
        )}
      </div>
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
      {list.isSuccess && tickets.length === 0 && !list.isPlaceholderData && (
        <EmptyState
          icon={<InboxIcon />}
          title={filtered ? t('support.empty.filtered') : t(`support.empty.${tab}`)}
        />
      )}
      {tickets.length > 0 && <TicketTable tickets={tickets} loading={list.isPlaceholderData} />}
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

/**
 * TK12 (audit A07-44): the customer filter names the customer, from the queue's rows, else from
 * the customer's profile while no row shows.
 */
function CustomerChip({ customerId, name }: { customerId: string; name: string | undefined }) {
  const { t } = useTranslation();
  const customer = useQuery({ ...customerQuery(customerId), enabled: !name });
  const shown = name ?? customer.data?.name;
  return (
    <Badge tone="info">
      {shown
        ? t('support.filters.customerChip', { name: shown })
        : t('support.filters.oneCustomer')}
    </Badge>
  );
}

function NumberSearch({
  search,
  onSearch,
}: {
  search: SupportSearch;
  onSearch: (search: SupportSearch) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(search.q ?? '');

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const q = text.trim();
    onSearch(withFilter(search, { q: q || undefined }));
  }

  return (
    <search>
      <form className="flex items-end gap-2" onSubmit={submit} noValidate>
        <Field className="w-44">
          <FieldLabel>{t('support.filters.search')}</FieldLabel>
          <Input
            name="q"
            type="search"
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            maxLength={20}
            placeholder="VT-"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </Field>
        <Button type="submit" variant="outline">
          <SearchIcon />
          {t('support.filters.submit')}
        </Button>
      </form>
    </search>
  );
}

/**
 * The tickets as rows (TK12): number, customer with the frozen chip, type, link, subject, status
 * and last activity; a row opens the thread. The customer profile's tab leaves out the customer.
 * `loading`: another tab's or filter's rows, dimmed while the next load (audit A07-15).
 */
export function TicketTable({
  tickets,
  withCustomer = true,
  loading = false,
}: {
  tickets: AdminTicketSummary[];
  withCustomer?: boolean;
  loading?: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const now = new Date();
  return (
    <Table className={loading ? 'opacity-60' : undefined} aria-busy={loading}>
      <TableHeader>
        <TableRow>
          <TableHead>{t('support.columns.number')}</TableHead>
          {withCustomer && <TableHead>{t('support.columns.customer')}</TableHead>}
          <TableHead>{t('support.columns.category')}</TableHead>
          <TableHead>{t('support.columns.link')}</TableHead>
          <TableHead>{t('support.columns.subject')}</TableHead>
          <TableHead>{t('support.columns.status')}</TableHead>
          <TableHead>{t('support.columns.lastActivity')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {tickets.map((ticket) => (
          <TableRow
            key={ticket.id}
            className="cursor-pointer"
            onClick={() => navigate({ to: '/support/$id', params: { id: ticket.id } })}
          >
            <TableCell>
              {/* The keyboard way into the thread; the whole row also opens it. */}
              <Link
                to="/support/$id"
                params={{ id: ticket.id }}
                className="rounded-sm font-medium underline-offset-4 hover:underline"
                onClick={(event) => event.stopPropagation()}
              >
                <bdi dir="ltr">{ticket.number}</bdi>
              </Link>
            </TableCell>
            {withCustomer && (
              <TableCell className="min-w-44 whitespace-normal">
                <span className="flex flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2">
                    {ticket.customer.name}
                    {ticket.customer.status !== 'active' && (
                      <Badge tone={CHIP_TONES[ticket.customer.status]}>
                        {t(`customers.chips.${ticket.customer.status}`)}
                      </Badge>
                    )}
                  </span>
                  <span dir="ltr" className="text-end text-sm text-muted-foreground">
                    {ticket.customer.email}
                  </span>
                </span>
              </TableCell>
            )}
            <TableCell className="whitespace-nowrap">
              {t(`support.categories.${ticket.category}`)}
            </TableCell>
            <TableCell className="whitespace-nowrap">
              {ticket.order ? (
                <bdi dir="ltr">{ticket.order.number}</bdi>
              ) : ticket.deposit ? (
                <bdi dir="ltr">{ticket.deposit.referenceCode}</bdi>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
            <TableCell className="max-w-72 min-w-48 whitespace-normal">
              <span className="line-clamp-2 break-words">{ticket.subject}</span>
              {ticket.orderProblem && (
                <Badge tone="warning" className="mt-1">
                  {t(`support.problems.${ticket.orderProblem}`)}
                </Badge>
              )}
              {ticket.openedBy === 'admin' && (
                <Badge tone="neutral" className="mt-1">
                  {t('support.openedByAdmin')}
                </Badge>
              )}
            </TableCell>
            <TableCell>
              <Badge tone={TICKET_STATUS_TONES[ticket.status]}>
                {t(`support.statuses.${ticket.status}`)}
              </Badge>
            </TableCell>
            <TableCell className="whitespace-nowrap">
              <time dateTime={ticket.lastMessageAt} title={formatDateTime(ticket.lastMessageAt)}>
                {formatSince(ticket.lastMessageAt, now)}
              </time>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
