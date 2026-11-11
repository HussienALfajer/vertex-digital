'use client';

import { formatUsd, type ShopCustomerNotification } from '@vertex-digital/contracts';
import { Button } from '@vertex-digital/ui/components/button';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { PageHeader } from '@vertex-digital/ui/components/page-header';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { BellIcon } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { formatDateTime, ltr } from '@/lib/format';
import { ts } from './i18n';
import { shopPath } from './paths';
import { listShopNotifications, markShopNotificationsRead } from './requests';
import { ReadFailed, SessionFailed, useSignedInShopCustomer } from './signed-in';
import { refreshShopUnread } from './unread';

type State =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; items: ShopCustomerNotification[]; nextCursor: string | null };

const usd = (units: number) => ltr(formatUsd(units));

/** A notification's sentence and the shop page it opens (S26 PR9, WL5, TK3). */
export function shopNotificationView(
  slug: string,
  item: ShopCustomerNotification,
): { text: string; href: string } {
  switch (item.event) {
    case 'transfer_received':
    case 'return_done':
    case 'settled':
      return {
        text: ts(`notifications.events.${item.event}`, { amount: usd(item.params.amountUsdUnits) }),
        href: shopPath(slug, '/wallet'),
      };
    case 'return_requested':
      return {
        text: ts('notifications.events.return_requested', {
          amount: usd(item.params.amountUsdUnits),
        }),
        href: shopPath(slug, '/wallet'),
      };
    case 'order_delivered':
      return {
        text: ts('notifications.events.order_delivered', {
          number: ltr(item.params.orderNumber),
          product: item.params.productNameAr,
        }),
        href: shopPath(slug, `/orders/${item.params.orderNumber}`),
      };
    case 'order_partially_refunded':
    case 'order_refunded':
      return {
        text: ts(`notifications.events.${item.event}`, {
          number: ltr(item.params.orderNumber),
          amount: usd(item.params.refundedUsdUnits),
        }),
        href: shopPath(slug, `/orders/${item.params.orderNumber}`),
      };
    case 'order_compensated':
      return {
        text: ts('notifications.events.order_compensated', {
          number: ltr(item.params.orderNumber),
          amount: usd(item.params.amountUsdUnits),
        }),
        href: shopPath(slug, `/orders/${item.params.orderNumber}`),
      };
    case 'ticket_replied':
      return {
        text: `${ts('notifications.events.ticket_replied', { number: ltr(item.params.number) })} · ${ts(`notifications.from.${item.params.from}`)}`,
        href: shopPath(slug, `/support/${item.params.ticketId}`),
      };
  }
}

/**
 * The shop customer's notification center (S26 PR9; WL5 names it for a return request): newest
 * first, unread marked; reading the page marks them read up to the newest shown.
 */
export function ShopNotificationsPage({ slug }: { slug: string }) {
  const customer = useSignedInShopCustomer(slug);
  const signedIn = customer.status === 'signedIn';
  const [state, setState] = useState<State>({ status: 'loading' });
  const [moreFailure, setMoreFailure] = useState<Failure | null>(null);

  const load = useCallback(async () => {
    const page = await listShopNotifications(slug);
    if (!page.ok) {
      return setState((shown) => (shown.status === 'ready' ? shown : { status: 'failed' }));
    }
    setState({ status: 'ready', items: page.data.items, nextCursor: page.data.nextCursor });
    const newest = page.data.items[0];
    if (newest && page.data.unreadCount > 0) {
      const read = await markShopNotificationsRead(slug, newest.id);
      if (read.ok) void refreshShopUnread(slug);
    }
  }, [slug]);

  useEffect(() => {
    if (signedIn) void load();
  }, [signedIn, load]);

  async function more() {
    if (state.status !== 'ready' || !state.nextCursor) return;
    const page = await listShopNotifications(slug, { cursor: state.nextCursor });
    if (!page.ok) return setMoreFailure(page.reason);
    setState({
      status: 'ready',
      items: [...state.items, ...page.data.items],
      nextCursor: page.data.nextCursor,
    });
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-6 md:py-10">
      <PageHeader title={ts('notifications.title')} />
      {customer.status === 'failed' ? (
        <SessionFailed slug={slug} />
      ) : state.status === 'loading' ? (
        <Skeleton className="h-48 w-full" />
      ) : state.status === 'failed' ? (
        <ReadFailed title={ts('notifications.failed')} onRetry={() => void load()} />
      ) : state.items.length === 0 ? (
        <EmptyState
          icon={<BellIcon />}
          title={ts('notifications.empty')}
          description={ts('notifications.emptyBody')}
        />
      ) : (
        <>
          <ul className="flex flex-col rounded-xl border border-border bg-surface">
            {state.items.map((item) => {
              const view = shopNotificationView(slug, item);
              return (
                <li key={item.id} className="border-b border-border last:border-b-0">
                  <Link
                    href={view.href}
                    prefetch={false}
                    className="flex min-h-11 items-start gap-3 px-4 py-3"
                  >
                    <span
                      aria-hidden="true"
                      className={`mt-2 size-2 shrink-0 rounded-full ${item.readAt ? 'bg-transparent' : 'bg-(--shop-brand)'}`}
                    />
                    <span className="flex flex-col gap-1">
                      <span className={item.readAt ? '' : 'font-bold'}>{view.text}</span>
                      <span className="text-xs text-muted-foreground">
                        {formatDateTime(item.createdAt)}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
          {moreFailure && <FormAlert>{errorText(moreFailure)}</FormAlert>}
          {state.nextCursor && (
            <Button variant="outline" size="xl" onClick={() => void more()}>
              {ts('notifications.more')}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
