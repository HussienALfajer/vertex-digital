'use client';

import type { CustomerNotification, OrderStreamItem } from '@vertex-digital/contracts';
import { useEffect, useRef } from 'react';

/*
 * The live notification stream (S05 rules NT6, NT7): one `EventSource` per tab, shared by the
 * bell, the wallet, the deposit page and the orders (S09 rule LT2: an `order` event names an order
 * whose status changed), opened while one of them is mounted. `EventSource`
 * reconnects on its own after a network drop, but closes for good on any answer other than 200 (a
 * 502 while the API restarts, a 429): then it is opened again after 5 seconds, doubling up to a
 * minute, with a `resync` so the listeners refetch what they show.
 */

export type LiveEvent =
  | { type: 'unread'; unreadCount: number }
  | { type: 'notification'; notification: CustomerNotification; unreadCount: number }
  | { type: 'order'; order: OrderStreamItem }
  | { type: 'resync' };

type Listener = (event: LiveEvent) => void;

const listeners = new Set<Listener>();
let source: EventSource | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 5_000;
const MAX_RETRY_DELAY = 60_000;

function emit(event: LiveEvent) {
  for (const listener of listeners) listener(event);
}

function open(reopened = false) {
  const current = new EventSource('/api/notifications/stream');
  source = current;
  // Every open but the first may have missed notifications: the listeners refetch.
  let missed = reopened;
  current.addEventListener('open', () => {
    retryDelay = 5_000;
    if (missed) emit({ type: 'resync' });
    missed = true;
  });
  current.addEventListener('error', () => {
    if (current.readyState !== EventSource.CLOSED || source !== current) return;
    source = null;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (listeners.size > 0 && !source) open(true);
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
  });
  current.addEventListener('unread', (message) =>
    emit({ type: 'unread', ...(JSON.parse(message.data) as { unreadCount: number }) }),
  );
  current.addEventListener('notification', (message) =>
    emit({
      type: 'notification',
      ...(JSON.parse(message.data) as {
        notification: CustomerNotification;
        unreadCount: number;
      }),
    }),
  );
  current.addEventListener('order', (message) =>
    emit({ type: 'order', order: JSON.parse(message.data) as OrderStreamItem }),
  );
  current.addEventListener('resync', () => emit({ type: 'resync' }));
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  if (!source && !retryTimer) open();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      source?.close();
      source = null;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    }
  };
}

/** Tells the other listeners of this tab the new count (the page marked notifications read). */
export function announceUnread(unreadCount: number) {
  emit({ type: 'unread', unreadCount });
}

/** Calls `onEvent` with each live event while the component is mounted. */
export function useNotificationEvents(onEvent: Listener) {
  const latest = useRef(onEvent);
  latest.current = onEvent;
  useEffect(() => subscribe((event) => latest.current(event)), []);
}

/** Whether a live event changes the wallet's balance or a deposit (rule NT7). */
export function isMoneyEvent(event: LiveEvent): boolean {
  return (
    event.type === 'resync' ||
    (event.type === 'notification' &&
      (event.notification.event === 'deposit_credited' ||
        event.notification.event === 'wallet_adjusted'))
  );
}

/**
 * Calls `onVisible` when the tab comes back into view (S09 rule LT2): a page that shows live state
 * reads it again, in case an event was missed while the stream was down.
 */
export function useVisibleAgain(onVisible: () => void) {
  const latest = useRef(onVisible);
  latest.current = onVisible;
  useEffect(() => {
    const listener = () => {
      if (document.visibilityState === 'visible') latest.current();
    };
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  }, []);
}
