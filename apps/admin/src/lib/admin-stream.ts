import type { AdminStreamEvent } from '@vertex-digital/contracts';
import { useEffect, useRef, useSyncExternalStore } from 'react';

/*
 * The admin stream (S11 rule LR4): one `EventSource` per tab on `/api/admin/stream`, shared by the
 * live room and the dashboard, open while one of them is mounted. An `order` event names an order
 * whose status changed; `resync` asks the listeners to read again (the API's LISTEN connection
 * dropped, or this stream reopened and may have missed events). `EventSource` reconnects on its
 * own after a network drop but closes for good on any answer other than 200 (a 502 while the API
 * restarts, a 429): it is then opened again after 5 seconds, doubling up to a minute. `EventSource`
 * cannot send `X-Background-Request`: the API marks the route as never counting as activity.
 * The API keeps 3 admin streams: a 4th sends `replaced` to the oldest, which then stays closed
 * (reconnecting would close the next oldest, and so on) until its tab is looked at again.
 */

export type AdminLiveEvent = { type: 'order'; order: AdminStreamEvent } | { type: 'resync' };

/** "مباشر" or "إعادة الاتصال…" (rule LR5). */
export type StreamState = 'live' | 'reconnecting';

type Listener = (event: AdminLiveEvent) => void;

/** A drop shorter than this (the browser's own reconnect) keeps "مباشر" on screen. */
const RECONNECTING_AFTER_MS = 5_000;
const FIRST_RETRY_MS = 5_000;
const MAX_RETRY_MS = 60_000;

const listeners = new Set<Listener>();
const stateListeners = new Set<() => void>();
let source: EventSource | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let downTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = FIRST_RETRY_MS;
let state: StreamState = 'reconnecting';
/** A newer stream (another tab) took this one's place. */
let replaced = false;

function emit(event: AdminLiveEvent) {
  for (const listener of listeners) listener(event);
}

function setState(next: StreamState) {
  if (downTimer) clearTimeout(downTimer);
  downTimer = null;
  if (state === next) return;
  state = next;
  for (const listener of stateListeners) listener();
}

function dropped() {
  if (downTimer || state === 'reconnecting') return;
  downTimer = setTimeout(() => setState('reconnecting'), RECONNECTING_AFTER_MS);
}

function open(reopened = false) {
  const current = new EventSource('/api/admin/stream');
  source = current;
  // Every open but the first may have missed events: the listeners read again.
  let missed = reopened;
  current.addEventListener('open', () => {
    retryDelay = FIRST_RETRY_MS;
    setState('live');
    if (missed) emit({ type: 'resync' });
    missed = true;
  });
  current.addEventListener('error', () => {
    if (source !== current) return;
    dropped();
    if (current.readyState !== EventSource.CLOSED) return;
    source = null;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (listeners.size > 0 && !source) open(true);
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
  });
  current.addEventListener('order', (message) =>
    emit({ type: 'order', order: JSON.parse(message.data) as AdminStreamEvent }),
  );
  current.addEventListener('resync', () => emit({ type: 'resync' }));
  current.addEventListener('replaced', () => {
    current.close();
    if (source === current) source = null;
    replaced = true;
    setState('reconnecting');
  });
}

/** The tab is looked at again: it takes the stream back from the others (and reads again). */
function reclaim() {
  if (document.visibilityState !== 'visible' || !replaced || listeners.size === 0) return;
  replaced = false;
  if (!source && !retryTimer) open(true);
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  if (listeners.size === 1) document.addEventListener('visibilitychange', reclaim);
  replaced = false;
  if (!source && !retryTimer) open();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    document.removeEventListener('visibilitychange', reclaim);
    source?.close();
    source = null;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    setState('reconnecting');
  };
}

/** Calls `onEvent` with each admin stream event while the component is mounted. */
export function useAdminStream(onEvent: Listener) {
  const latest = useRef(onEvent);
  latest.current = onEvent;
  useEffect(() => subscribe((event) => latest.current(event)), []);
}

/** Whether the stream is open, for the header's indicator (rule LR5). */
export function useStreamState(): StreamState {
  return useSyncExternalStore(
    (listener) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    () => state,
  );
}

/**
 * Calls `onVisible` when the tab comes back into view (rule LR5): a page showing live state reads
 * it again, in case an event was missed while the tab slept.
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

/**
 * `run` at most once per `delayMs` window, at its end (rule LR5: the board reads again 1 second
 * after a burst of events, the dashboard 10 seconds after).
 */
export function useDebounced(run: () => void, delayMs: number): () => void {
  const latest = useRef(run);
  latest.current = run;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const schedule = useRef(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      latest.current();
    }, delayMs);
  });
  return schedule.current;
}
