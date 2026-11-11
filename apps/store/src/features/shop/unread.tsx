'use client';

import { BellIcon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ts } from './i18n';
import { shopPath } from './paths';
import { shopUnreadCount } from './requests';
import { useShopCustomer } from './session';

/*
 * The header's bell (S26 PR9): the shop customer's unread count, read in the browser, and read
 * again when the notification center marks them read.
 */

const listeners = new Map<string, Set<(count: number) => void>>();

export async function refreshShopUnread(slug: string): Promise<void> {
  const result = await shopUnreadCount(slug);
  if (!result.ok) return;
  for (const listener of listeners.get(slug) ?? []) listener(result.data.unreadCount);
}

export function ShopBell({ slug }: { slug: string }) {
  const customer = useShopCustomer(slug);
  const [count, setCount] = useState(0);
  const signedIn = customer.status === 'signedIn';
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    const listener = (next: number) => live && setCount(next);
    const set = listeners.get(slug) ?? new Set();
    set.add(listener);
    listeners.set(slug, set);
    void shopUnreadCount(slug).then((result) => result.ok && listener(result.data.unreadCount));
    return () => {
      live = false;
      set.delete(listener);
    };
  }, [slug, signedIn]);
  if (!signedIn) return null;
  return (
    <Link
      href={shopPath(slug, '/notifications')}
      prefetch={false}
      aria-label={count > 0 ? ts('nav.notificationsUnread', { count }) : ts('nav.notifications')}
      className="relative inline-flex size-11 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
    >
      <BellIcon className="size-5" aria-hidden="true" />
      {count > 0 && (
        <span
          aria-hidden="true"
          className="absolute end-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-(--shop-brand) px-1 text-[0.625rem] font-bold text-white tabular-nums"
        >
          {count > 99 ? '99+' : count}
        </span>
      )}
    </Link>
  );
}
