import type { Page } from '@playwright/test';
import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import { type AdminApi, chooseOption, expect, screenshot, test } from './test';

/*
 * Audit A05-44: a route's priority and restore, the runs tab, the statement's refusals, importing
 * and linking from a category's page, read failures with their retry, and the supplier and pricing
 * screens at 375 px, against the mocked API.
 */

const s = ar.suppliers;
const c = s.catalog;

const fill = (text: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{{${key}}}`, String(value)),
    text,
  );

function synced(admin: AdminApi) {
  admin.signedIn = true;
  admin.suppliers.connectFake();
}

/** ببجي موبايل with "60 UC" routed to the fake supplier. */
function mapped(admin: AdminApi) {
  const game = admin.catalog.addGame({
    categorySlug: 'games',
    slug: 'pubg-mobile',
    nameAr: 'ببجي موبايل',
    nameEn: 'PUBG Mobile',
    status: 'active',
    cover: true,
  });
  admin.catalog.addField(game.id, { key: 'player_id', labelAr: 'معرّف اللاعب' });
  const product = admin.catalog.addProduct(game.id, { nameAr: '60 UC', gameAmount: 60 });
  synced(admin);
  admin.suppliers.map(product.id, 'fake', 'fake-uc-60', { playerId: 'player_id' });
  return { game, product };
}

/** A server fault on the first read and TanStack's two retries of it. */
const failThrice = (page: Page, url: string | RegExp) =>
  page.route(url, (route) => route.fulfill({ status: 500, json: { code: 'INTERNAL_ERROR' } }), {
    times: 3,
  });

test('a route takes a new priority, is archived, then restored', async ({ page, admin }) => {
  const { game } = mapped(admin);
  await page.goto(`/catalog/games/${game.id}?tab=products`);
  await page
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: '60 UC', exact: true }) })
    .getByRole('button', { name: ar.catalog.products.routes })
    .click();
  const route = page.getByRole('dialog').getByRole('listitem').first();
  await chooseOption(page, route.getByRole('combobox', { name: s.routes.priority }), '2');
  await expect.poll(() => admin.suppliers.routes[0]?.priority).toBe(2);
  await route.getByRole('button', { name: ar.catalog.actions.archive }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: s.routes.stop.archive }).click();
  await route.getByRole('button', { name: ar.catalog.actions.restore }).click();
  await expect(route.getByRole('switch', { name: s.routes.enabled })).toBeVisible();
  await expect.poll(() => admin.suppliers.routes[0]?.archivedAt).toBeNull();
});

test('the runs tab shows a failed run with its code and message', async ({ page, admin }) => {
  synced(admin);
  const run = admin.suppliers.runSync('fake');
  admin.suppliers.supplier('fake').runs.unshift({
    ...run,
    id: '01a10000-0000-7000-8000-00000000f001',
    status: 'failed',
    errorCode: 'INTERRUPTED',
    errorMessage: 'The worker restarted during this run',
  });
  await page.goto('/suppliers/fake?tab=runs');
  await expect(page.getByText(s.runs.statuses.failed, { exact: true }).first()).toBeVisible();
  // The restart is ours: it never reads as the supplier's own error.
  await expect(page.getByText(s.runs.errors.INTERRUPTED).first()).toBeVisible();
  await expect(page.getByText(s.runs.errors.supplierCode)).toHaveCount(0);
  await expect(page.getByText('The worker restarted during this run')).toBeVisible();
  await expect(page.getByText(s.runs.statuses.succeeded, { exact: true }).first()).toBeVisible();
});

test('a limited statement waits and reads again; still limited, it says so (S18 ST3)', async ({
  page,
  admin,
}) => {
  synced(admin);
  // The first read and its two retries, five seconds apart.
  await page.route(
    '**/api/admin/suppliers/fake/statement/orders**',
    (route) => route.fulfill({ status: 429, json: { code: 'RATE_LIMITED' } }),
    { times: 3 },
  );
  await page.goto('/suppliers/fake?tab=statement');
  await expect(page.getByText(ar.errors.api.RATE_LIMITED)).toBeVisible({ timeout: 12_000 });
  await page.getByRole('button', { name: s.statement.refresh }).click();
  await expect(page.getByText(s.statement.noOrders)).toBeVisible();
  await expect(page.getByText(ar.errors.api.RATE_LIMITED)).toBeHidden();
});

test('a category page opens the import and the link sheets', async ({ page, admin }) => {
  synced(admin);
  admin.catalog.addGame({
    categorySlug: 'games',
    slug: 'free-fire',
    nameAr: 'فري فاير',
    nameEn: 'Free Fire',
    status: 'active',
    cover: true,
  });
  await page.goto('/suppliers/fake/categories/fake-ff');
  await page.getByRole('button', { name: c.import, exact: true }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByText(fill(s.importCategory.title, { name: 'Free Fire' }))).toBeVisible();
  await sheet.getByRole('button', { name: ar.common.close }).click();
  await expect(sheet).toBeHidden();
  await page.getByRole('button', { name: c.link, exact: true }).click();
  await chooseOption(
    page,
    sheet.getByRole('combobox', { name: s.linkCategory.game, exact: true }),
    'فري فاير',
  );
  await expect(sheet.getByText('Fake Free Fire 520').first()).toBeVisible();
});

test.describe('failed reads offer a retry', () => {
  test('the supplier page', async ({ page, admin }) => {
    synced(admin);
    await failThrice(page, '**/api/admin/suppliers/fake');
    await page.goto('/suppliers/fake');
    await page.getByRole('button', { name: ar.common.retry }).click();
    await expect(page.getByRole('tab', { name: s.tabs.catalog })).toBeVisible();
  });

  test('the catalog tree', async ({ page, admin }) => {
    synced(admin);
    await failThrice(page, /\/api\/admin\/suppliers\/fake\/categories(\?|$)/);
    await page.goto('/suppliers/fake?tab=catalog');
    await page.getByRole('button', { name: ar.common.retry }).click();
    await expect(page.getByRole('link', { name: 'Free Fire', exact: true })).toBeVisible();
  });

  test('a category page', async ({ page, admin }) => {
    synced(admin);
    await failThrice(page, /\/api\/admin\/suppliers\/fake\/categories\/fake-ff(\?|$)/);
    await page.goto('/suppliers/fake/categories/fake-ff');
    await page.getByRole('button', { name: ar.common.retry }).click();
    await expect(page.getByRole('button', { name: c.import, exact: true })).toBeVisible();
  });
});

test('the supplier and pricing screens fit 375 px, light and dark', async ({
  page,
  admin,
}, testInfo) => {
  test.setTimeout(90_000);
  mapped(admin);
  await page.setViewportSize({ width: 375, height: 812 });
  const screens = {
    suppliers: '/suppliers',
    'supplier-connection': '/suppliers/fake',
    'supplier-catalog': '/suppliers/fake?tab=catalog',
    'supplier-runs': '/suppliers/fake?tab=runs',
    'supplier-policy': '/suppliers/policy',
    'pricing-lists': '/pricing/lists',
    'pricing-matrix': '/pricing/matrix',
    'pricing-reviews': '/pricing/reviews',
  };
  for (const [name, path] of Object.entries(screens)) {
    await page.goto(path);
    await expect(page.getByRole('main').getByRole('heading').first()).toBeVisible();
    await expect(page.locator('[data-slot=skeleton]')).toHaveCount(0);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${path} scrolls sideways`).toBeLessThanOrEqual(0);
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await screenshot(page, testInfo, `${name}-375-${colorScheme}`);
    }
  }
});
