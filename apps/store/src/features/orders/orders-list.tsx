'use client';

import {
  type CheckoutInfo,
  formatSyp,
  formatUsd,
  type OrderSummary,
} from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui/components/badge';
import { Button } from '@vertex-digital/ui/components/button';
import { Card } from '@vertex-digital/ui/components/card';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { IconTile } from '@vertex-digital/ui/components/icon-tile';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import {
  CircleAlertIcon,
  GiftIcon,
  PackageIcon,
  RotateCwIcon,
  ShoppingBagIcon,
  ShoppingCartIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { formatClock, useTimeLeft } from '@/features/deposits/use-time-left';
import { useNotificationEvents, useVisibleAgain } from '@/features/notifications/live';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { t } from '@/lib/i18n';
import { listOrders } from './requests';
import { STAGE_TONES, stageText } from './stages';

type State =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'missing' }
  | {
      status: 'ready';
      orders: OrderSummary[];
      nextCursor: string | null;
      checkout: CheckoutInfo | null;
    };

/** "اشترِ مجدداً" (S10 rule OT1): the game page opens the order's pack with its fields. */
export function repeatHref(order: Pick<OrderSummary, 'id' | 'game'>, productId?: string): string {
  return `/games/${encodeURIComponent(order.game.slug)}?${new URLSearchParams({
    ...(productId && { pack: productId }),
    repeat: order.id,
  })}`;
}

/**
 * "طلباتي" (S08 screens): the customer's orders newest first, 20 at a time, each a card with the
 * game cover, product, quantity, total (USD, with the pounds shown at purchase), stage and time.
 * Read in the browser with the session, never cached. Live (S09 rule LT2): an `order` event, an
 * order notification, a `resync` or the tab coming back reads the newest page again and updates
 * the cards on screen; a reservation shows the time it has left. S10: `?checkout=<id>` shows one
 * checkout's orders under its header (CT6); cards carry the gift badge and "اشترِ مجدداً" (OT1).
 */
export function OrdersList() {
  const router = useRouter();
  const checkoutId = useSearchParams().get('checkout') ?? undefined;
  const [state, setState] = useState<State>({ status: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailure, setMoreFailure] = useState<Failure | null>(null);

  const load = useCallback(async () => {
    const page = await listOrders(undefined, fetch, checkoutId);
    if (!page.ok && page.reason === 'UNAUTHORIZED') {
      const back = checkoutId ? `/orders?checkout=${checkoutId}` : '/orders';
      router.replace(`/sign-in?next=${encodeURIComponent(back)}`);
      return;
    }
    if (!page.ok) return setState({ status: page.reason === 'NOT_FOUND' ? 'missing' : 'failed' });
    setState({
      status: 'ready',
      orders: page.data.items,
      nextCursor: page.data.nextCursor,
      checkout: page.data.checkout,
    });
  }, [router, checkoutId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** The newest page again, merged over the cards already loaded. */
  const refresh = useCallback(async () => {
    const page = await listOrders(undefined, fetch, checkoutId);
    if (!page.ok) return;
    setState((previous) => {
      if (previous.status !== 'ready') {
        return {
          status: 'ready',
          orders: page.data.items,
          nextCursor: page.data.nextCursor,
          checkout: page.data.checkout,
        };
      }
      const fresh = new Set(page.data.items.map((order) => order.id));
      return {
        ...previous,
        checkout: page.data.checkout,
        orders: [...page.data.items, ...previous.orders.filter((order) => !fresh.has(order.id))],
      };
    });
  }, [checkoutId]);

  useNotificationEvents((event) => {
    if (
      event.type === 'resync' ||
      event.type === 'order' ||
      (event.type === 'notification' && 'orderId' in event.notification.params)
    )
      void refresh();
  });
  useVisibleAgain(() => void refresh());

  const loadMore = async (cursor: string) => {
    setMoreFailure(null);
    setLoadingMore(true);
    const page = await listOrders(cursor, fetch, checkoutId);
    setLoadingMore(false);
    if (!page.ok) return setMoreFailure(page.reason);
    setState((previous) =>
      previous.status === 'ready'
        ? {
            ...previous,
            orders: [...previous.orders, ...page.data.items],
            nextCursor: page.data.nextCursor,
          }
        : previous,
    );
  };

  if (state.status === 'loading') return <OrdersSkeleton />;
  if (state.status === 'missing') {
    return (
      <EmptyState
        icon={<ShoppingCartIcon />}
        title={t('orders.checkout.missing')}
        action={
          <Button variant="outline" size="xl" render={<Link href="/orders" />}>
            {t('orders.checkout.all')}
          </Button>
        }
      />
    );
  }
  if (state.status === 'failed') {
    return (
      <EmptyState
        icon={<CircleAlertIcon />}
        title={t('orders.loadFailed')}
        action={
          <Button
            variant="outline"
            size="xl"
            onClick={() => {
              setState({ status: 'loading' });
              void load();
            }}
          >
            {t('orders.retry')}
          </Button>
        }
      />
    );
  }
  if (state.orders.length === 0) {
    return (
      <EmptyState
        icon={<ShoppingBagIcon />}
        title={t('orders.emptyTitle')}
        description={t('orders.emptyBody')}
        action={
          <Button size="xl" render={<Link href="/" />}>
            {t('orders.browseGames')}
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {state.checkout && <CheckoutHeader checkout={state.checkout} />}
      <ul className="flex flex-col gap-3">
        {state.orders.map((order) => (
          <li key={order.id}>
            <OrderCard order={order} />
          </li>
        ))}
      </ul>
      {moreFailure && <FormAlert>{errorText(moreFailure)}</FormAlert>}
      {state.nextCursor && (
        <Button
          variant="outline"
          size="xl"
          className="self-center"
          disabled={loadingMore}
          onClick={() => void loadMore(state.nextCursor as string)}
        >
          {loadingMore ? t('orders.loadingMore') : t('orders.loadMore')}
        </Button>
      )}
    </div>
  );
}

/** A checkout's orders (S10 rule CT6): "سلة من N طلبات · $X", finished or still moving. */
function CheckoutHeader({ checkout }: { checkout: CheckoutInfo }) {
  return (
    <Card className="gap-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-lg font-bold">
          <ShoppingCartIcon className="size-5 shrink-0" aria-hidden="true" />
          <span>
            {t('orders.checkout.title', { count: checkout.orderCount })} ·{' '}
            <bdi dir="ltr" className="tabular-nums">
              {formatUsd(checkout.totalUsdUnits)}
            </bdi>
          </span>
        </h2>
        <Badge tone={checkout.finishedAt ? 'success' : 'info'}>
          {t(checkout.finishedAt ? 'orders.checkout.finished' : 'orders.checkout.open')}
        </Badge>
      </div>
      <Link href="/orders" className="self-start text-sm underline underline-offset-4">
        {t('orders.checkout.all')}
      </Link>
    </Card>
  );
}

function OrderCard({ order }: { order: OrderSummary }) {
  return (
    <div className="flex flex-col rounded-lg border border-border bg-surface">
      <Link
        href={`/orders/${order.id}`}
        className="flex items-start gap-3 rounded-lg p-4 transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
      >
        <GameCover order={order} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="font-medium break-words">
            <bdi>{order.productNameAr}</bdi>
            {order.quantity > 1 && (
              <span className="text-muted-foreground">
                {' '}
                {t('orders.times', { count: order.quantity })}
              </span>
            )}
          </p>
          <p className="text-sm text-muted-foreground">{order.game.nameAr}</p>
          <p className="text-xs text-muted-foreground">
            <bdi dir="ltr">{order.number}</bdi> · {formatDateTime(order.createdAt)}
          </p>
          {order.isGift && (
            <Badge tone="info" className="self-start">
              <GiftIcon aria-hidden="true" />
              {t('orders.gift.badge')}
            </Badge>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 text-end">
          <Badge tone={STAGE_TONES[order.stage]}>{stageText(order.stage)}</Badge>
          {order.stage === 'awaiting_balance' && order.expiresAt && (
            <ReservedLeft expiresAt={order.expiresAt} />
          )}
          <p className="font-bold tabular-nums">
            <bdi dir="ltr">{formatUsd(order.totalUsdUnits)}</bdi>
          </p>
          {order.totalSypUnits !== null && (
            <p className="text-xs text-muted-foreground tabular-nums">
              {t('orders.syp', { amount: formatSyp(order.totalSypUnits) })}
            </p>
          )}
        </div>
      </Link>
      {order.repeatable && (
        <div className="border-t border-border px-2 py-1">
          <Button
            variant="ghost"
            size="xl"
            className="px-3"
            render={<Link href={repeatHref(order)} />}
          >
            <RotateCwIcon aria-hidden="true" />
            {t('orders.repeat')}
          </Button>
        </div>
      )}
    </div>
  );
}

/** A reservation's time left (rule RS1), in the card. */
function ReservedLeft({ expiresAt }: { expiresAt: string }) {
  const left = useTimeLeft(expiresAt);
  return (
    <p className="text-xs text-muted-foreground">
      {t('orders.reservation.leftShort')}{' '}
      <bdi dir="ltr" className="tabular-nums">
        {formatClock(left)}
      </bdi>
    </p>
  );
}

/** The game's cover, or a plain tile without one. */
export function GameCover({ order }: { order: Pick<OrderSummary, 'game'> }) {
  const cover = order.game.cover;
  if (!cover) {
    return (
      <IconTile tone="muted">
        <PackageIcon />
      </IconTile>
    );
  }
  return (
    // biome-ignore lint/performance/noImgElement: catalog images are stored re-encoded and served immutable by the API (S06).
    <img
      src={`${cover.url}?w=160`}
      alt=""
      width={cover.width}
      height={cover.height}
      className="size-12 shrink-0 rounded-md object-cover"
    />
  );
}

export function OrdersSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden="true">
      {[0, 1, 2].map((row) => (
        <Skeleton key={row} className="h-24 w-full" />
      ))}
    </div>
  );
}
