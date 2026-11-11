'use client';

import { formatUsd, type MerchantShopOrderRow } from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui/components/badge';
import { Button } from '@vertex-digital/ui/components/button';
import { Card } from '@vertex-digital/ui/components/card';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { LoaderCircleIcon, ReceiptTextIcon } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useState } from 'react';
import {
  MerchantPageStatus,
  MerchantSkeleton,
  useMerchantRead,
} from '@/features/merchant-tools/merchant-state';
import { formatDateTime } from '@/lib/format';
import { useSearchParam } from '@/lib/use-search-param';
import { tsa } from './i18n';
import { listShopOrders } from './requests';

const STAGE_TONES = {
  awaiting_balance: 'warning',
  processing: 'info',
  delayed: 'warning',
  delivered: 'success',
  partially_refunded: 'warning',
  refunded: 'neutral',
  cancelled: 'neutral',
} as const;

const MARGIN_TONES = { held: 'info', released: 'success', none: 'neutral' } as const;

/**
 * "طلبات المتجر" (S26 PR9, Screens): the shop's orders, newest first, with the customer, the pack,
 * the state, the selling price and the margin (held until the order finishes, then released).
 * `?customer=` narrows them to one customer.
 */
export function ShopOrdersPage() {
  const customerId = useSearchParam('customer');
  return <OrdersFor key={customerId ?? 'all'} customerId={customerId} />;
}

function OrdersFor({ customerId }: { customerId: string | null }) {
  const read = useCallback(() => listShopOrders({ customerId }), [customerId]);
  const { state, setState, reload } = useMerchantRead(read);
  const [loadingMore, setLoadingMore] = useState(false);
  if (state.status !== 'ready') {
    return <MerchantPageStatus state={state} onRetry={reload} skeleton={<MerchantSkeleton />} />;
  }
  const { items, nextCursor } = state.data;
  const name = customerId ? items[0]?.customer.name : null;

  async function more() {
    if (!nextCursor || state.status !== 'ready') return;
    setLoadingMore(true);
    const result = await listShopOrders({ customerId, cursor: nextCursor });
    setLoadingMore(false);
    if (!result.ok) return;
    setState({
      status: 'ready',
      data: { items: [...items, ...result.data.items], nextCursor: result.data.nextCursor },
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {customerId && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-bold">
            {name ? tsa('orders.forCustomer', { name }) : tsa('orders.title')}
          </h2>
          <Button
            variant="outline"
            size="xl"
            render={<Link href="/merchant/shop/orders" prefetch={false} />}
          >
            {tsa('orders.allOrders')}
          </Button>
        </div>
      )}
      {items.length === 0 ? (
        <EmptyState
          icon={<ReceiptTextIcon />}
          title={customerId ? tsa('orders.emptyCustomer') : tsa('orders.empty')}
        />
      ) : (
        <ul className="flex flex-col gap-3" data-testid="shop-orders">
          {items.map((order) => (
            <OrderCard key={order.id} order={order} />
          ))}
        </ul>
      )}
      {nextCursor && (
        <Button
          variant="outline"
          size="xl"
          className="self-center"
          disabled={loadingMore}
          onClick={() => void more()}
        >
          {loadingMore && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
          {tsa('common.loadMore')}
        </Button>
      )}
    </div>
  );
}

function OrderCard({ order }: { order: MerchantShopOrderRow }) {
  return (
    <li>
      <Card className="gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <bdi dir="ltr" className="font-bold">
              {order.number}
            </bdi>
            <Badge tone={STAGE_TONES[order.stage]}>{tsa(`orders.stages.${order.stage}`)}</Badge>
          </div>
          <span className="text-sm">
            <bdi>{order.gameNameAr}</bdi> · <bdi>{order.productNameAr}</bdi> ×{' '}
            <span className="tabular-nums">{order.quantity}</span>
          </span>
          <span className="text-sm text-muted-foreground">
            {tsa('orders.customer')}: <bdi>{order.customer.name}</bdi> ·{' '}
            {formatDateTime(order.createdAt)}
          </span>
        </div>
        <div className="flex flex-wrap items-end justify-between gap-4 md:justify-end">
          <div className="flex flex-col md:items-end">
            <span className="text-xs text-muted-foreground">{tsa('orders.sell')}</span>
            <bdi dir="ltr" className="font-bold tabular-nums">
              {formatUsd(order.totalSellUsdUnits)}
            </bdi>
          </div>
          <div className="flex flex-col items-end gap-1">
            <span className="text-xs text-muted-foreground">{tsa('orders.margin')}</span>
            <bdi dir="ltr" className="font-bold tabular-nums">
              {formatUsd(order.marginUsdUnits)}
            </bdi>
            <Badge tone={MARGIN_TONES[order.marginState]}>
              {tsa(`orders.marginStates.${order.marginState}`)}
            </Badge>
          </div>
        </div>
      </Card>
    </li>
  );
}
