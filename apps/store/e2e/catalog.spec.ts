import type { Locator, Page } from '@playwright/test';
import { cheapestPackCombination, formatSyp, formatUsd } from '@vertex-digital/contracts';
import ar from '../src/messages/ar.json' with { type: 'json' };
import { CATALOG, PUBG, pack, searchIndex } from './catalog';
import { CATALOG_PORT, E2E_REVALIDATE_SECRET, EMPTY_STORE_URL } from './servers';
import { expect, screenshot, test } from './test';

/*
 * The storefront (S09 F12, F15): the home page with its service line, categories and game cards
 * (and with no games yet), a game page with its packs, an unavailable pack and the calculator,
 * not found for an unknown game, the sitemap and robots, the revalidation route, and the search
 * dialog. The catalog comes from e2e/catalog-server.mjs; the browser's calls are mocked.
 */

const c = ar.catalog;
const fill = (text: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce(
    (result, [key, value]) => result.replace(`{${key}}`, `${value}`),
    text,
  );
const syp = (units: number) => fill(c.price.syp, { amount: formatSyp(units) });
const lightTheme = () => localStorage.setItem('vertex-theme', 'light');

test.describe('home (rules SF1, SS2)', () => {
  test('shows the category cards and the game cards, and no service line', async ({
    page,
    api: _api,
  }) => {
    await page.goto('/');
    // Owner, 2026-10-19: a slow supplier is the panel's business, never the customer's.
    await expect(page.getByText('أبطأ من المعتاد')).toHaveCount(0);
    await expect(page.getByText('تعمل بشكل طبيعي')).toHaveCount(0);
    const categories = page.getByRole('navigation', { name: c.categories });
    // A category without games is not shown.
    await expect(categories.getByRole('link')).toHaveCount(2);
    await expect(categories.getByRole('link', { name: /^ألعاب/ })).toBeVisible();
    const pubg = page.getByRole('link', { name: /ببجي موبايل/ });
    await expect(pubg).toContainText('PUBG Mobile');
    // Only a game the customer cannot buy carries a chip (rule SS1).
    await expect(page.getByRole('link', { name: /فري فاير/ })).not.toContainText(
      c.status.unavailable,
    );
    await expect(page.getByRole('link', { name: /موبايل ليجندز/ })).toContainText(
      c.status.unavailable,
    );
    await expect(categories.getByRole('link', { name: /بطاقات الهدايا/ })).toHaveAttribute(
      'href',
      '/categories/gift-cards',
    );
    await pubg.click();
    await expect(page).toHaveURL('/games/pubg-mobile');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      fill(ar.game.title, { name: 'ببجي موبايل' }),
    );
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
  });

  test('says the store is being prepared while it has no games', async ({ page, api: _api }) => {
    await page.goto(`${EMPTY_STORE_URL}/`);
    await expect(page.getByText(c.empty)).toBeVisible();
  });
});

test('a refused cover is tried once more, then the brand mark takes its place at its size', async ({
  page,
  api: _api,
}) => {
  const answers = new Map<string, number>();
  await page.route('**/api/catalog/images/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    answers.set(path, (answers.get(path) ?? 0) + 1);
    return route.fulfill({ status: 429, body: '' });
  });
  await page.goto('/');
  const first = page.locator('main a[href^="/games/"]').first();
  await expect(first.locator('svg').first()).toBeVisible({ timeout: 10_000 });
  await expect(first.locator('img')).toHaveCount(0);
  expect(await first.locator('svg').first().boundingBox()).not.toBeNull();
  expect(Math.max(...answers.values())).toBeGreaterThanOrEqual(2);
});

test('the header offers the sign-up in the cached HTML, with no read of its own', async ({
  page,
  api,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'hidden at phone width');
  await page.goto('/');
  await expect(page.getByRole('link', { name: ar.header.signUp })).toBeVisible();
  expect(api.requests.filter((r) => r.key === 'GET /api/auth/registration')).toHaveLength(0);
});

test.describe('game page (rules SF1–SF3, SF6, CL1–CL3)', () => {
  test('shows each pack with its prices, savings and delivery time; an unavailable one greyed', async ({
    page,
    api: _api,
  }) => {
    await page.goto('/games/pubg-mobile');
    await expect(page).toHaveTitle(fill(ar.game.metaTitle, { name: 'ببجي موبايل' }));
    await expect(page.getByText('يعمل على الحسابات العالمية فقط.')).toBeVisible();
    const small = page.getByRole('button', { name: /^660 UC/ });
    const p660 = pack(PUBG, '660 UC');
    await expect(small).toContainText(formatUsd(p660.priceUsdUnits as number));
    await expect(small).toContainText(syp(p660.priceSypUnits as number));
    await expect(small).toContainText(fill(c.price.savings, { percent: '⁦12%⁩' }));
    // One percent sign: the badge passes it inside the isolate (F10-2).
    await expect(small).not.toContainText('%⁩%');
    await expect(small).toContainText(fill(c.delivery.median, { duration: '40 ثانية' }));
    // The unavailable packs wait folded after the others (2026-10-19).
    const unavailable = page.getByRole('button', { name: /^1800 UC/ });
    await expect(unavailable).toBeHidden();
    const folded = page.locator('summary', {
      hasText: ar.game.unavailable.split(' (')[0] as string,
    });
    await folded.click();
    await expect(unavailable).toBeDisabled();
    await expect(unavailable).toContainText(c.status.unavailable);
    await expect(unavailable).not.toContainText('$');
    // A link to an unavailable pack (an old search result) opens the folded list on it.
    await page.goto(`/games/pubg-mobile?pack=${pack(PUBG, '1800 UC').id}`);
    await expect(unavailable).toBeVisible();
    await expect(unavailable).toBeDisabled();
    // The ID guide folds open.
    await page.getByRole('button', { name: ar.purchase.whereIsId }).first().click();
    await expect(
      page.getByRole('img', { name: fill(ar.purchase.idGuideAlt, { game: 'ببجي موبايل' }) }),
    ).toBeVisible();
  });

  test('finds the cheapest packs for 1000 UC and opens the buy box on one (step 2)', async ({
    page,
    api: _api,
  }) => {
    await page.goto('/games/pubg-mobile');
    await page.getByRole('button', { name: ar.calculator.title }).click();
    await page.getByLabel(ar.calculator.target).fill('1000');
    const packs = PUBG.products.filter((product) => product.available);
    const best = cheapestPackCombination(
      packs.map((product) => ({
        id: product.id,
        gameAmount: product.gameAmount as number,
        priceUsdUnits: product.priceUsdUnits as number,
      })),
      1000,
    );
    if (!best) throw new Error('No combination');
    for (const line of best.lines) {
      const name = packs.find((product) => product.id === line.packId)?.nameAr as string;
      await expect(page.getByText(`${name} × ${line.count}`)).toBeVisible();
    }
    await expect(page.getByText(formatUsd(best.totalUsdUnits), { exact: true })).toBeVisible();
    await expect(
      page.getByText(
        fill(ar.calculator.overshoot, {
          amount: best.totalAmount.toLocaleString('en-US'),
          extra: best.overshoot.toLocaleString('en-US'),
        }),
      ),
    ).toBeVisible();
    await page.getByRole('button', { name: ar.calculator.buy }).first().click();
    await expect(page).toHaveURL(/\?pack=/);
    await expect(page.getByRole('heading', { level: 2, name: /UC$/ }).last()).toBeVisible();
  });

  test('a failed read shows the error view; its retry reads the game again (audit A03-7)', async ({
    browser,
    request,
  }) => {
    // A page of its own: the browser logs the failed server render, which is the case under test.
    const page = await browser.newPage({ baseURL: test.info().project.use.baseURL });
    const slug = `flaky-${Math.random().toString(36).slice(2, 8)}`;
    const flaky = (fail: 0 | 1) =>
      request.get(`http://127.0.0.1:${CATALOG_PORT}/_flaky?slug=${slug}&fail=${fail}`);
    await flaky(1);
    await page.goto(`/games/${slug}`);
    await expect(page.getByText(ar.error.title)).toBeVisible();
    await flaky(0);
    await page.getByRole('button', { name: ar.error.retry }).click();
    await expect(page.getByRole('button', { name: /^60 UC/ })).toBeVisible();
    await page.close();
  });

  test('an unknown or paused game is not found, with a way home', async ({ page, api: _api }) => {
    await page.goto('/games/no-such-game');
    await expect(page.getByText(ar.notFound.title, { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: ar.notFound.back })).toBeVisible();
  });
});

test.describe('crawlers and the cache (rules SF4, SF6)', () => {
  test('the sitemap lists the home page and the shown games; robots keeps customer pages out', async ({
    request,
  }) => {
    const sitemap = await (await request.get('/sitemap.xml')).text();
    expect(sitemap).toContain('<loc>http://127.0.0.1:4001/</loc>');
    for (const category of CATALOG.storefront.categories)
      for (const game of category.games)
        expect(sitemap).toContain(`<loc>http://127.0.0.1:4001/games/${game.slug}</loc>`);
    const robots = await (await request.get('/robots.txt')).text();
    for (const path of ['/wallet', '/orders', '/account', '/notifications', '/_internal'])
      expect(robots).toContain(`Disallow: ${path}`);
  });

  test('the revalidation route needs the secret and refuses a proxied request', async ({
    request,
  }) => {
    const route = '/_internal/revalidate';
    expect((await request.post(route)).status()).toBe(401);
    expect(
      (await request.post(route, { headers: { authorization: 'Bearer wrong' } })).status(),
    ).toBe(401);
    expect(
      (
        await request.post(route, {
          headers: {
            authorization: `Bearer ${E2E_REVALIDATE_SECRET}`,
            'x-forwarded-for': '203.0.113.9',
          },
        })
      ).status(),
    ).toBe(401);
    expect(
      (
        await request.post(route, { headers: { authorization: `Bearer ${E2E_REVALIDATE_SECRET}` } })
      ).status(),
    ).toBe(204);
  });
});

/**
 * The shortcut listener is attached once the header hydrates, after `goto` returns: press again
 * until the dialog opens (a press before hydration is lost; once open, no further press).
 */
async function pressUntilOpen(page: Page, dialog: Locator, key: string) {
  await expect(async () => {
    if (!(await dialog.isVisible())) await page.keyboard.press(key);
    await expect(dialog).toBeVisible({ timeout: 1000 });
  }).toPass();
}

test.describe('search (rules SR1–SR6)', () => {
  test('Ctrl+K finds games by English, Arabic search terms and typos, and packs by amount', async ({
    page,
    api,
  }) => {
    api.on('GET /api/catalog/search-index', 200, searchIndex());
    await page.goto('/');
    const dialog = page.getByRole('dialog', { name: ar.search.title });
    await pressUntilOpen(page, dialog, 'Control+k');
    const input = dialog.getByRole('combobox');
    await expect(input).toBeFocused();
    const results = dialog.getByRole('option');
    for (const query of ['pubg', 'ببجي', 'بوبجي']) {
      await input.fill(query);
      await expect(results.first()).toContainText('ببجي موبايل');
    }
    await input.fill('فري فاير');
    await expect(results.first()).toContainText('فري فاير');
    await input.fill('60');
    await expect(results.first()).toContainText('60 UC');
    await input.press('Enter');
    await expect(page).toHaveURL(`/games/pubg-mobile?pack=${pack(PUBG, '60 UC').id}`);
    await expect(dialog).toBeHidden();
    expect(api.requests.filter((r) => r.key === 'GET /api/catalog/search-index')).toHaveLength(1);
  });

  test('a second open within 30 seconds reuses the index; later it reads the new prices (F3-5)', async ({
    page,
    api,
  }) => {
    // Only Date.now moves: timers keep running, so the dialog's animations end.
    const start = Date.parse('2026-10-15T12:00:00Z');
    await page.clock.setFixedTime(start);
    const before = searchIndex();
    api.on('GET /api/catalog/search-index', 200, before);
    await page.goto('/');
    const dialog = page.getByRole('dialog', { name: ar.search.title });
    const reads = () => api.requests.filter((r) => r.key === 'GET /api/catalog/search-index');
    const product = before.products.find((item) => item.id === pack(PUBG, '60 UC').id);
    const oldSyp = product?.priceSypUnits ?? 0;
    const newSyp = oldSyp + 500;
    const sypText = (units: number) => `${formatSyp(units)} ل.س`;

    await pressUntilOpen(page, dialog, 'Control+k');
    await dialog.getByRole('combobox').fill('60 UC');
    await expect(dialog.getByRole('option').first()).toContainText(sypText(oldSyp));
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await pressUntilOpen(page, dialog, 'Control+k');
    expect(reads()).toHaveLength(1);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // The rate changed: the index now answers the new SYP.
    api.on('GET /api/catalog/search-index', 200, {
      ...before,
      products: before.products.map((item) =>
        item.id === product?.id ? { ...item, priceSypUnits: newSyp } : item,
      ),
    });
    await page.clock.setFixedTime(start + 31_000);
    await pressUntilOpen(page, dialog, 'Control+k');
    await dialog.getByRole('combobox').fill('60 UC');
    await expect(dialog.getByRole('option').first()).toContainText(sypText(newSyp));
    expect(reads()).toHaveLength(2);
  });

  test('a failed index read offers a retry (audit A03-8)', async ({ page, api }) => {
    api.on('GET /api/catalog/search-index', 500, { code: 'INTERNAL_ERROR' });
    await page.goto('/');
    const dialog = page.getByRole('dialog', { name: ar.search.title });
    await pressUntilOpen(page, dialog, 'Control+k');
    await expect(dialog.getByRole('alert')).toBeVisible();
    api.on('GET /api/catalog/search-index', 200, searchIndex());
    await dialog.getByRole('button', { name: ar.error.retry }).click();
    await dialog.getByRole('combobox').fill('pubg');
    await expect(dialog.getByRole('option').first()).toContainText('ببجي موبايل');
  });

  test('"/" opens it, an empty query shows the recent searches, and no results say so', async ({
    page,
    api,
  }) => {
    api.on('GET /api/catalog/search-index', 200, searchIndex());
    await page.goto('/');
    const dialog = page.getByRole('dialog', { name: ar.search.title });
    await pressUntilOpen(page, dialog, '/');
    await expect(dialog.getByText(ar.search.hint)).toBeVisible();
    await dialog.getByRole('combobox').fill('itunes');
    await dialog.getByRole('option').first().click();
    await expect(page).toHaveURL('/games/itunes');
    await page.getByRole('button', { name: ar.search.open }).first().click();
    await expect(dialog.getByText(ar.search.recent)).toBeVisible();
    await expect(dialog.getByRole('option')).toHaveText(['itunes']);
    // A recent search fills the field and keeps the focus there (audit A03-29).
    await dialog.getByRole('option').first().click();
    await expect(dialog.getByRole('combobox')).toHaveValue('itunes');
    await expect(dialog.getByRole('combobox')).toBeFocused();
    await dialog.getByRole('combobox').fill('zzzz');
    await expect(dialog.getByText(fill(ar.search.noResults, { query: 'zzzz' }))).toBeVisible();
    await dialog.getByRole('combobox').fill('');
    await dialog.getByRole('button', { name: ar.search.clearRecent }).click();
    await expect(dialog.getByText(ar.search.hint)).toBeVisible();
  });
});

// RTL screenshots in both themes, at phone width and desktop (the projects).
for (const theme of ['dark', 'light'] as const) {
  test(`catalog screenshots, ${theme} theme`, async ({ page, api }, testInfo) => {
    if (theme === 'light') await page.addInitScript(lightTheme);
    api.on('GET /api/catalog/search-index', 200, searchIndex());
    await page.goto('/');
    await expect(page.getByRole('navigation', { name: c.categories })).toBeVisible();
    await screenshot(page, testInfo, `home-catalog-${theme}`);
    await page.goto(`${EMPTY_STORE_URL}/`);
    await expect(page.getByText(c.empty)).toBeVisible();
    await screenshot(page, testInfo, `home-empty-${theme}`);

    await page.goto('/games/pubg-mobile');
    await expect(page.getByRole('button', { name: /^60 UC/ })).toBeVisible();
    await page.getByRole('button', { name: ar.calculator.title }).click();
    await page.getByLabel(ar.calculator.target).fill('1000');
    await expect(page.getByText(ar.calculator.separate)).toBeVisible();
    await screenshot(page, testInfo, `game-page-${theme}`);

    await page.getByRole('button', { name: ar.search.open }).first().click();
    const dialog = page.getByRole('dialog', { name: ar.search.title });
    await dialog.getByRole('combobox').fill('ببجي');
    await expect(dialog.getByRole('option').first()).toContainText('ببجي موبايل');
    await screenshot(page, testInfo, `search-results-${theme}`);
    await dialog.getByRole('combobox').fill('zzzz');
    await expect(dialog.getByText(fill(ar.search.noResults, { query: 'zzzz' }))).toBeVisible();
    await screenshot(page, testInfo, `search-empty-${theme}`);
  });
}
