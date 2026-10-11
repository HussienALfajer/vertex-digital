import { describe, expect, it } from 'vitest';
import {
  base64UrlByteLength,
  PUSH_ENDPOINT_MAX,
  pushEndpointAllowed,
  pushSubscriptionSchema,
  removePushSubscriptionSchema,
  vapidKeyId,
} from './push.js';

const p256dh = `B${'A'.repeat(86)}`;
const auth = 'A'.repeat(22);

describe('push endpoints (PS2)', () => {
  it('allow https on the listed push services', () => {
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/abc:def',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAA',
      'https://web.push.apple.com/QGx_abc',
      'https://wns2-par02p.notify.windows.com/w/?token=BQYAAA',
      'https://fcm.googleapis.com:443/fcm/send/abc',
    ])
      expect(pushEndpointAllowed(endpoint), endpoint).toBe(true);
  });

  it('refuse other hosts, http, ports, user info, IP hosts and junk', () => {
    for (const endpoint of [
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://fcm.googleapis.com:8443/fcm/send/abc',
      'https://user:pass@fcm.googleapis.com/fcm/send/abc',
      'https://user@fcm.googleapis.com/fcm/send/abc',
      'https://127.0.0.1/push',
      'https://[::1]/push',
      'https://10.0.0.5:443/push',
      'https://evil.example/fcm.googleapis.com',
      'https://fcm.googleapis.com.evil.example/send',
      'https://notify.windows.com/w',
      'https://.notify.windows.com/w',
      'https://evilnotify.windows.com/w',
      'https://localhost/push',
      'not a url',
      `https://fcm.googleapis.com/${'a'.repeat(PUSH_ENDPOINT_MAX)}`,
    ])
      expect(pushEndpointAllowed(endpoint), endpoint).toBe(false);
  });
});

describe('subscription keys', () => {
  it('measure base64url', () => {
    expect(base64UrlByteLength(auth)).toBe(16);
    expect(base64UrlByteLength(`${auth}==`)).toBe(16);
    expect(base64UrlByteLength(p256dh)).toBe(65);
    expect(base64UrlByteLength('')).toBe(0);
    expect(base64UrlByteLength('A')).toBeNull();
    expect(base64UrlByteLength('ab+/')).toBeNull();
    expect(base64UrlByteLength('ab=c')).toBeNull();
  });

  it('accept the browser subscription and refuse wrong key lengths', () => {
    const subscription = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      expirationTime: null,
      keys: { p256dh, auth },
    };
    expect(pushSubscriptionSchema.safeParse(subscription).success).toBe(true);
    const { expirationTime: _, ...withoutExpiry } = subscription;
    expect(pushSubscriptionSchema.safeParse(withoutExpiry).success).toBe(true);
    expect(
      pushSubscriptionSchema.safeParse({ ...subscription, keys: { p256dh, auth: `${auth}AA` } })
        .success,
    ).toBe(false);
    expect(
      pushSubscriptionSchema.safeParse({ ...subscription, keys: { p256dh: auth, auth } }).success,
    ).toBe(false);
    expect(
      pushSubscriptionSchema.safeParse({ ...subscription, keys: { p256dh, auth: 'A'.repeat(21) } })
        .success,
    ).toBe(false);
    expect(
      removePushSubscriptionSchema.safeParse({ endpoint: subscription.endpoint }).success,
    ).toBe(true);
    expect(removePushSubscriptionSchema.safeParse({ endpoint: '' }).success).toBe(false);
  });

  it('name the VAPID key by its first 16 characters (PS7)', () => {
    expect(vapidKeyId(p256dh)).toBe(p256dh.slice(0, 16));
    expect(vapidKeyId(p256dh)).toHaveLength(16);
  });
});
