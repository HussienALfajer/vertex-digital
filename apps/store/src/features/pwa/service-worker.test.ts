import { describe, expect, it, vi } from 'vitest';
import { serviceWorkerScript } from './service-worker';

const ORIGIN = 'https://digital.vertexmedia.pro';

type Listener = (event: Record<string, unknown>) => void;

/** Runs `/sw.js` against fakes of the worker's globals and answers its listeners. */
function load(version = 'build-2') {
  const listeners = new Map<string, Listener>();
  const stored = new Map<string, Map<string, string>>([['vd-offline-build-1', new Map()]]);
  const caches = {
    open: vi.fn(async (name: string) => {
      const entries = stored.get(name) ?? new Map<string, string>();
      stored.set(name, entries);
      return {
        add: async (request: Request) => entries.set(new URL(request.url).pathname, 'offline'),
        match: async (path: string) => (entries.has(path) ? { offline: path } : undefined),
      };
    }),
    keys: async () => [...stored.keys(), 'someone-else'],
    delete: vi.fn(async (name: string) => stored.delete(name)),
  };
  const windows: { url: string; focus: () => Promise<unknown>; navigate: (url: string) => void }[] =
    [];
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    skipWaiting: vi.fn(async () => {}),
    clients: {
      claim: vi.fn(async () => {}),
      matchAll: async () => windows,
      openWindow: vi.fn(async () => null),
    },
    registration: { showNotification: vi.fn(async () => {}) },
  };
  const network = vi.fn(async (_request: unknown) => ({ online: true }));
  class FakeRequest {
    constructor(readonly url: string) {}
  }
  new Function(
    'self',
    'caches',
    'fetch',
    'Request',
    'Response',
    serviceWorkerScript({
      version,
      icon: '/_next/static/media/icon-192.png',
      badge: '/_next/static/media/badge-96.png',
      fallbackBody: 'لديك إشعار جديد',
    }),
  )(
    self,
    caches,
    network,
    function (this: unknown, url: string) {
      return new FakeRequest(new URL(url, ORIGIN).href);
    },
    { error: () => ({ error: true }) },
  );

  /** Dispatches an event and waits for what it gave `waitUntil` or `respondWith`. */
  const dispatch = async (type: string, event: Record<string, unknown> = {}) => {
    let pending: Promise<unknown> | undefined;
    let response: Promise<unknown> | undefined;
    listeners.get(type)?.({
      ...event,
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise;
      },
      respondWith: (promise: Promise<unknown>) => {
        response = promise;
      },
    });
    await pending;
    return response;
  };
  return { self, caches, stored, windows, network, dispatch };
}

const pushed = async (data: unknown) => {
  const worker = load();
  await worker.dispatch('push', {
    data:
      data === undefined
        ? null
        : {
            json: () => (typeof data === 'string' ? JSON.parse(data) : data),
          },
  });
  return worker.self.registration.showNotification.mock.calls[0] as unknown as [
    string,
    Record<string, unknown>,
  ];
};

describe('/sw.js', () => {
  it('caches only the offline page under the build id, then takes over at once (SW1, SW3)', async () => {
    const worker = load();
    await worker.dispatch('install');
    expect([...(worker.stored.get('vd-offline-build-2')?.keys() ?? [])]).toEqual(['/offline']);
    expect(worker.self.skipWaiting).toHaveBeenCalled();
    await worker.dispatch('activate');
    expect(worker.caches.delete.mock.calls.map(([name]) => name)).toEqual(['vd-offline-build-1']);
    expect(worker.self.clients.claim).toHaveBeenCalled();
  });

  it('leaves every request but a GET navigation to the browser (SW3, SW4)', async () => {
    const worker = load();
    for (const request of [
      { mode: 'cors', method: 'GET', url: `${ORIGIN}/api/wallet` },
      { mode: 'no-cors', method: 'GET', url: `${ORIGIN}/_next/static/chunk.js` },
      { mode: 'navigate', method: 'POST', url: `${ORIGIN}/sign-in` },
    ]) {
      expect(await worker.dispatch('fetch', { request })).toBeUndefined();
    }
    expect(worker.network).not.toHaveBeenCalled();
  });

  it('answers a navigation from the network, and the kept offline page when it fails (SW3)', async () => {
    const worker = load();
    await worker.dispatch('install');
    const request = { mode: 'navigate', method: 'GET', url: `${ORIGIN}/wallet` };
    expect(await worker.dispatch('fetch', { request })).toEqual({ online: true });
    worker.network.mockRejectedValueOnce(new TypeError('offline'));
    expect(await worker.dispatch('fetch', { request })).toEqual({ offline: '/offline' });
  });

  it('shows a push with its tag, the icons and an RTL Arabic text (SW6)', async () => {
    const [title, options] = await pushed({
      title: 'VERTEX DIGITAL',
      body: 'تم تسليم طلبك VD-123',
      url: '/orders/0193',
      tag: 'order-0193',
    });
    expect(title).toBe('VERTEX DIGITAL');
    expect(options).toEqual({
      body: 'تم تسليم طلبك VD-123',
      icon: '/_next/static/media/icon-192.png',
      badge: '/_next/static/media/badge-96.png',
      lang: 'ar',
      dir: 'rtl',
      tag: 'order-0193',
      renotify: true,
      data: { url: '/orders/0193' },
    });
  });

  it('shows the generic text for a payload that does not parse (SW6)', async () => {
    for (const data of [undefined, 'not json', { title: 1 }]) {
      const worker = load();
      await worker.dispatch('push', {
        data:
          data === undefined
            ? null
            : {
                json: () => (typeof data === 'string' ? JSON.parse(data) : data),
              },
      });
      expect(worker.self.registration.showNotification).toHaveBeenCalledWith('VERTEX DIGITAL', {
        body: 'لديك إشعار جديد',
        icon: '/_next/static/media/icon-192.png',
        badge: '/_next/static/media/badge-96.png',
        lang: 'ar',
        dir: 'rtl',
        data: { url: '/notifications' },
      });
    }
  });

  it.each([
    ['/orders/0193', '/orders/0193'],
    ['/orders?checkout=0193', '/orders?checkout=0193'],
    ['https://evil.example/orders', '/notifications'],
    ['//evil.example/orders', '/notifications'],
    ['/\\evil.example/orders', '/notifications'],
    ['/\t/evil.example', '/notifications'],
    ['javascript:alert(1)', '/notifications'],
    [42, '/notifications'],
  ])('opens only a same-origin path from a tap: %s (SW7)', async (url, expected) => {
    const [, options] = await pushed({ title: 'VERTEX DIGITAL', body: 'x', url, tag: 't' });
    expect(options.data).toEqual({ url: expected });
  });

  it('focuses an open store window and navigates it, or opens one (SW7)', async () => {
    const worker = load();
    const close = vi.fn();
    const navigate = vi.fn();
    const tap = () =>
      worker.dispatch('notificationclick', {
        notification: { close, data: { url: '//evil.example' } },
      });
    await tap();
    expect(close).toHaveBeenCalled();
    expect(worker.self.clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}/notifications`);

    const store = { url: `${ORIGIN}/wallet`, navigate, focus: async () => store };
    worker.windows.push(
      { url: 'https://other.example/', navigate: vi.fn(), focus: vi.fn() },
      store,
    );
    await worker.dispatch('notificationclick', {
      notification: { close, data: { url: '/orders/0193' } },
    });
    expect(navigate).toHaveBeenCalledWith(`${ORIGIN}/orders/0193`);
    expect(worker.self.clients.openWindow).toHaveBeenCalledTimes(1);
  });
});
