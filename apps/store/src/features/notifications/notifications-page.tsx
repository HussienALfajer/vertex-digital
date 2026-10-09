'use client';

import type { CustomerNotification, NotificationEvent } from '@vertex-digital/contracts';
import { Button } from '@vertex-digital/ui/components/button';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { IconTile } from '@vertex-digital/ui/components/icon-tile';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import {
  ArrowDownToLineIcon,
  BellIcon,
  CircleAlertIcon,
  CircleSlashIcon,
  CircleXIcon,
  ClockAlertIcon,
  type LucideIcon,
  PackageCheckIcon,
  PackageMinusIcon,
  ReceiptTextIcon,
  SlidersHorizontalIcon,
  Undo2Icon,
  WalletIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { formatDateTime, formatRelative } from '@/lib/format';
import { t } from '@/lib/i18n';
import { notificationHref, notificationText } from './labels';
import { announceUnread, useNotificationEvents } from './live';
import { listNotifications, markNotificationsRead } from './requests';

type State =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; items: CustomerNotification[]; nextCursor: string | null };

const ICONS: Record<NotificationEvent, LucideIcon> = {
  deposit_credited: ArrowDownToLineIcon,
  deposit_rejected: CircleXIcon,
  deposit_receipt_requested: ReceiptTextIcon,
  wallet_adjusted: SlidersHorizontalIcon,
  order_delivered: PackageCheckIcon,
  order_partially_refunded: PackageMinusIcon,
  order_refunded: Undo2Icon,
  order_delayed: ClockAlertIcon,
  order_paid: WalletIcon,
  order_cancelled: CircleSlashIcon,
};

/** Marks everything up to the newest shown as read and tells the bell (rule NT5). */
async function markShown(newest: CustomerNotification | undefined) {
  if (!newest || newest.readAt) return;
  const read = await markNotificationsRead(newest.id);
  if (read.ok) announceUnread(read.data.unreadCount);
}

/**
 * The notification center (S05 screens, rules NT4, NT5): newest first, 20 at a time. Opening it
 * marks what it shows as read; those keep their highlight for this visit. New notifications
 * arrive live at the top. Read in the browser, never cached.
 */
export function NotificationsPage() {
  const router = useRouter();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailure, setMoreFailure] = useState<Failure | null>(null);

  const load = useCallback(async () => {
    const page = await listNotifications();
    if (!page.ok && page.reason === 'UNAUTHORIZED') {
      router.replace('/sign-in?next=%2Fnotifications');
      return;
    }
    if (!page.ok) return setState({ status: 'failed' });
    setState({ status: 'ready', items: page.data.items, nextCursor: page.data.nextCursor });
    void markShown(page.data.items[0]);
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  useNotificationEvents((event) => {
    if (event.type === 'resync') return void load();
    if (event.type !== 'notification') return;
    setState((previous) =>
      previous.status === 'ready' &&
      !previous.items.some((item) => item.id === event.notification.id)
        ? { ...previous, items: [event.notification, ...previous.items] }
        : previous,
    );
    void markShown(event.notification);
  });

  const loadMore = async (cursor: string) => {
    setMoreFailure(null);
    setLoadingMore(true);
    const page = await listNotifications(cursor);
    setLoadingMore(false);
    if (!page.ok) return setMoreFailure(page.reason);
    setState((previous) =>
      previous.status === 'ready'
        ? {
            status: 'ready',
            items: [...previous.items, ...page.data.items],
            nextCursor: page.data.nextCursor,
          }
        : previous,
    );
  };

  if (state.status === 'loading') return <NotificationsSkeleton />;
  if (state.status === 'failed') {
    return (
      <EmptyState
        icon={<CircleAlertIcon />}
        title={t('notifications.loadFailed')}
        action={
          <Button
            variant="outline"
            size="xl"
            onClick={() => {
              setState({ status: 'loading' });
              void load();
            }}
          >
            {t('notifications.retry')}
          </Button>
        }
      />
    );
  }
  if (state.items.length === 0) {
    return <EmptyState icon={<BellIcon />} title={t('notifications.empty')} />;
  }
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
        {state.items.map((notification) => (
          <NotificationRow key={notification.id} notification={notification} />
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
          {loadingMore ? t('notifications.loadingMore') : t('notifications.loadMore')}
        </Button>
      )}
    </div>
  );
}

function NotificationRow({ notification }: { notification: CustomerNotification }) {
  const Icon = ICONS[notification.event];
  const unread = notification.readAt === null;
  return (
    <li>
      <Link
        href={notificationHref(notification)}
        className={
          unread
            ? 'flex items-start gap-3 bg-accent/10 p-4 hover:bg-muted'
            : 'flex items-start gap-3 p-4 hover:bg-muted'
        }
      >
        <IconTile tone={notification.event === 'deposit_credited' ? 'success' : 'muted'}>
          <Icon />
        </IconTile>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className={unread ? 'font-medium' : undefined}>{notificationText(notification)}</p>
          <time
            dateTime={notification.createdAt}
            title={formatDateTime(notification.createdAt)}
            className="text-xs text-muted-foreground"
          >
            {formatRelative(notification.createdAt)}
          </time>
        </div>
        {unread && (
          <span className="mt-2 size-2.5 shrink-0 rounded-full bg-accent">
            <span className="sr-only">{t('notifications.unread')}</span>
          </span>
        )}
      </Link>
    </li>
  );
}

function NotificationsSkeleton() {
  return (
    <ul
      className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface"
      aria-hidden="true"
    >
      {[0, 1, 2, 3].map((row) => (
        <li key={row} className="flex items-start gap-3 p-4">
          <Skeleton className="size-11 shrink-0" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-3 w-24" />
          </div>
        </li>
      ))}
    </ul>
  );
}
