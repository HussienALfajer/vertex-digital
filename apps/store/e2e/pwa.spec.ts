import ar from '../src/messages/ar.json' with { type: 'json' };
import { expect, screenshot, test } from './test';

/*
 * The installable store (S15 PW, SW): the manifest and its icons, the head tags, `/sw.js` and
 * `/offline` with their headers, and the real service worker answering the offline page when a
 * navigation fails. The other specs block service workers (playwright.config.ts); this one runs
 * the worker the store ships.
 */

test.use({ serviceWorkers: 'allow' });

test('serves the manifest with its icons, linked from every page (PW1, PW2)', async ({
  page,
  request,
}) => {
  const response = await request.get('/manifest.webmanifest');
  expect(response.ok()).toBe(true);
  const manifest = await response.json();
  expect(manifest).toMatchObject({
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    lang: 'ar',
    dir: 'rtl',
    name: 'VERTEX DIGITAL',
    short_name: 'VERTEX DIGITAL',
    description: ar.app.description,
    background_color: '#031b17',
    theme_color: '#031b17',
    shortcuts: [
      { name: ar.pwa.shortcutOrders, url: '/orders' },
      { name: ar.pwa.shortcutWallet, url: '/wallet' },
    ],
  });
  expect(
    manifest.icons.map(
      (icon: { sizes: string; purpose: string }) => `${icon.sizes} ${icon.purpose}`,
    ),
  ).toEqual(['192x192 any', '512x512 any', '512x512 maskable']);
  for (const icon of manifest.icons) {
    const file = await request.get(icon.src);
    expect(file.headers()['content-type']).toBe('image/png');
  }

  await page.goto('/');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    'href',
    '/manifest.webmanifest',
  );
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#031b17');
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute(
    'content',
    'yes',
  );
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute(
    'content',
    'VERTEX DIGITAL',
  );
});

test('serves /sw.js and /offline uncached, the offline page never indexed (SW1, SW5)', async ({
  request,
}) => {
  const worker = await request.get('/sw.js');
  expect(worker.headers()).toMatchObject({
    'content-type': 'text/javascript; charset=utf-8',
    'cache-control': 'no-cache',
    'service-worker-allowed': '/',
  });
  const script = await worker.text();
  expect(script).toMatch(/const CACHE = "vd-offline-[^"]+";/);
  expect(script).not.toContain('development');

  const offline = await request.get('/offline');
  expect(offline.headers()).toMatchObject({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache',
    'x-robots-tag': 'noindex',
  });
  const html = await offline.text();
  expect(html).toContain(ar.pwa.offline.title);
  expect(html).toContain('<meta name="robots" content="noindex">');
  // Self-contained: no file to fetch, no script but the reload.
  expect(html).not.toMatch(/<script|<link|src=/);
  const sitemap = await request.get('/sitemap.xml');
  expect(await sitemap.text()).not.toContain('/offline');
});

test('answers the offline page when the network is gone, and reloads when back (SW3, SW5)', async ({
  page,
  context,
}, testInfo) => {
  await page.goto('/');
  // Registered after `load`, installed with /offline, then in control (clients.claim).
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  expect(
    await page.evaluate(async () => {
      const names = await caches.keys();
      const cache = await caches.open(names[0] ?? '');
      return { names, kept: (await cache.keys()).map((request) => new URL(request.url).pathname) };
    }),
  ).toMatchObject({ names: [expect.stringMatching(/^vd-offline-/)], kept: ['/offline'] });

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: ar.pwa.offline.title })).toBeVisible();
  await expect(page.getByText(ar.pwa.offline.body)).toBeVisible();
  await screenshot(page, testInfo, 'offline');

  await context.setOffline(false);
  await page.getByRole('button', { name: ar.pwa.offline.retry }).click();
  await expect(page.getByRole('heading', { name: ar.pwa.offline.title })).toHaveCount(0);
  await expect(page.locator('main')).toBeVisible();
});
