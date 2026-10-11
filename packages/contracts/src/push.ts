import { z } from 'zod';

/*
 * Web push (S15 F24), owned by the api `notifications` module: a device registers the browser's
 * subscription, made with the store's VAPID public key, and the worker sends each customer event
 * that has an email to it too (rule PD1). The events are `PUSH_NOTIFICATION_EVENTS` in
 * `notifications.ts`, beside the preferences.
 */

/**
 * The push services a subscription may point to (rule PS2): FCM, Mozilla autopush, Apple, and
 * WNS under `.notify.windows.com`. Adding one is a code change with review: the worker POSTs to
 * the URL a customer gave us.
 */
export const PUSH_SERVICE_HOSTS = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
] as const;

/** WNS (Edge) endpoints live on per-region subdomains of this host. */
export const PUSH_SERVICE_HOST_SUFFIX = '.notify.windows.com';

/** A customer's devices (rule PS3): registering one more removes the oldest. */
export const PUSH_SUBSCRIPTIONS_MAX = 10;

/** Registrations and removals an hour per customer (S15 API). */
export const PUSH_CHANGES_PER_HOUR = 20;

/** The longest endpoint stored (S15 data). */
export const PUSH_ENDPOINT_MAX = 1_024;

/**
 * Rule PS2: an `https:` URL on an allowed push service, with no port, no user info and no IP
 * address as host (the allowed names already exclude an IP; a port or user info is refused even
 * on an allowed name). The API checks it at registration and the worker before every send.
 */
export function pushEndpointAllowed(endpoint: string): boolean {
  if (endpoint.length > PUSH_ENDPOINT_MAX || !URL.canParse(endpoint)) return false;
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '')
    return false;
  return (
    (PUSH_SERVICE_HOSTS as readonly string[]).includes(url.hostname) ||
    (url.hostname.endsWith(PUSH_SERVICE_HOST_SUFFIX) &&
      url.hostname.length > PUSH_SERVICE_HOST_SUFFIX.length)
  );
}

/**
 * The number of bytes a base64url string decodes to, or null when it is not base64url (padding
 * allowed, as some browsers send it).
 */
export function base64UrlByteLength(value: string): number | null {
  const body = /^([A-Za-z0-9_-]*)={0,2}$/.exec(value)?.[1];
  if (body === undefined || body.length % 4 === 1) return null;
  return Math.floor((body.length * 3) / 4);
}

const base64UrlBytes = (bytes: number, what: string) =>
  z
    .string()
    .max(256)
    .refine((value) => base64UrlByteLength(value) === bytes, {
      message: `${what} must be base64url of ${bytes} bytes`,
    });

/**
 * A subscription's key id (rule PS7): the first 16 characters of the base64url VAPID public key
 * it was made with. Rows of another key are skipped and deleted by the worker.
 */
export function vapidKeyId(publicKey: string): string {
  return publicKey.slice(0, 16);
}

/**
 * The browser's `PushSubscription.toJSON()` (rule PS1). The endpoint is any string here: a
 * refused endpoint answers `PUSH_ENDPOINT_REFUSED` (rule PS2), not `VALIDATION_FAILED`.
 */
export const pushSubscriptionSchema = z
  .object({
    endpoint: z.string().min(1).max(PUSH_ENDPOINT_MAX),
    expirationTime: z.number().nullish(),
    keys: z.object({
      /** The browser's P-256 public key, uncompressed. */
      p256dh: base64UrlBytes(65, 'p256dh'),
      /** The browser's auth secret. */
      auth: base64UrlBytes(16, 'auth'),
    }),
  })
  .meta({ id: 'PushSubscription' });

export type PushSubscription = z.infer<typeof pushSubscriptionSchema>;

/** `DELETE /api/push/subscription` (rule PS8). */
export const removePushSubscriptionSchema = pushSubscriptionSchema
  .pick({ endpoint: true })
  .meta({ id: 'RemovePushSubscription' });

export type RemovePushSubscription = z.infer<typeof removePushSubscriptionSchema>;

/** `GET /api/push/config`: push is configured when the API has a public key (S15 environment). */
export const pushConfigSchema = z
  .object({ publicKey: z.string().nullable() })
  .meta({ id: 'PushConfig' });

export type PushConfig = z.infer<typeof pushConfigSchema>;
