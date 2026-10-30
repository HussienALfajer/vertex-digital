import type { Page } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import { CATALOG } from './catalog';
import { CONTENT_STORE_URL } from './servers';
import { expect, type MockApi, screenshot, test } from './test';

/*
 * S24: the home page's category cards and rows, a category's page, the phone's bottom bar and the
 * back links with their fixed destinations, against the catalog server and the mocked API.
 */

const ORDER = '0199f000-0000-7000-8000-000000000010';
const lightTheme = () => localStorage.setItem('vertex-theme', 'light');
const phone = (name: string) => name === 'phone';
const bar = (page: Page) => page.getByRole('navigation', { name: ar.nav.label });
/** The search dialog and the cart read the index. */
const index = (api: MockApi) =>
  api.on('GET /api/catalog/search-index', 200, { games: [], products: [] });

function overflow(page: Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test.describe('home and categories (NH1–NH3)', () => {
  test('a card shows its image, else a collage of its first covers (NH2)', async ({
    page,
    api: _api,
  }) => {
    await page.goto('/');
    const cards = page.getByRole('navigation', { name: ar.catalog.categories });
    await expect(cards.locator('a[href="/categories/gift-cards"] img')).toHaveCount(1);
    // ألعاب has no image of its own: its two games with covers (the third has none).
    await expect(cards.locator('a[href="/categories/games"] img')).toHaveCount(2);
  });

  test('the home page shows the cards and rows, each with its link to all', async ({
    page,
    api: _api,
  }) => {
    await page.goto('/');
    const categories = CATALOG.storefront.categories.filter((item) => item.games.length > 0);
    const cards = page.getByRole('navigation', { name: ar.catalog.categories });
    await expect(cards.getByRole('link')).toHaveCount(categories.length);
    for (const category of categories) {
      await expect(page.locator(`section#${category.slug}`)).toBeVisible();
      await expect(
        page.getByRole('link', {
          name: ar.catalog.viewAllOf.replace('{name}', category.nameAr),
        }),
      ).toHaveAttribute('href', `/categories/${category.slug}`);
    }
    expect(await overflow(page)).toBe(0);
  });

  test('a category page lists its games and goes back home; a game goes back to it', async ({
    page,
    api: _api,
  }) => {
    const category = CATALOG.storefront.categories[0];
    if (!category) throw new Error('No category in the fixtures');
    await page.goto(`/categories/${category.slug}`);
    await expect(page.getByRole('heading', { level: 1, name: category.nameAr })).toBeVisible();
    await expect(page.locator('main a[href^="/games/"]')).toHaveCount(category.games.length);
    await expect(page.getByRole('link', { name: ar.back.home, exact: true }).first()).toBeVisible();
    await expect(page).toHaveTitle(new RegExp(category.nameAr));

    const game = category.games[0];
    await page.goto(`/games/${game?.slug}`);
    await expect(page.getByRole('link', { name: category.nameAr })).toHaveAttribute(
      'href',
      `/categories/${category.slug}`,
    );
  });

  test('an unknown or empty category is not found', async ({ page, api: _api }) => {
    for (const slug of ['no-such-category', 'apps', 'Bad_Slug']) {
      await page.goto(`/categories/${slug}`);
      await expect(page.getByText(ar.notFound.title, { exact: true })).toBeVisible();
    }
  });

  test('the sitemap names the categories', async ({ page, api: _api }) => {
    const sitemap = await (await page.request.get('/sitemap.xml')).text();
    expect(sitemap).toContain('/categories/games</loc>');
    expect(sitemap).not.toContain('/categories/apps</loc>');
  });
});

test.describe('the bottom bar (NH4, NH5)', () => {
  test('phone only, with its five items, the active route and sign-in for signed-out visitors', async ({
    page,
    api,
  }, testInfo) => {
    index(api);
    await page.goto('/');
    if (!phone(testInfo.project.name)) {
      await expect(bar(page)).toBeHidden();
      return;
    }
    await expect(bar(page)).toBeVisible();
    await expect(bar(page).getByRole('link', { name: ar.nav.home })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(bar(page).getByRole('link', { name: ar.nav.orders })).toHaveAttribute(
      'href',
      `/sign-in?next=${encodeURIComponent('/orders')}`,
    );
    await expect(bar(page).getByRole('link', { name: ar.nav.wallet })).toHaveAttribute(
      'href',
      `/sign-in?next=${encodeURIComponent('/wallet')}`,
    );
    await bar(page).getByRole('button', { name: ar.search.open }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');

    await bar(page).getByRole('link', { name: ar.header.cart }).click();
    await expect(page).toHaveURL('/cart');
    await expect(bar(page).getByRole('link', { name: ar.header.cart })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // The header keeps to 360 px; nothing is hidden behind the bar.
    expect(await overflow(page)).toBe(0);
    const padding = await page.evaluate(() => getComputedStyle(document.body).paddingBottom);
    expect(Number.parseFloat(padding)).toBeGreaterThanOrEqual(56);
  });

  test('hidden on a print page, and the cart item without storage', async ({
    page,
    api,
  }, testInfo) => {
    test.skip(!phone(testInfo.project.name), 'phone only');
    api
      .on('GET /api/auth/get-session', 200, {
        user: { name: 'سارة', email: 'sara@example.com' },
        session: { token: 'this-device' },
      })
      .on(`GET /api/orders/${ORDER}`, 404, { code: 'NOT_FOUND' });
    await page.goto(`/orders/${ORDER}/print`);
    await expect(page.locator('nav.fixed')).toHaveCount(0);

    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        get() {
          throw new Error('blocked');
        },
      });
    });
    await page.goto('/');
    await expect(bar(page).getByRole('link', { name: ar.nav.home })).toBeVisible();
    await expect(bar(page).getByRole('link', { name: ar.header.cart })).toHaveCount(0);
  });

  test('a failed session read is not "signed out"', async ({ page, api }, testInfo) => {
    test.skip(!phone(testInfo.project.name), 'phone only');
    api.on('GET /api/auth/get-session', 500, { code: 'INTERNAL_ERROR' });
    await page.goto('/');
    await expect(bar(page).getByRole('link', { name: ar.nav.orders })).toHaveAttribute(
      'href',
      '/orders',
    );
  });

  test('the cart item is in the server HTML, so the bar does not shift', async ({
    page,
    api: _api,
  }, testInfo) => {
    test.skip(!phone(testInfo.project.name), 'the HTML is one');
    const html = await (await page.request.get('/')).text();
    expect(html).toContain('href="/cart"');
  });

  test('sheets sit above the bar', async ({ page, api }, testInfo) => {
    test.skip(!phone(testInfo.project.name), 'phone only');
    index(api);
    const zOf = (locator: ReturnType<Page['locator']>) =>
      locator.evaluate((element) => Number(getComputedStyle(element).zIndex));
    await page.goto('/');
    const nav = page.locator('nav.fixed');
    const barIndex = await zOf(nav);
    await bar(page).getByRole('button', { name: ar.search.open }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    expect(await zOf(dialog)).toBeGreaterThan(barIndex);
  });
});

/** The back link's destination in a page's HTML, or null without one. */
async function backLinkOf(page: Page, url: string): Promise<string | null> {
  const html = await (await page.request.get(url)).text();
  const tag = /<a\b[^>]*data-slot="back-link"[^>]*>/.exec(html)?.[0];
  return tag ? (/href="([^"]*)"/.exec(tag)?.[1] ?? null) : null;
}

test.describe('back links (NH6)', () => {
  const routes: [string, string][] = [
    ['/wallet', '/'],
    ['/wallet/deposit', '/wallet'],
    ['/wallet/deposits', '/wallet'],
    [`/wallet/deposits/${ORDER}`, '/wallet/deposits'],
    ['/orders', '/'],
    [`/orders/${ORDER}`, '/orders'],
    ['/support', '/'],
    ['/support/new', '/support'],
    ['/account', '/'],
    ['/account/players', '/account'],
    ['/account/alerts', '/account'],
    ['/account/email', '/account'],
    ['/account/merchant', '/account'],
    ['/cart', '/'],
    ['/notifications', '/'],
    ['/sign-in', '/'],
    ['/sign-up', '/'],
    ['/forgot-password', '/sign-in'],
    ['/verify-email', '/sign-in'],
    ['/merchant', '/account'],
    ['/games/pubg-mobile', '/categories/games'],
    ['/categories/games', '/'],
    [`${CONTENT_STORE_URL}/terms`, '/'],
    [`${CONTENT_STORE_URL}/faq`, '/'],
  ];
  for (const [path, href] of routes) {
    test(`${path} goes to ${href}, a fixed path`, async ({ page, api: _api }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop', 'the HTML is one');
      expect(await backLinkOf(page, path)).toBe(href);
    });
  }

  for (const path of ['/', `/orders/${ORDER}/print`, '/g/G1ftT0kenAAAAAAAAAAAAA', '/v/nope']) {
    test(`${path} has none`, async ({ page, api: _api }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop', 'the HTML is one');
      expect(await backLinkOf(page, path)).toBeNull();
    });
  }
});

for (const theme of ['dark', 'light'] as const) {
  test(`S24 screenshots, ${theme} theme`, async ({ page, api }, testInfo) => {
    index(api);
    if (theme === 'light') await page.addInitScript(lightTheme);
    await page.goto('/');
    await expect(page.getByRole('navigation', { name: ar.catalog.categories })).toBeVisible();
    await screenshot(page, testInfo, `home-categories-${theme}`);
    await page.goto(`/categories/${CATALOG.storefront.categories[0]?.slug}`);
    await expect(page.locator('main a[href^="/games/"]').first()).toBeVisible();
    await screenshot(page, testInfo, `category-page-${theme}`);
    await page.goto('/cart');
    await screenshot(page, testInfo, `back-link-cart-${theme}`);
  });
}
