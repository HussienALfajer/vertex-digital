import { describe, expect, it } from 'vitest';
import {
  base64UrlBytes,
  CARD_SNOOZE_MS,
  cardVisible,
  pushSupport,
  refreshStep,
  sameKey,
} from './rules';

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1';
const IPAD_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const ANDROID_CHROME =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';

const browser = {
  userAgent: ANDROID_CHROME,
  maxTouchPoints: 5,
  standalone: false,
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
};
const noPush = { hasServiceWorker: true, hasPushManager: false, hasNotification: false };

describe('pushSupport', () => {
  it('is push where the browser has a service worker, PushManager and Notification', () => {
    expect(pushSupport(browser)).toBe('push');
    // The installed iPhone app from iOS 16.4.
    expect(pushSupport({ ...browser, userAgent: IPHONE_SAFARI, standalone: true })).toBe('push');
  });

  it('asks iOS and iPadOS Safari outside the app to install first (PC3)', () => {
    expect(pushSupport({ ...browser, ...noPush, userAgent: IPHONE_SAFARI })).toBe('ios-install');
    expect(pushSupport({ ...browser, ...noPush, userAgent: IPAD_SAFARI })).toBe('ios-install');
  });

  it('offers nothing to other browsers without push (edge case 12)', () => {
    expect(pushSupport({ ...browser, ...noPush, userAgent: IPHONE_CHROME })).toBe('none');
    // A Mac without touch is not an iPad.
    expect(pushSupport({ ...browser, ...noPush, userAgent: IPAD_SAFARI, maxTouchPoints: 0 })).toBe(
      'none',
    );
    expect(pushSupport({ ...browser, ...noPush })).toBe('none');
    expect(pushSupport({ ...browser, ...noPush, userAgent: IPHONE_SAFARI, standalone: true })).toBe(
      'none',
    );
  });
});

describe('cardVisible (PC1)', () => {
  const now = Date.UTC(2026, 9, 11);
  const offer = {
    configured: true,
    support: 'push' as const,
    permission: 'default' as const,
    subscribed: false,
    dismissedAt: null,
    now,
  };

  it('shows when every condition holds', () => {
    expect(cardVisible(offer)).toBe(true);
    expect(cardVisible({ ...offer, support: 'ios-install' })).toBe(true);
  });

  it('hides without push, without support, once answered, or with a subscription', () => {
    expect(cardVisible({ ...offer, configured: false })).toBe(false);
    expect(cardVisible({ ...offer, support: 'none' })).toBe(false);
    expect(cardVisible({ ...offer, permission: 'granted' })).toBe(false);
    expect(cardVisible({ ...offer, permission: 'denied' })).toBe(false);
    expect(cardVisible({ ...offer, subscribed: true })).toBe(false);
  });

  it('stays away for 30 days after it was closed on this device', () => {
    expect(cardVisible({ ...offer, dismissedAt: now - CARD_SNOOZE_MS + 1 })).toBe(false);
    expect(cardVisible({ ...offer, dismissedAt: now - CARD_SNOOZE_MS })).toBe(true);
  });
});

describe('refreshStep (PS6, PS7)', () => {
  it('re-registers a held subscription once per tab session where push was allowed', () => {
    const state = {
      permission: 'granted' as const,
      subscription: { sameKey: true },
      refreshedThisTab: false,
    };
    expect(refreshStep(state)).toBe('register');
    expect(refreshStep({ ...state, refreshedThisTab: true })).toBe('none');
    expect(refreshStep({ ...state, permission: 'default' })).toBe('none');
    expect(refreshStep({ ...state, permission: 'denied' })).toBe('none');
  });

  it('never subscribes a browser that holds no subscription', () => {
    expect(
      refreshStep({ permission: 'granted', subscription: null, refreshedThisTab: false }),
    ).toBe('none');
  });

  it('replaces a subscription made with another key', () => {
    expect(
      refreshStep({
        permission: 'granted',
        subscription: { sameKey: false },
        refreshedThisTab: false,
      }),
    ).toBe('resubscribe');
  });
});

describe('sameKey (PS7)', () => {
  const key =
    'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
  const bytes = base64UrlBytes(key);

  it('compares the subscription key with the served one byte for byte', () => {
    expect(bytes.length).toBe(65);
    expect(sameKey(bytes.buffer, key)).toBe(true);
    const other = bytes.slice();
    other[10] = (other[10] ?? 0) ^ 1;
    expect(sameKey(other.buffer, key)).toBe(false);
    expect(sameKey(null, key)).toBe(false);
    expect(sameKey(new Uint8Array(16).buffer, key)).toBe(false);
  });
});
