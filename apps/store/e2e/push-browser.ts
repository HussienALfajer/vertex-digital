import type { Page } from '@playwright/test';

/*
 * The browser's push side for S15 tests: headless Chromium cannot reach a real push service, so
 * `Notification`, the service worker registration and its `PushManager` are replaced before the
 * page loads. What the store does with them (asks, subscribes, unsubscribes, sends to the API) is
 * what the tests check; `window.__push` records it.
 */

/** A VAPID public key (65 bytes, base64url): what `GET /api/push/config` serves in these tests. */
export const PUBLIC_KEY =
  'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';

/** Another key: a subscription made before a rotation (PS7). */
export const OLD_KEY =
  'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';

export const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/e2e-device';

export interface PushBrowser {
  /** `Notification.permission` at load. */
  permission: 'default' | 'granted' | 'denied';
  /** What the prompt answers when the store asks. */
  answer?: 'default' | 'granted' | 'denied';
  /** The key of the subscription this browser already holds, or none. */
  heldKey?: string | null;
}

export interface PushRecord {
  asked: number;
  subscribed: number;
  unsubscribed: number;
}

export async function pushBrowser(page: Page, browser: PushBrowser): Promise<void> {
  await page.addInitScript(
    ({ permission, answer, heldKey, endpoint }) => {
      const bytes = (value: string) => {
        const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
        const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
        return Uint8Array.from(binary, (char) => char.charCodeAt(0)).buffer;
      };
      const record = { asked: 0, subscribed: 0, unsubscribed: 0 };
      (window as unknown as { __push: typeof record }).__push = record;
      const keys = {
        p256dh: `BA${'A'.repeat(85)}`,
        auth: 'AAAAAAAAAAAAAAAAAAAAAA',
      };
      let held: ReturnType<typeof subscription> | null = null;
      const subscription = (key: ArrayBuffer) => ({
        endpoint,
        options: { applicationServerKey: key, userVisibleOnly: true },
        toJSON: () => ({ endpoint, expirationTime: null, keys }),
        unsubscribe: async () => {
          record.unsubscribed++;
          // Kept through a navigation of this tab (sign-out loads `/`).
          sessionStorage.setItem('e2e-push-unsubscribed', String(record.unsubscribed));
          held = null;
          keep();
          return true;
        },
      });
      // The browser keeps its permission and subscription across loads of this tab.
      const kept = JSON.parse(sessionStorage.getItem('e2e-push-state') ?? 'null') as {
        permission: typeof permission;
        heldKey: string | null;
      } | null;
      const keyText = (key: ArrayBuffer) =>
        btoa(String.fromCharCode(...new Uint8Array(key)))
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');
      const startKey = kept ? kept.heldKey : heldKey;
      if (startKey) held = subscription(bytes(startKey));
      const keep = () =>
        sessionStorage.setItem(
          'e2e-push-state',
          JSON.stringify({
            permission: current,
            heldKey: held ? keyText(held.options.applicationServerKey) : null,
          }),
        );
      const registration = {
        scope: `${location.origin}/`,
        pushManager: {
          getSubscription: async () => held,
          subscribe: async (options: { applicationServerKey: Uint8Array }) => {
            record.subscribed++;
            held = subscription(options.applicationServerKey.slice().buffer);
            keep();
            return held;
          },
        },
      };
      const container = {
        register: async () => registration,
        getRegistration: async () => registration,
        ready: Promise.resolve(registration),
      };
      Object.defineProperty(Navigator.prototype, 'serviceWorker', {
        configurable: true,
        get: () => container,
      });
      let current = kept ? kept.permission : permission;
      Object.defineProperty(window, 'Notification', {
        configurable: true,
        writable: true,
        value: {
          get permission() {
            return current;
          },
          requestPermission: async () => {
            record.asked++;
            current = answer ?? current;
            keep();
            return current;
          },
        },
      });
      Object.defineProperty(window, 'PushManager', { configurable: true, value: () => {} });
    },
    {
      permission: browser.permission,
      answer: browser.answer,
      heldKey: browser.heldKey ?? null,
      endpoint: ENDPOINT,
    },
  );
}

export function pushRecord(page: Page): Promise<PushRecord> {
  return page.evaluate(() => (window as unknown as { __push: PushRecord }).__push);
}

/** iPhone Safari outside the installed app: no `PushManager`, no `Notification` (PC3). */
export const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

export async function iphoneSafari(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const scope = window as Partial<Record<'PushManager' | 'Notification', unknown>>;
    delete scope.PushManager;
    delete scope.Notification;
  });
}
