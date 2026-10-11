import { apiRequest, type Failure } from '@/lib/api';
import { readSession } from '@/lib/session';
import {
  base64UrlBytes,
  type Permission,
  type PushSupport,
  pushSupport,
  refreshStep,
  sameKey,
} from './rules';

/*
 * This device's push subscription (S15 PS1, PS5–PS8, PC2, PC4): the browser's `PushManager`
 * behind the service worker that `/sw.js` registers (SW2), and the API's
 * `/api/push/subscription`. Never throws: every step answers what happened.
 */

/** The browser can do push, or is iOS Safari outside the installed app (PC3). */
export function deviceSupport(): PushSupport {
  const standalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
  return pushSupport({
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints,
    standalone,
    hasServiceWorker: 'serviceWorker' in navigator,
    hasPushManager: 'PushManager' in window,
    hasNotification: 'Notification' in window,
  });
}

export function devicePermission(): Permission {
  return 'Notification' in window ? Notification.permission : 'default';
}

let config: Promise<string | null> | undefined;

/**
 * The VAPID public key, or null when push is not configured (or the read failed: no push
 * controls then). Read once per page load; the API caches it for 5 minutes.
 */
export function pushPublicKey(): Promise<string | null> {
  config ??= apiRequest<{ publicKey: string | null }>('/api/push/config').then((result) =>
    result.ok ? result.data.publicKey : null,
  );
  return config;
}

/** The subscription this browser holds for the store, or null (none, or no worker yet). */
export async function currentSubscription(): Promise<PushSubscription | null> {
  try {
    const registration = await navigator.serviceWorker.getRegistration('/');
    return (await registration?.pushManager.getSubscription()) ?? null;
  } catch {
    return null;
  }
}

/** Sends the browser's subscription to the API (PS1): new, moved to this session, or refreshed. */
function register(subscription: PushSubscription) {
  return apiRequest<null>('/api/push/subscription', {
    method: 'PUT',
    body: subscription.toJSON(),
  });
}

async function subscribe(publicKey: string): Promise<PushSubscription> {
  // The layout registers the worker after `load`; registering again answers the same one.
  await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlBytes(publicKey),
  });
}

export type EnableOutcome =
  | { outcome: 'enabled' }
  | { outcome: 'denied' }
  | { outcome: 'dismissed' }
  | { outcome: 'failed'; reason: Failure };

/**
 * PC2: the customer's tap. Asks for permission (no prompt when already granted), subscribes with
 * the served key and registers the subscription.
 */
export async function enablePush(publicKey: string): Promise<EnableOutcome> {
  let permission: NotificationPermission;
  try {
    permission = await Notification.requestPermission();
  } catch {
    return { outcome: 'failed', reason: 'UNKNOWN' };
  }
  if (permission === 'denied') return { outcome: 'denied' };
  if (permission !== 'granted') return { outcome: 'dismissed' };
  let subscription: PushSubscription;
  try {
    const held = await currentSubscription();
    if (held && sameKey(held.options.applicationServerKey, publicKey)) {
      subscription = held;
    } else {
      // A subscription made with another key cannot receive our pushes (PS7).
      await held?.unsubscribe();
      subscription = await subscribe(publicKey);
    }
  } catch {
    return { outcome: 'failed', reason: 'UNKNOWN' };
  }
  const registered = await register(subscription);
  return registered.ok ? { outcome: 'enabled' } : { outcome: 'failed', reason: registered.reason };
}

/** PC4 off: the browser forgets the subscription, then the API deletes its row (PS8). */
export async function disablePush(): Promise<{ ok: true } | { ok: false; reason: Failure }> {
  const subscription = await currentSubscription();
  if (!subscription) return { ok: true };
  const { endpoint } = subscription;
  await subscription.unsubscribe().catch(() => false);
  const removed = await apiRequest<null>('/api/push/subscription', {
    method: 'DELETE',
    body: { endpoint },
  });
  return removed.ok ? { ok: true } : { ok: false, reason: removed.reason };
}

/**
 * PS5: on sign-out the browser forgets its subscription, best effort and never longer than a
 * moment: the server row goes with the session anyway.
 */
export function forgetDevice(): Promise<void> {
  if (!('serviceWorker' in navigator)) return Promise.resolve();
  const unsubscribe = currentSubscription().then((subscription) =>
    subscription?.unsubscribe().catch(() => false),
  );
  const moment = new Promise((resolve) => setTimeout(resolve, 1_500));
  return Promise.race([unsubscribe, moment]).then(() => undefined);
}

const REFRESHED_KEY = 'vd-push-refreshed';

/**
 * Which session this tab last registered the subscription with: a digest of the session token,
 * never the token itself. A new sign-in in the same tab (after an expiry or a revoke elsewhere)
 * has another digest, so the device is rebound to it (PS6).
 */
async function sessionDigest(): Promise<string | null> {
  const token = (await readSession())?.session?.token;
  if (!token) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest).slice(0, 8), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/**
 * PS6, PS7 on a signed-in page load: a device that allowed push and holds a subscription
 * registers it again once per session in this tab (rebinding it to this session), or replaces
 * one made with another key. Nothing is asked of the customer.
 */
export async function refreshDevice(): Promise<void> {
  if (deviceSupport() !== 'push' || devicePermission() !== 'granted') return;
  const session = await sessionDigest().catch(() => null);
  if (!session) return;
  let refreshedThisTab = false;
  try {
    refreshedThisTab = sessionStorage.getItem(REFRESHED_KEY) === session;
  } catch {}
  if (refreshedThisTab) return;
  const publicKey = await pushPublicKey();
  if (!publicKey) return;
  const held = await currentSubscription();
  const step = refreshStep({
    permission: devicePermission(),
    subscription: held && { sameKey: sameKey(held.options.applicationServerKey, publicKey) },
    refreshedThisTab,
  });
  if (step === 'none' || !held) return;
  try {
    let subscription = held;
    if (step === 'resubscribe') {
      await held.unsubscribe();
      subscription = await subscribe(publicKey);
    }
    const registered = await register(subscription);
    if (!registered.ok) return;
    try {
      sessionStorage.setItem(REFRESHED_KEY, session);
    } catch {}
  } catch {}
}
