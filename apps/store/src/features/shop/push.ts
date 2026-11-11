import type { Failure } from '@/lib/api';
import { devicePermission, deviceSupport, pushPublicKey } from '../push/device';
import { base64UrlBytes, sameKey } from '../push/rules';
import { shopScope } from './paths';
import { deleteShopPushSubscription, saveShopPushSubscription } from './requests';

/*
 * A shop customer's push on this device (S26 SP1, S15 PS1, PC2, PC4): the subscription belongs to
 * the shop's own worker (`/s/<slug>/sw.js`, scoped to the shop), never the store's, and is
 * registered with the shop's API. The VAPID key is the store's.
 */

export { devicePermission, deviceSupport, pushPublicKey };

async function registration(slug: string): Promise<ServiceWorkerRegistration | undefined> {
  return navigator.serviceWorker.getRegistration(shopScope(slug));
}

/** The subscription this browser holds for the shop, or null. */
export async function shopSubscription(slug: string): Promise<PushSubscription | null> {
  try {
    const held = await registration(slug);
    // `getRegistration` answers the closest scope: the store's worker is not the shop's.
    if (!held || new URL(held.scope).pathname !== shopScope(slug)) return null;
    return (await held.pushManager.getSubscription()) ?? null;
  } catch {
    return null;
  }
}

export type ShopEnableOutcome =
  | { outcome: 'enabled' }
  | { outcome: 'denied' }
  | { outcome: 'dismissed' }
  | { outcome: 'failed'; reason: Failure };

/** PC2: permission, the shop worker's subscription, then the shop's API. */
export async function enableShopPush(slug: string, publicKey: string): Promise<ShopEnableOutcome> {
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
    const held = await shopSubscription(slug);
    if (held && sameKey(held.options.applicationServerKey, publicKey)) {
      subscription = held;
    } else {
      await held?.unsubscribe();
      const scope = shopScope(slug);
      const worker = await navigator.serviceWorker.register(`${scope}/sw.js`, { scope });
      await waitActive(worker);
      subscription = await worker.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlBytes(publicKey),
      });
    }
  } catch {
    return { outcome: 'failed', reason: 'UNKNOWN' };
  }
  const saved = await saveShopPushSubscription(slug, subscription.toJSON());
  return saved.ok ? { outcome: 'enabled' } : { outcome: 'failed', reason: saved.reason };
}

/** A fresh registration subscribes only once its worker is active. */
function waitActive(worker: ServiceWorkerRegistration): Promise<void> {
  if (worker.active) return Promise.resolve();
  const installing = worker.installing ?? worker.waiting;
  if (!installing) return Promise.resolve();
  return new Promise((resolve) => {
    installing.addEventListener('statechange', () => {
      if (installing.state === 'activated') resolve();
    });
  });
}

/** PC4 off: the API row first, then the browser's subscription. */
export async function disableShopPush(
  slug: string,
): Promise<{ ok: true } | { ok: false; reason: Failure }> {
  const subscription = await shopSubscription(slug);
  if (!subscription) return { ok: true };
  const removed = await deleteShopPushSubscription(slug, subscription.endpoint);
  if (!removed.ok) return { ok: false, reason: removed.reason };
  await subscription.unsubscribe().catch(() => false);
  return { ok: true };
}

/** PS5 at sign-out: the browser forgets the shop's subscription, never longer than a moment. */
export function forgetShopDevice(slug: string): Promise<void> {
  if (!('serviceWorker' in navigator)) return Promise.resolve();
  const unsubscribe = shopSubscription(slug).then((held) => held?.unsubscribe().catch(() => false));
  const moment = new Promise((resolve) => setTimeout(resolve, 1_500));
  return Promise.race([unsubscribe, moment]).then(() => undefined);
}
