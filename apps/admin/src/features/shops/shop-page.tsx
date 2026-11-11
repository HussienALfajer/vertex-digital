import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type AdminShop, formatUsd } from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardTitle,
  Dialog,
  EmptyState,
  PageHeader,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@vertex-digital/ui';
import {
  ArrowRightIcon,
  CheckIcon,
  CircleAlertIcon,
  ExternalLinkIcon,
  LockIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  SearchXIcon,
  XIcon,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { ApiError } from '../../lib/api/client';
import { errorMessage } from '../../lib/errors';
import { formatDateTime, ltr } from '../../lib/format';
import { ApproveShopDialog, EditShopDialog, ReasonDialog, SuspendShopDialog } from './shop-dialogs';
import { SHOP_STATUS_TONES } from './shop-labels';
import { CustomersSection, HistorySection, OrdersSection, TicketsSection } from './shop-sections';
import { shopQuery, useResumeShop } from './shops.queries';
import { SHOP_PAGE_TABS, type ShopPageTab } from './shops-search';

type ShopDialog = 'approve' | 'reject' | 'suspend' | 'close' | 'edit';

/** The store's public address of a shop (SP2's QR target). */
const STORE_ORIGIN = 'https://digital.vertexmedia.pro';

/**
 * One shop (S26 Screens): the header with its state and the actions its state allows (SH1–SH8),
 * then the tabs, each in the URL and reading its own route: the overview (limits, rate history,
 * totals), the customers with freeze and settlement, the orders, the escalated tickets and the
 * shop's history.
 */
export function ShopPage({
  id,
  tab,
  onTab,
}: {
  id: string;
  tab: ShopPageTab;
  onTab: (tab: ShopPageTab) => void;
}) {
  const { t } = useTranslation();
  const shop = useQuery(shopQuery(id));
  const [dialog, setDialog] = useState<ShopDialog | null>(null);
  const [resuming, setResuming] = useState(false);
  const resume = useResumeShop(id);

  const back = (
    <Button variant="ghost" render={<Link to="/shops" />}>
      <ArrowRightIcon className="ltr:-scale-x-100" />
      {t('shops.back')}
    </Button>
  );

  if (shop.isPending) {
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
  if (shop.isError) {
    const missing = shop.error instanceof ApiError && shop.error.status === 404;
    return (
      <>
        <PageHeader title={t('shops.title')} actions={back} />
        <EmptyState
          icon={missing ? <SearchXIcon /> : <CircleAlertIcon />}
          title={missing ? t('shops.notFound') : errorMessage(t, shop.error)}
          action={
            missing ? (
              <Button variant="outline" render={<Link to="/shops" />}>
                {t('shops.back')}
              </Button>
            ) : (
              <Button variant="outline" onClick={() => shop.refetch()}>
                {t('common.retry')}
              </Button>
            )
          }
        />
      </>
    );
  }

  const data = shop.data;
  return (
    <>
      <PageHeader
        title={data.displayName}
        description={
          <bdi dir="ltr" className="tabular-nums">
            /s/{data.slug}
          </bdi>
        }
        actions={
          <>
            <Actions shop={data} onDialog={setDialog} onResume={() => setResuming(true)} />
            {back}
          </>
        }
      />
      <StateNotice shop={data} />
      <Tabs value={tab} onValueChange={(value) => onTab(value as ShopPageTab)}>
        <TabsList aria-label={data.displayName}>
          {SHOP_PAGE_TABS.map((item) => (
            <TabsTrigger key={item} value={item}>
              {t(`shops.sections.${item}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {tab === 'overview' && <Overview shop={data} />}
      {tab === 'customers' && <CustomersSection shop={data} />}
      {tab === 'orders' && <OrdersSection shopId={data.id} />}
      {tab === 'tickets' && <TicketsSection shopId={data.id} />}
      {tab === 'history' && <HistorySection shopId={data.id} />}
      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        {dialog === 'approve' && <ApproveShopDialog shop={data} onDone={() => setDialog(null)} />}
        {dialog === 'suspend' && <SuspendShopDialog shop={data} onDone={() => setDialog(null)} />}
        {dialog === 'edit' && <EditShopDialog shop={data} onDone={() => setDialog(null)} />}
        {(dialog === 'reject' || dialog === 'close') && (
          <ReasonDialog kind={dialog} shop={data} onDone={() => setDialog(null)} />
        )}
      </Dialog>
      <ConfirmDialog
        open={resuming}
        onClose={() => setResuming(false)}
        title={t('shops.resume.title', { name: data.displayName })}
        body={t('shops.resume.description')}
        action={t('shops.resume.submit')}
        pending={resume.isPending}
        onConfirm={async () => {
          await resume.mutateAsync(undefined);
        }}
      />
    </>
  );
}

/** The actions the shop's state allows (the states table of S26). */
function Actions({
  shop,
  onDialog,
  onResume,
}: {
  shop: AdminShop;
  onDialog: (dialog: ShopDialog) => void;
  onResume: () => void;
}) {
  const { t } = useTranslation();
  const live = shop.status === 'active' || shop.status === 'suspended';
  return (
    <>
      {shop.status === 'requested' && (
        <>
          <Button onClick={() => onDialog('approve')}>
            <CheckIcon />
            {t('shops.actions.approve')}
          </Button>
          <Button variant="outline" onClick={() => onDialog('reject')}>
            <XIcon />
            {t('shops.actions.reject')}
          </Button>
        </>
      )}
      {shop.status === 'active' && (
        <Button variant="outline" onClick={() => onDialog('suspend')}>
          <PauseIcon />
          {t('shops.actions.suspend')}
        </Button>
      )}
      {shop.status === 'suspended' && (
        <Button variant="outline" onClick={onResume}>
          <PlayIcon />
          {t('shops.actions.resume')}
        </Button>
      )}
      {live && (
        <>
          <Button variant="outline" onClick={() => onDialog('edit')}>
            <PencilIcon />
            {t('shops.actions.edit')}
          </Button>
          <Button variant="destructive" onClick={() => onDialog('close')}>
            <LockIcon />
            {t('shops.actions.close')}
          </Button>
        </>
      )}
    </>
  );
}

/** Why the shop is not active: the rejection, the suspension (category and note) or the close. */
function StateNotice({ shop }: { shop: AdminShop }) {
  const { t } = useTranslation();
  if (shop.status === 'rejected' && shop.rejectReason) {
    return (
      <Callout
        tone="danger"
        icon={<XIcon />}
        title={t('shops.notice.rejected')}
        description={shop.rejectReason}
      />
    );
  }
  if (shop.status === 'suspended') {
    return (
      <Callout
        tone="warning"
        icon={<PauseIcon />}
        title={t('shops.notice.suspended', {
          reason: shop.suspendReason ? t(`shops.suspendReasons.${shop.suspendReason}`) : '',
        })}
        description={shop.suspendNote ?? undefined}
      />
    );
  }
  if (shop.status === 'closed') {
    return (
      <Callout
        tone={shop.settled ? 'neutral' : 'warning'}
        icon={<LockIcon />}
        title={
          shop.settled
            ? t('shops.notice.settled')
            : t('shops.notice.closed', {
                amount: ltr(formatUsd(shop.totalBalanceUsdUnits)),
                orders: shop.openOrders,
              })
        }
        description={
          shop.closedAt ? t('shops.notice.closedAt', { date: formatDateTime(shop.closedAt) }) : ''
        }
      />
    );
  }
  return null;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{children}</dd>
    </div>
  );
}

const usd = (units: number) => (
  <bdi dir="ltr" className="tabular-nums">
    {formatUsd(units)}
  </bdi>
);

/** The overview: the shop, its totals, its limits and its rates. */
function Overview({ shop }: { shop: AdminShop }) {
  const { t } = useTranslation();
  const address = `${STORE_ORIGIN}/s/${shop.slug}`;
  return (
    <div className="grid items-start gap-6 lg:grid-cols-2">
      <Card className="gap-4">
        <CardTitle className="text-lg">{t('shops.overview.shop')}</CardTitle>
        <dl className="grid gap-4 sm:grid-cols-2">
          <Fact label={t('shops.overview.status')}>
            <Badge tone={SHOP_STATUS_TONES[shop.status]}>
              {t(`shops.statuses.${shop.status}`)}
            </Badge>
          </Fact>
          <Fact label={t('shops.overview.merchant')}>
            <Link
              to="/customers/$id"
              params={{ id: shop.merchantId }}
              className="rounded-sm underline-offset-4 hover:underline"
            >
              {shop.merchantName}
            </Link>
          </Fact>
          <Fact label={t('shops.overview.color')}>
            <span className="flex items-center gap-2">
              <span
                className="size-5 rounded-full border border-border"
                style={{ backgroundColor: shop.brandColor }}
                aria-hidden="true"
              />
              <bdi dir="ltr">{shop.brandColor}</bdi>
            </span>
          </Fact>
          <Fact label={t('shops.overview.requestedAt')}>{formatDateTime(shop.requestedAt)}</Fact>
          {shop.decidedAt && (
            <Fact label={t('shops.overview.decidedAt')}>{formatDateTime(shop.decidedAt)}</Fact>
          )}
          {shop.status !== 'requested' && shop.status !== 'rejected' && (
            <Fact label={t('shops.overview.address')}>
              <a
                href={address}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 rounded-sm underline-offset-4 hover:underline"
              >
                <bdi dir="ltr">/s/{shop.slug}</bdi>
                <ExternalLinkIcon className="size-4" aria-hidden="true" />
              </a>
            </Fact>
          )}
        </dl>
        {shop.oldSlugs.length > 0 && (
          <p className="text-sm text-muted-foreground">
            {t('shops.overview.oldSlugs')}{' '}
            {shop.oldSlugs.map((slug) => (
              <bdi key={slug} dir="ltr" className="me-2">
                /s/{slug}
              </bdi>
            ))}
          </p>
        )}
        {shop.announcement && (
          <div className="flex flex-col gap-1">
            <span className="text-sm text-muted-foreground">
              {t('shops.overview.announcement')}
            </span>
            <p className="whitespace-pre-wrap break-words">{shop.announcement}</p>
          </div>
        )}
      </Card>
      <Card className="gap-4">
        <CardTitle className="text-lg">{t('shops.overview.money')}</CardTitle>
        <dl className="grid gap-4 sm:grid-cols-2">
          <Fact label={t('shops.overview.customers')}>{shop.customerCount}</Fact>
          <Fact label={t('shops.overview.balances')}>{usd(shop.totalBalanceUsdUnits)}</Fact>
          <Fact label={t('shops.overview.heldMargin')}>{usd(shop.heldMarginUsdUnits)}</Fact>
          <Fact label={t('shops.overview.openOrders')}>{shop.openOrders}</Fact>
          <Fact label={t('shops.overview.today')}>{usd(shop.transferredTodayUsdUnits)}</Fact>
        </dl>
      </Card>
      <Card className="gap-4">
        <CardTitle className="text-lg">{t('shops.overview.limits')}</CardTitle>
        <dl className="grid gap-4 sm:grid-cols-2">
          <Fact label={t('shops.limits.balanceCap')}>
            {usd(shop.limits.customerBalanceCapUsdUnits)}
          </Fact>
          <Fact label={t('shops.limits.dailyCap')}>
            {usd(shop.limits.dailyTransferCapUsdUnits)}
          </Fact>
          <Fact label={t('shops.limits.customerLimit')}>{shop.limits.customerLimit}</Fact>
        </dl>
      </Card>
      <Card className="gap-4">
        <CardTitle className="text-lg">{t('shops.overview.rate')}</CardTitle>
        <p>
          {shop.rateMode === 'store'
            ? t('shops.overview.rateStore')
            : t('shops.overview.rateOwn', { rate: ltr(shop.ownRate ?? '') })}
          {shop.rate && (
            <span className="ms-2 text-muted-foreground">
              {t('shops.overview.rateNow', { rate: ltr(shop.rate) })}
            </span>
          )}
        </p>
        {shop.rates.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('shops.overview.noRates')}</p>
        ) : (
          <ol className="flex flex-col divide-y divide-border text-sm">
            {shop.rates.map((rate) => (
              <li key={rate.createdAt} className="flex flex-wrap items-center gap-2 py-2">
                <bdi dir="ltr" className="font-medium tabular-nums">
                  {rate.rate}
                </bdi>
                {rate.confirmedFar && <Badge tone="warning">{t('shops.overview.far')}</Badge>}
                <span className="ms-auto text-muted-foreground">
                  {formatDateTime(rate.createdAt)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
