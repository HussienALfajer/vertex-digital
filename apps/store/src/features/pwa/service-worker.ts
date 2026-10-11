/*
 * `/sw.js` (S15 SW1, SW3, SW6, SW7): a constant script written here (ADR 0015), with the build id
 * in it so every deploy installs a new worker. It caches only `/offline`, answers it when a
 * navigation fails, shows pushes and opens their links. Nothing a customer owns and no price is
 * ever stored (SW3, SW4).
 */

/** The installed app's name and every push's title (PW1, PT3). */
export const APP_NAME = 'VERTEX DIGITAL';

/** The offline page the worker keeps (SW5). */
export const OFFLINE_PATH = '/offline';

const CACHE_PREFIX = 'vd-offline-';

export function serviceWorkerScript(options: {
  /** The build id: a new value installs a new worker and a new cache (SW1, SW3). */
  version: string;
  /** The 192 icon and the monochrome badge (SW6), as the build serves them. */
  icon: string;
  badge: string;
  /** SW6: shown when a payload does not parse. */
  fallbackBody: string;
}): string {
  const constants = {
    CACHE: `${CACHE_PREFIX}${options.version}`,
    CACHE_PREFIX,
    OFFLINE: OFFLINE_PATH,
    TITLE: APP_NAME,
    FALLBACK_BODY: options.fallbackBody,
    FALLBACK_URL: '/notifications',
    ICON: options.icon,
    BADGE: options.badge,
  };
  const declarations = Object.entries(constants)
    .map(([name, value]) => `const ${name} = ${JSON.stringify(value)};`)
    .join('\n');
  return `'use strict';
${declarations}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(new Request(OFFLINE, { cache: 'reload' })))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Navigations go to the network; only a failed one answers the kept offline page. Every other
// request is left to the browser untouched.
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.mode !== 'navigate' || request.method !== 'GET') return;
  event.respondWith(
    fetch(request).catch(() =>
      caches
        .open(CACHE)
        .then((cache) => cache.match(OFFLINE))
        .then((response) => response || Response.error()),
    ),
  );
});

// A link opened from a notification: a same-origin path, never another site.
function safePath(url) {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) return FALLBACK_URL;
  try {
    const target = new URL(url, self.location.origin);
    return target.origin === self.location.origin ? target.pathname + target.search : FALLBACK_URL;
  } catch {
    return FALLBACK_URL;
  }
}

self.addEventListener('push', (event) => {
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {}
  const valid =
    payload !== null &&
    typeof payload === 'object' &&
    typeof payload.title === 'string' &&
    typeof payload.body === 'string';
  const tag = valid && typeof payload.tag === 'string' ? payload.tag : undefined;
  const options = {
    body: valid ? payload.body : FALLBACK_BODY,
    icon: ICON,
    badge: BADGE,
    lang: 'ar',
    dir: 'rtl',
    data: { url: safePath(valid ? payload.url : FALLBACK_URL) },
  };
  if (tag) {
    options.tag = tag;
    options.renotify = true;
  }
  event.waitUntil(self.registration.showNotification(valid ? payload.title : TITLE, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(safePath(event.notification.data && event.notification.data.url), self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (!open) return self.clients.openWindow(target);
      return open
        .focus()
        .then((client) => client.navigate(target))
        .catch(() => self.clients.openWindow(target));
    }),
  );
});
`;
}
