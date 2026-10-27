import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type AdminCustomer, formatUsd } from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Callout,
  Card,
  Dialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  PageHeader,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@vertex-digital/ui';
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  LifeBuoyIcon,
  LogOutIcon,
  SearchXIcon,
  ShoppingCartIcon,
  SlidersHorizontalIcon,
  SnowflakeIcon,
  StoreIcon,
  SunIcon,
  UserRoundXIcon,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../lib/api/client';
import { errorMessage } from '../../lib/errors';
import { formatDate, formatDateTime } from '../../lib/format';
import { GrantMerchantDialog, RevokeMerchantDialog } from '../merchants/merchant-dialogs';
import { LimitsDialog, PriceListDialog, StateChangeDialog } from './customer-dialogs';
import { CHIP_TONES, type CustomerChip, statusChips } from './customer-labels';
import { NotesSection } from './customer-notes';
import { CUSTOMER_TABS, type CustomerTab } from './customer-search';
import {
  DepositsSection,
  DevicesSection,
  HistorySection,
  OrdersSection,
  SummarySection,
  TicketsSection,
  WalletSection,
} from './customer-sections';
import { type CustomerStateAction, customerQuery } from './customers.queries';

type Dialogs = CustomerStateAction | 'limits' | 'priceList' | 'grantMerchant' | 'revokeMerchant';

/**
 * One customer (S12 CS3–CS5): the header with the chips, the balance and the actions (CF, LM,
 * AR, SN1, a ticket to the customer), the last freeze or archive reason, and the tabs, each in
 * the URL and reading its own route.
 */
export function CustomerPage({
  id,
  tab,
  onTab,
}: {
  id: string;
  tab: CustomerTab;
  onTab: (tab: CustomerTab) => void;
}) {
  const { t } = useTranslation();
  const customer = useQuery(customerQuery(id));
  const [dialog, setDialog] = useState<Dialogs | null>(null);

  const back = (
    <Button variant="ghost" render={<Link to="/customers" />}>
      <ArrowRightIcon className="ltr:-scale-x-100" />
      {t('customers.back')}
    </Button>
  );

  if (customer.isPending) {
    return (
      <>
        <PageHeader title={<Skeleton className="h-8 w-56" />} actions={back} />
        <div className="flex flex-col gap-4" aria-hidden="true">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </>
    );
  }
  if (customer.isError) {
    // Audit A07-47: a customer that does not exist offers the way back, not a retry.
    const missing = customer.error instanceof ApiError && customer.error.status === 404;
    return (
      <>
        <PageHeader title={t('customers.title')} actions={back} />
        <EmptyState
          icon={missing ? <SearchXIcon /> : <CircleAlertIcon />}
          title={missing ? t('customers.notFound') : errorMessage(t, customer.error)}
          action={
            missing ? (
              <Button variant="outline" render={<Link to="/customers" />}>
                {t('customers.back')}
              </Button>
            ) : (
              <Button variant="outline" onClick={() => customer.refetch()}>
                {t('common.retry')}
              </Button>
            )
          }
        />
      </>
    );
  }

  const data = customer.data;
  const archived = data.status === 'archived';
  return (
    <>
      <PageHeader
        title={data.name}
        actions={
          <>
            <Actions customer={data} onAction={setDialog} />
            {back}
          </>
        }
      />
      <Header customer={data} />
      {data.statusChange && data.status !== 'active' && (
        <Callout
          tone={data.status === 'frozen' ? 'danger' : 'neutral'}
          icon={data.status === 'frozen' ? <SnowflakeIcon /> : <ArchiveIcon />}
          title={t(`customers.summary.statusChange.${data.status}`, {
            date: formatDateTime(data.statusChange.at),
          })}
          description={data.statusChange.reason ?? t('customers.summary.statusChange.noReason')}
        />
      )}
      <Tabs value={tab} onValueChange={(value) => onTab(value as CustomerTab)}>
        <TabsList aria-label={data.name}>
          {CUSTOMER_TABS.map((item) => (
            <TabsTrigger key={item} value={item}>
              {t(`customers.sections.${item}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {tab === 'summary' && (
        <SummarySection
          customer={data}
          onEditLimits={archived ? undefined : () => setDialog('limits')}
          onChangePriceList={archived ? undefined : () => setDialog('priceList')}
        />
      )}
      {tab === 'wallet' && <WalletSection customer={data} />}
      {tab === 'orders' && <OrdersSection customerId={data.id} />}
      {tab === 'deposits' && <DepositsSection customerId={data.id} />}
      {tab === 'tickets' && <TicketsSection customerId={data.id} />}
      {tab === 'devices' && <DevicesSection customerId={data.id} />}
      {tab === 'notes' && <NotesSection customerId={data.id} pinnedNote={data.pinnedNote} />}
      {tab === 'history' && <HistorySection customerId={data.id} />}
      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        {dialog === 'limits' && <LimitsDialog customer={data} onDone={() => setDialog(null)} />}
        {dialog === 'priceList' && (
          <PriceListDialog customer={data} onDone={() => setDialog(null)} />
        )}
        {dialog === 'grantMerchant' && (
          <GrantMerchantDialog customer={data} onDone={() => setDialog(null)} />
        )}
        {dialog === 'revokeMerchant' && (
          <RevokeMerchantDialog customer={data} onDone={() => setDialog(null)} />
        )}
        {dialog !== null &&
          dialog !== 'limits' &&
          dialog !== 'priceList' &&
          dialog !== 'grantMerchant' &&
          dialog !== 'revokeMerchant' && (
            <StateChangeDialog customer={data} action={dialog} onDone={() => setDialog(null)} />
          )}
      </Dialog>
    </>
  );
}

/** Email and phone (left to right), the chips and the balance. */
function Header({ customer }: { customer: AdminCustomer }) {
  const { t } = useTranslation();
  const chips: CustomerChip[] = [
    ...statusChips(customer.status, customer.isTest),
    customer.established ? 'established' : 'new',
  ];
  return (
    <Card className="flex-row flex-wrap items-center justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          {chips.map((chip) => (
            <Badge key={chip} tone={CHIP_TONES[chip]}>
              {t(`customers.chips.${chip}`)}
            </Badge>
          ))}
        </div>
        <span dir="ltr" className="text-end break-all">
          {customer.email}
        </span>
        <span dir="ltr" className="text-end text-muted-foreground tabular-nums">
          {customer.phone}
        </span>
        <AcceptedVersions customer={customer} />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-sm text-muted-foreground">{t('customers.profile.balance')}</span>
        <span className="text-2xl font-bold tabular-nums">
          <bdi dir="ltr">{formatUsd(customer.balanceUnits)}</bdi>
        </span>
      </div>
    </Card>
  );
}

/**
 * S14 TA3: the terms and privacy versions in force at sign-up, or "قبل نشر …" for a customer who
 * signed up before the page was published.
 */
function AcceptedVersions({ customer }: { customer: AdminCustomer }) {
  const { t } = useTranslation();
  const pages = [
    ['terms', customer.termsVersion],
    ['privacy', customer.privacyVersion],
  ] as const;
  return (
    <ul className="flex flex-col text-sm text-muted-foreground" data-testid="accepted-versions">
      {pages.map(([page, accepted]) => (
        <li key={page}>
          {accepted
            ? t(`customers.profile.accepted.${page}`, {
                version: accepted.version,
                date: formatDate(accepted.publishedAt),
              })
            : t(`customers.profile.accepted.${page}Before`)}
        </li>
      ))}
    </ul>
  );
}

/**
 * The actions the customer's status allows: an archived customer can only be unarchived and
 * signed out (LM5, TK10); a frozen one unfrozen.
 */
function Actions({
  customer,
  onAction,
}: {
  customer: AdminCustomer;
  onAction: (action: Dialogs) => void;
}) {
  const { t } = useTranslation();
  const { status } = customer;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" />}>
        {t('customers.actions.menu')}
        <ChevronDownIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-60">
        {status === 'active' && (
          <DropdownMenuItem variant="destructive" onClick={() => onAction('freeze')}>
            <SnowflakeIcon />
            {t('customers.actions.freeze')}
          </DropdownMenuItem>
        )}
        {status === 'frozen' && (
          <DropdownMenuItem onClick={() => onAction('unfreeze')}>
            <SunIcon />
            {t('customers.actions.unfreeze')}
          </DropdownMenuItem>
        )}
        {/* S20 MA6, MA7: a merchant from the panel, or back to a customer. */}
        {status === 'active' && customer.pricing.accountType === 'customer' && (
          <DropdownMenuItem onClick={() => onAction('grantMerchant')}>
            <StoreIcon />
            {t('merchants.grant.action')}
          </DropdownMenuItem>
        )}
        {customer.pricing.accountType === 'merchant' && (
          <DropdownMenuItem variant="destructive" onClick={() => onAction('revokeMerchant')}>
            <UserRoundXIcon />
            {t('merchants.revoke.action')}
          </DropdownMenuItem>
        )}
        {status !== 'archived' && (
          <DropdownMenuItem onClick={() => onAction('limits')}>
            <SlidersHorizontalIcon />
            {t('customers.actions.limits')}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onClick={() => onAction('revoke')}>
          <LogOutIcon className="rtl:-scale-x-100" />
          {t('customers.actions.revoke')}
        </DropdownMenuItem>
        {status === 'active' && (
          <DropdownMenuItem
            render={
              <Link to="/orders/new" search={{ purpose: 'on_behalf', customerId: customer.id }} />
            }
          >
            <ShoppingCartIcon />
            {t('customers.actions.buy')}
          </DropdownMenuItem>
        )}
        {status !== 'archived' && (
          <DropdownMenuItem render={<Link to="/support/new" search={{ customer: customer.id }} />}>
            <LifeBuoyIcon />
            {t('customers.actions.ticket')}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        {status === 'archived' ? (
          <DropdownMenuItem onClick={() => onAction('unarchive')}>
            <ArchiveRestoreIcon />
            {t('customers.actions.unarchive')}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem variant="destructive" onClick={() => onAction('archive')}>
            <ArchiveIcon />
            {t('customers.actions.archive')}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
