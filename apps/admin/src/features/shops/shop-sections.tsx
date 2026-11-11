import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  type AdminShop,
  formatUsd,
  type OrderStage,
  type ShopCustomerRow,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  FieldLabel,
  Input,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@vertex-digital/ui';
import { HandCoinsIcon, InboxIcon, LifeBuoyIcon, ScrollTextIcon, SearchIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import { actorLabel } from '../audit/audit-labels';
import { ticketListQuery } from '../support/support.queries';
import { TicketTable } from '../support/support-page';
import { ReasonDialog, SettleDialog } from './shop-dialogs';
import { MARGIN_TONES, SHOP_CUSTOMER_TONES } from './shop-labels';
import { shopCustomersQuery, shopHistoryQuery, shopOrdersQuery } from './shops.queries';

type AdminShopCustomer = ShopCustomerRow & { frozenReason: string | null };

function SectionSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      {[0, 1, 2, 3].map((row) => (
        <Skeleton key={row} className="h-12 w-full" />
      ))}
    </div>
  );
}

function SectionError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
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

const usd = (units: number) => (
  <bdi dir="ltr" className="tabular-nums">
    {formatUsd(units)}
  </bdi>
);

type CustomerDialog =
  | { kind: 'freeze' | 'unfreeze'; customer: AdminShopCustomer }
  | { kind: 'settle'; customer: AdminShopCustomer };

/**
 * "الزبائن": every customer of the shop with the balance and the state, a search by name, email or
 * phone; per customer the freeze (CA7) and, once the shop is closed, the settlement (WL9).
 */
export function CustomersSection({ shop }: { shop: AdminShop }) {
  const { t } = useTranslation();
  const [q, setQ] = useState<string | undefined>(undefined);
  const [text, setText] = useState('');
  const list = useInfiniteQuery(shopCustomersQuery(shop.id, q));
  const [dialog, setDialog] = useState<CustomerDialog | null>(null);
  const rows = (list.data?.pages.flatMap((page) => page.items) ?? []) as AdminShopCustomer[];

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setQ(text.trim() || undefined);
  }

  return (
    <>
      <search>
        <form className="flex items-end gap-2" onSubmit={submit} noValidate>
          <Field className="w-64">
            <FieldLabel>{t('shops.customers.search')}</FieldLabel>
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
      {list.isPending && <SectionSkeleton />}
      {list.isError && <SectionError error={list.error} onRetry={() => list.refetch()} />}
      {list.isSuccess && rows.length === 0 && !list.isPlaceholderData && (
        <EmptyState icon={<InboxIcon />} title={t('shops.customers.empty')} />
      )}
      {rows.length > 0 && (
        <Table className={list.isPlaceholderData ? 'opacity-60' : undefined}>
          <TableHeader>
            <TableRow>
              <TableHead>{t('shops.customers.name')}</TableHead>
              <TableHead>{t('shops.customers.contact')}</TableHead>
              <TableHead>{t('shops.customers.balance')}</TableHead>
              <TableHead>{t('shops.customers.state')}</TableHead>
              <TableHead>{t('shops.customers.since')}</TableHead>
              <TableHead>{t('shops.customers.actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="min-w-36 whitespace-normal font-medium">{row.name}</TableCell>
                <TableCell>
                  <span className="flex flex-col">
                    <span dir="ltr" className="text-end break-all">
                      {row.email}
                    </span>
                    <span dir="ltr" className="text-end text-sm text-muted-foreground">
                      {row.phone}
                    </span>
                  </span>
                </TableCell>
                <TableCell>{usd(row.balanceUsdUnits)}</TableCell>
                <TableCell className="whitespace-normal">
                  <span className="flex flex-col gap-1">
                    <Badge tone={SHOP_CUSTOMER_TONES[row.state]} className="self-start">
                      {t(`shops.customerStates.${row.state}`)}
                    </Badge>
                    {row.frozenReason && (
                      <span className="text-sm text-muted-foreground">{row.frozenReason}</span>
                    )}
                  </span>
                </TableCell>
                <TableCell className="whitespace-nowrap">{formatDateTime(row.createdAt)}</TableCell>
                <TableCell>
                  <fieldset aria-label={row.name} className="flex flex-wrap gap-2">
                    {row.state !== 'archived' && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setDialog({
                            kind: row.state === 'frozen' ? 'unfreeze' : 'freeze',
                            customer: row,
                          })
                        }
                      >
                        {row.state === 'frozen'
                          ? t('shops.customers.unfreeze')
                          : t('shops.customers.freeze')}
                      </Button>
                    )}
                    {shop.status === 'closed' && row.balanceUsdUnits > 0 && (
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => setDialog({ kind: 'settle', customer: row })}
                      >
                        <HandCoinsIcon />
                        {t('shops.customers.settle')}
                      </Button>
                    )}
                  </fieldset>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <LoadMore list={list} />
      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        {dialog?.kind === 'settle' && (
          <SettleDialog shop={shop} customer={dialog.customer} onDone={() => setDialog(null)} />
        )}
        {(dialog?.kind === 'freeze' || dialog?.kind === 'unfreeze') && (
          <ReasonDialog
            kind={dialog.kind}
            shop={shop}
            customer={dialog.customer}
            onDone={() => setDialog(null)}
          />
        )}
      </Dialog>
    </>
  );
}

/** "الطلبات": the shop's orders as its merchant sees them, each opening its order page. */
export function OrdersSection({ shopId }: { shopId: string }) {
  const { t } = useTranslation();
  const list = useInfiniteQuery(shopOrdersQuery(shopId));
  const rows = list.data?.pages.flatMap((page) => page.items) ?? [];
  if (list.isPending) return <SectionSkeleton />;
  if (list.isError) return <SectionError error={list.error} onRetry={() => list.refetch()} />;
  if (rows.length === 0) {
    return <EmptyState icon={<InboxIcon />} title={t('shops.orders.empty')} />;
  }
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('shops.orders.number')}</TableHead>
            <TableHead>{t('shops.orders.customer')}</TableHead>
            <TableHead>{t('shops.orders.product')}</TableHead>
            <TableHead>{t('shops.orders.stage')}</TableHead>
            <TableHead>{t('shops.orders.sell')}</TableHead>
            <TableHead>{t('shops.orders.margin')}</TableHead>
            <TableHead>{t('shops.orders.at')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell>
                <Link
                  to="/orders/$id"
                  params={{ id: row.id }}
                  className="rounded-sm font-medium underline-offset-4 hover:underline"
                >
                  <bdi dir="ltr">{row.number}</bdi>
                </Link>
              </TableCell>
              <TableCell>{row.customer.name}</TableCell>
              <TableCell className="min-w-40 whitespace-normal">
                <bdi>{row.productNameAr}</bdi> × {row.quantity}
                <span className="block text-sm text-muted-foreground">{row.gameNameAr}</span>
              </TableCell>
              <TableCell>
                <Badge tone={ORDER_STAGE_TONES[row.stage]}>
                  {t(`shops.orders.stages.${row.stage}`)}
                </Badge>
              </TableCell>
              <TableCell>{usd(row.totalSellUsdUnits)}</TableCell>
              <TableCell>
                <span className="flex flex-wrap items-center gap-2">
                  {usd(row.marginUsdUnits)}
                  <Badge tone={MARGIN_TONES[row.marginState]}>
                    {t(`shops.marginStates.${row.marginState}`)}
                  </Badge>
                </span>
              </TableCell>
              <TableCell className="whitespace-nowrap">{formatDateTime(row.createdAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <LoadMore list={list} />
    </>
  );
}

/** A shop order's stage chip (the customer's stages, S08). */
const ORDER_STAGE_TONES = {
  awaiting_balance: 'warning',
  processing: 'info',
  delayed: 'warning',
  delivered: 'success',
  partially_refunded: 'warning',
  refunded: 'neutral',
  cancelled: 'neutral',
} as const satisfies Record<OrderStage, string>;

/** "التذاكر": the shop's escalated tickets (TK2), in the support queue's table. */
export function TicketsSection({ shopId }: { shopId: string }) {
  const { t } = useTranslation();
  const list = useInfiniteQuery(ticketListQuery({ status: 'all', shopId }));
  const tickets = list.data?.pages.flatMap((page) => page.items) ?? [];
  if (list.isPending) return <SectionSkeleton />;
  if (list.isError) return <SectionError error={list.error} onRetry={() => list.refetch()} />;
  if (tickets.length === 0) {
    return <EmptyState icon={<LifeBuoyIcon />} title={t('shops.tickets.empty')} />;
  }
  return (
    <>
      <p className="text-sm text-muted-foreground">{t('shops.tickets.note')}</p>
      <TicketTable tickets={tickets} />
      <LoadMore list={list} />
    </>
  );
}

/** "السجل": the shop's audit entries, newest first, and the way to the whole log. */
export function HistorySection({ shopId }: { shopId: string }) {
  const { t } = useTranslation();
  const history = useQuery(shopHistoryQuery(shopId));
  if (history.isPending) return <SectionSkeleton />;
  if (history.isError) {
    return <SectionError error={history.error} onRetry={() => history.refetch()} />;
  }
  return (
    <>
      <Button
        variant="outline"
        className="self-start"
        render={<Link to="/audit" search={{ entityId: shopId }} />}
      >
        <ScrollTextIcon />
        {t('shops.history.all')}
      </Button>
      {history.data.items.length === 0 ? (
        <EmptyState icon={<InboxIcon />} title={t('shops.history.empty')} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('audit.columns.time')}</TableHead>
              <TableHead>{t('audit.columns.actor')}</TableHead>
              <TableHead>{t('audit.columns.action')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {history.data.items.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell className="whitespace-nowrap">
                  {formatDateTime(entry.occurredAt)}
                </TableCell>
                <TableCell>{actorLabel(t, entry)}</TableCell>
                <TableCell className="whitespace-normal">
                  <span className="font-medium">{t(`audit.actions.${entry.action}`)}</span>
                  {entry.reason && (
                    <span className="block text-sm text-muted-foreground">{entry.reason}</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
