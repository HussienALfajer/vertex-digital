import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import { busyDashboard } from './dashboard-mock';
import { expect, screenshot, test } from './test';

/*
 * The panel's home page (S11, F18): a quiet day with nothing needing the admin, a busy one with
 * the attention list's links, the deltas against yesterday and the suppliers table, and the error
 * card with its retry, against the mocked API.
 */

const d = ar.dashboard;

test.beforeEach(({ admin }) => {
  admin.signedIn = true;
});

test('a quiet day: nothing needs the admin, zero sales, the suppliers and the rate', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByText(d.attention.none)).toBeVisible();
  await expect(page.getByText(d.sales, { exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: /المبيعات في آخر 7 أيام/ })).toBeVisible();
  const suppliers = page.getByRole('table');
  await expect(suppliers.getByRole('link', { name: 'SHOP2TOPUP' })).toBeVisible();
  await expect(suppliers.getByRole('link', { name: 'يدوي' })).toBeVisible();
  await expect(page.getByText(ar.rates.current.value.replace('{{rate}}', '118'))).toBeVisible();
});

test('a busy day: the attention list links to each place, deltas against yesterday', async ({
  page,
  admin,
}) => {
  admin.dashboard = busyDashboard();
  await page.goto('/');
  const attention = page.getByRole('listitem').filter({
    hasText: d.attention.kinds.supplier_degraded.replace('{{name}}', 'WDGZone'),
  });
  await expect(attention).toBeVisible();
  await expect(
    page.getByText(d.attention.kinds.switches_active.replace('{{switch}}', 'WDGZone')),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'VO-HELD23' })).toBeVisible();
  // Sales rose 16.6% on yesterday at the same hour; refunds had nothing yesterday.
  await expect(page.getByText('+16.6%')).toBeVisible();
  await expect(page.getByText('—', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(d.suppliers.low)).toBeVisible();
  await attention.getByRole('link', { name: d.attention.open }).click();
  await expect(page).toHaveURL(/\/suppliers\/wdgzone$/);
});

test('a failed read shows the error card, and the retry reads again', async ({ page }) => {
  await page.route('**/api/admin/dashboard', (route) =>
    route.fulfill({ status: 503, json: { statusCode: 503, code: 'INTERNAL', message: 'down' } }),
  );
  await page.goto('/');
  const retry = page.getByRole('button', { name: ar.common.retry });
  await expect(retry).toBeVisible({ timeout: 15_000 });
  await page.unroute('**/api/admin/dashboard');
  await retry.click();
  await expect(page.getByText(d.attention.none)).toBeVisible();
});

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('dashboard screenshots', async ({ page, admin }, testInfo) => {
      await page.goto('/');
      await expect(page.getByText(d.attention.none)).toBeVisible();
      await screenshot(page, testInfo, `dashboard-quiet-${colorScheme}`, { fullPage: true });
      admin.dashboard = busyDashboard();
      await page.reload();
      await expect(page.getByText('+16.6%')).toBeVisible();
      await screenshot(page, testInfo, `dashboard-busy-${colorScheme}`, { fullPage: true });
    });
  });
}
