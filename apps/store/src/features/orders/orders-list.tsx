'use client';

import { formatSyp, formatUsd, type OrderSummary } from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui/components/badge';
import { Button } from '@vertex-digital/ui/components/button';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { IconTile } from '@vertex-digital/ui/components/icon-tile';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { CircleAlertIcon, PackageIcon, ShoppingBagIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
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
  | { status: 'ready'; orders: OrderSummary[]; nextCursor: string | null };

/**
 * "طلباتي" (S08 screens): the customer's orders newest first, 20 at a time, each a card with the
 * game cover, product, quantity, total (USD, with the pounds shown at purchase), stage and time.
 * Read in the browser with the session, never cached. Live (S09 rule LT2): an `order` event, an
 * order notification, a `resync` or the tab coming back reads the newest page again and updates
 * the cards on screen; a reservation shows the time it has left.
 */
export function OrdersList() {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailure, setMoreFailure] = useState<Failure | null>(null);

  const load = useCallback(async () => {
    const page = await listOrders();
    if (!page.ok && page.reason === 'UNAUTHORIZED') {
      router.replace('/sign-in?next=%2Forders');
      return;
    }
    if (!page.ok) return setState({ status: 'failed' });
    setState({ status: 'ready', orders: page.data.items, nextCursor: page.data.nextCursor });
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  /** The newest page again, merged over the cards already loaded. */
  const refresh = useCallback(async () => {
    const page = await listOrders();
    if (!page.ok) return;
    setState((previous) => {
      if (previous.status !== 'ready') {
        return { status: 'ready', orders: page.data.items, nextCursor: page.data.nextCursor };
      }
      const fresh = new Set(page.data.items.map((order) => order.id));
      return {
        ...previous,
        orders: [...page.data.items, ...previous.orders.filter((order) => !fresh.has(order.id))],
      };
    });
  }, []);

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
    const page = await listOrders(cursor);
    setLoadingMore(false);
    if (!page.ok) return setMoreFailure(page.reason);
    setState((previous) =>
      previous.status === 'ready'
        ? {
            status: 'ready',
            orders: [...previous.orders, ...page.data.items],
            nextCursor: page.data.nextCursor,
          }
        : previous,
    );
  };

  if (state.status === 'loading') return <OrdersSkeleton />;
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

function OrderCard({ order }: { order: OrderSummary }) {
  return (
    <Link
      href={`/orders/${order.id}`}
      className="flex items-start gap-3 rounded-lg border border-border bg-surface p-4 transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
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
