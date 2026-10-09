import { cheapestPackCombination, formatSyp, formatUsd } from '@vertex-digital/contracts';
import ar from '../src/messages/ar.json' with { type: 'json' };
import { CATALOG, PUBG, pack, searchIndex } from './catalog';
import { E2E_REVALIDATE_SECRET, EMPTY_STORE_URL } from './servers';
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
  test('shows the service line, the category chips and the game cards', async ({
    page,
    api: _api,
  }) => {
    await page.goto('/');
    await expect(page.getByText(c.service.slow)).toBeVisible();
    const categories = page.getByRole('navigation', { name: c.categories });
    // A category without games is not shown.
    await expect(categories.getByRole('link')).toHaveText(['ألعاب', 'بطاقات الهدايا']);
    const pubg = page.getByRole('link', { name: /ببجي موبايل/ });
    await expect(pubg).toContainText('PUBG Mobile');
    await expect(pubg).toContainText(c.status.normal);
    await expect(page.getByRole('link', { name: /فري فاير/ })).toContainText(c.status.slow);
    await expect(page.getByRole('link', { name: /موبايل ليجندز/ })).toContainText(
      c.status.unavailable,
    );
    await categories.getByRole('link', { name: 'بطاقات الهدايا' }).click();
    await expect(page).toHaveURL(/#gift-cards$/);
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
    await expect(small).toContainText(fill(c.delivery.median, { duration: '40 ثانية' }));
    const unavailable = page.getByRole('button', { name: /^1800 UC/ });
    await expect(unavailable).toBeDisabled();
    await expect(unavailable).toContainText(c.status.unavailable);
    await expect(unavailable).not.toContainText('$');
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

test.describe('search (rules SR1–SR6)', () => {
  test('Ctrl+K finds games by English, Arabic search terms and typos, and packs by amount', async ({
    page,
    api,
  }) => {
    api.on('GET /api/catalog/search-index', 200, searchIndex());
    await page.goto('/');
    await page.keyboard.press('Control+k');
    const dialog = page.getByRole('dialog', { name: ar.search.title });
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

  test('"/" opens it, an empty query shows the recent searches, and no results say so', async ({
    page,
    api,
  }) => {
    api.on('GET /api/catalog/search-index', 200, searchIndex());
    await page.goto('/');
    await page.keyboard.press('/');
    const dialog = page.getByRole('dialog', { name: ar.search.title });
    await expect(dialog.getByText(ar.search.hint)).toBeVisible();
    await dialog.getByRole('combobox').fill('itunes');
    await dialog.getByRole('option').first().click();
    await expect(page).toHaveURL('/games/itunes');
    await page.getByRole('button', { name: ar.search.open }).first().click();
    await expect(dialog.getByText(ar.search.recent)).toBeVisible();
    await expect(dialog.getByRole('option')).toHaveText(['itunes']);
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
    await expect(page.getByText(c.service.slow)).toBeVisible();
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
