'use client';

import { Button } from '@vertex-digital/ui/components/button';
import { BellIcon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { t } from '@/lib/i18n';
import { badgeText } from './labels';
import { useNotificationEvents } from './live';
import { getUnreadCount } from './requests';

/**
 * The header bell (S05 screens): the unread count, live from the stream (rule NT6), refetched
 * after a `resync` and whenever the tab shows again (edge case 14: tabs compete for streams).
 */
export function NotificationBell() {
  const [count, setCount] = useState(0);

  useNotificationEvents((event) => {
    if (event.type === 'resync')
      void getUnreadCount().then((value) => value !== null && setCount(value));
    else if (event.type !== 'order') setCount(event.unreadCount);
  });

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible')
        void getUnreadCount().then((value) => value !== null && setCount(value));
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const badge = badgeText(count);
  return (
    <Button
      variant="ghost"
      size="icon"
      className="relative size-11"
      aria-label={
        badge ? t('header.notificationsUnread', { count: badge }) : t('header.notifications')
      }
      render={<Link href="/notifications" />}
    >
      <BellIcon />
      {badge && (
        <span
          aria-hidden="true"
          className="absolute end-1 top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-xs font-bold text-accent-foreground tabular-nums"
        >
          {badge}
        </span>
      )}
    </Button>
  );
}
