/*
 * The push rules the store decides on the device (S15 PC1, PS6, PS7), pure so they are tested
 * without a browser. No contracts import: the order and deposit pages load this before the card.
 */

/**
 * What this browser can do: push itself, iOS/iPadOS Safari outside the installed app (push needs
 * the app first, PC3), or nothing (old browsers, in-app webviews, edge case 12).
 */
export type PushSupport = 'push' | 'ios-install' | 'none';

/** `Notification.permission`, or `default` where it does not exist (iOS not installed). */
export type Permission = 'default' | 'granted' | 'denied';

/** A closed card stays away this long on the device (PC1). */
export const CARD_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

/** iPhone, iPod, or an iPad (which reports itself as a Mac with touch). */
export function isAppleMobile(userAgent: string, maxTouchPoints: number): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}

/** Safari itself, not Chrome, Firefox or Edge on iOS (each adds its own token). */
export function isSafari(userAgent: string): boolean {
  return /Safari\//.test(userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(userAgent);
}

export function pushSupport(device: {
  userAgent: string;
  maxTouchPoints: number;
  standalone: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
}): PushSupport {
  if (device.hasServiceWorker && device.hasPushManager && device.hasNotification) return 'push';
  const ios = isAppleMobile(device.userAgent, device.maxTouchPoints);
  return ios && isSafari(device.userAgent) && !device.standalone ? 'ios-install' : 'none';
}

/**
 * PC1: the permission card shows only when push is configured, the browser can do it (or is iOS
 * Safari outside the app), the prompt was never answered, this device has no subscription, and
 * the card was not closed here in the last 30 days.
 */
export function cardVisible(state: {
  configured: boolean;
  support: PushSupport;
  permission: Permission;
  subscribed: boolean;
  dismissedAt: number | null;
  now: number;
}): boolean {
  if (!state.configured || state.support === 'none' || state.subscribed) return false;
  if (state.support === 'push' && state.permission !== 'default') return false;
  return state.dismissedAt === null || state.now - state.dismissedAt >= CARD_SNOOZE_MS;
}

/**
 * PS6, PS7: on a signed-in page load, once per tab session, a device that already allowed push
 * re-registers the subscription it holds (`register`), or replaces one made with another key
 * (`resubscribe`). A browser without a subscription is never subscribed here: that needs a tap.
 */
export function refreshStep(state: {
  permission: Permission;
  subscription: { sameKey: boolean } | null;
  refreshedThisTab: boolean;
}): 'none' | 'register' | 'resubscribe' {
  if (state.refreshedThisTab || state.permission !== 'granted' || !state.subscription)
    return 'none';
  return state.subscription.sameKey ? 'register' : 'resubscribe';
}

/** The bytes of a base64url string (the VAPID public key the API serves). */
export function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** PS7: whether a subscription's `options.applicationServerKey` is the served public key. */
export function sameKey(applicationServerKey: ArrayBuffer | null, publicKey: string): boolean {
  if (!applicationServerKey) return false;
  const current = new Uint8Array(applicationServerKey);
  const served = base64UrlBytes(publicKey);
  return current.length === served.length && current.every((byte, index) => byte === served[index]);
}
