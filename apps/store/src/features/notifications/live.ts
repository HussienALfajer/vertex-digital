'use client';

import type { CustomerNotification } from '@vertex-digital/contracts';
import { useEffect, useRef } from 'react';

/*
 * The live notification stream (S05 rules NT6, NT7): one `EventSource` per tab, shared by the
 * bell, the wallet and the deposit page, opened while one of them is mounted. `EventSource`
 * reconnects on its own; after a `resync` the listeners refetch what they show.
 */

export type LiveEvent =
  | { type: 'unread'; unreadCount: number }
  | { type: 'notification'; notification: CustomerNotification; unreadCount: number }
  | { type: 'resync' };

type Listener = (event: LiveEvent) => void;

const listeners = new Set<Listener>();
let source: EventSource | null = null;

function emit(event: LiveEvent) {
  for (const listener of listeners) listener(event);
}

function open() {
  source = new EventSource('/api/notifications/stream');
  source.addEventListener('unread', (message) =>
    emit({ type: 'unread', ...(JSON.parse(message.data) as { unreadCount: number }) }),
  );
  source.addEventListener('notification', (message) =>
    emit({
      type: 'notification',
      ...(JSON.parse(message.data) as {
        notification: CustomerNotification;
        unreadCount: number;
      }),
    }),
  );
  source.addEventListener('resync', () => emit({ type: 'resync' }));
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  if (!source) open();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      source?.close();
      source = null;
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
