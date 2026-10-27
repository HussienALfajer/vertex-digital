'use client';

import { Button } from '@vertex-digital/ui/components/button';
import { BellIcon } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { t } from '@/lib/i18n';
import { badgeText } from './labels';
import { useNotificationEvents, useVisibleAgain } from './live';
import { getUnreadCount } from './requests';

/**
 * The header bell (S05 screens): the unread count, live from the stream (rule NT6), refetched
 * after a `resync` and whenever the tab shows again (edge case 14: tabs compete for streams).
 * Only the newest count lands: a read answered after a later stream count is dropped (audit A07-7).
 */
export function NotificationBell() {
  const [count, setCount] = useState(0);
  const latest = useRef(0);

  const read = () => {
    const reading = ++latest.current;
    void getUnreadCount().then((value) => {
      if (value !== null && reading === latest.current) setCount(value);
    });
  };

  useNotificationEvents((event) => {
    if (event.type === 'resync') return read();
    if (event.type === 'order') return;
    latest.current++;
    setCount(event.unreadCount);
  });
  useVisibleAgain(read);

  const badge = badgeText(count);
  return (
    <Button
      variant="ghost"
      size="icon"
      className="relative size-11"
      aria-label={
        badge ? t('header.notificationsUnread', { count: badge }) : t('header.notifications')
      }
      render={<Link href="/notifications" prefetch={false} />}
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
