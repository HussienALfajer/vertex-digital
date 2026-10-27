'use client';

import type { CustomerNotification, OrderStreamItem } from '@vertex-digital/contracts';
import { useEffect, useRef } from 'react';
import { sessionEnded } from './requests';

/*
 * The live notification stream (S05 rules NT6, NT7): one `EventSource` per tab, shared by the
 * bell, the wallet, the deposit page and the orders (S09 rule LT2: an `order` event names an order
 * whose status changed), opened while one of them is mounted. `EventSource`
 * reconnects on its own after a network drop, but closes for good on any answer other than 200 (a
 * 502 while the API restarts, a 429, a 401 once the session ended): one read of the unread count
 * then tells a session that ended (the stream stays closed, audit A07-2) from a passing fault (it
 * is opened again after 5 seconds, doubling up to a minute, with a `resync` so the listeners
 * refetch what they show). The API keeps 3 streams per customer: a 4th sends `replaced` to the
 * oldest, which then stays closed (reconnecting would close the next oldest, and so on) until its
 * tab is looked at again (audit A07-3, as the panel's `admin-stream.ts`).
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
/** A refused stream's session read is in flight: nothing opens until it answers. */
let probing = false;
/** Why the stream stays closed until the tab is looked at again: another tab, or no session. */
let halted: 'replaced' | 'signedOut' | null = null;

function emit(event: LiveEvent) {
  for (const listener of listeners) listener(event);
}

function idle() {
  return !source && !retryTimer && !probing && !halted;
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
    probing = true;
    void sessionEnded().then((ended) => {
      probing = false;
      if (listeners.size === 0 || source) return;
      if (ended) {
        halted = 'signedOut';
        return;
      }
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (listeners.size > 0 && idle()) open(true);
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
    });
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
  current.addEventListener('replaced', () => {
    current.close();
    if (source === current) source = null;
    halted = 'replaced';
  });
}

/** The tab is looked at again: it takes the stream back from the others (and reads again). */
function reclaim() {
  if (document.visibilityState !== 'visible' || !halted || listeners.size === 0) return;
  halted = null;
  if (idle()) open(true);
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  if (listeners.size === 1) document.addEventListener('visibilitychange', reclaim);
  // A page mounted in this tab is looked at: it takes the stream back, and the others read again
  // (a session that ended stays closed until the tab is shown again).
  const reclaimed = halted === 'replaced';
  if (reclaimed) halted = null;
  if (idle()) open(reclaimed);
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    document.removeEventListener('visibilitychange', reclaim);
    source?.close();
    source = null;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    halted = null;
  };
}

/** Tells the other listeners of this tab the new count (the page marked notifications read). */
export function announceUnread(unreadCount: number) {
  emit({ type: 'unread', unreadCount });
}

/**
 * Calls `onEvent` with each live event while the component is mounted and `enabled` (signed in:
 * a signed-out page never opens the stream, audit A07-2).
 */
export function useNotificationEvents(onEvent: Listener, enabled = true) {
  const latest = useRef(onEvent);
  latest.current = onEvent;
  useEffect(() => (enabled ? subscribe((event) => latest.current(event)) : undefined), [enabled]);
}

/**
 * The notifications that follow a change of the wallet's balance: a credit, an adjustment, a
 * refund, a reservation paid, an admin purchase charged to the customer (audit A6).
 */
const MONEY_EVENTS: ReadonlySet<CustomerNotification['event']> = new Set([
  'deposit_credited',
  'wallet_adjusted',
  'order_refunded',
  'order_partially_refunded',
  'order_paid',
  'order_placed_for_you',
]);

/** Whether a live event changes the wallet's balance or a deposit (rule NT7). */
export function isMoneyEvent(event: LiveEvent): boolean {
  return (
    event.type === 'resync' ||
    (event.type === 'notification' && MONEY_EVENTS.has(event.notification.event))
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
