import type { Dashboard } from '@vertex-digital/contracts';
import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import { expect, screenshot, test } from './test';

/*
 * The panel's shell (audit A10): the root not-found page, a page that fails to render inside the
 * shell and is reported, the page titles, the skip link and the phone drawer.
 */

test.beforeEach(({ admin }) => {
  admin.signedIn = true;
});

test('an unknown address says so, with a way home (A10-29)', async ({ page }) => {
  await page.goto('/no-such-page');
  await expect(page.getByRole('heading', { name: ar.common.notFoundTitle })).toBeVisible();
  await page.getByRole('link', { name: ar.common.backHome }).click();
  await expect(page).toHaveURL('/');
});

test('a page that fails keeps the shell, is reported, and retries (A10-26, A10-27)', async ({
  page,
  admin,
}, testInfo) => {
  // A dashboard missing its figures makes the page throw while it renders.
  admin.dashboard = { attention: [] } as unknown as Dashboard;
  // React logs the error it caught; the reported crash is what is under test.
  page.removeAllListeners('console');
  await page.goto('/');
  const alert = page.getByRole('alert').filter({ hasText: ar.common.errorTitle });
  await expect(alert).toBeVisible();
  await expect(page.getByRole('link', { name: ar.nav.customers })).toBeVisible();
  await expect.poll(() => admin.clientErrors.length).toBeGreaterThan(0);
  expect(admin.clientErrors[0]).toMatchObject({ path: '/' });
  await screenshot(page, testInfo, 'shell-page-error');
  admin.dashboard = null;
  await alert.getByRole('button', { name: ar.common.retry }).click();
  await expect(page.getByText(ar.dashboard.attention.none)).toBeVisible();
});

test('every page names itself in the tab title (A10-28)', async ({ page }) => {
  await page.goto('/customers');
  await expect(page).toHaveTitle(`${ar.nav.customers} · ${ar.app.name}`);
  await page.goto('/orders');
  await expect(page).toHaveTitle(`${ar.nav.allOrders} · ${ar.app.name}`);
});

test('the skip link moves the keyboard past the navigation (A10-29)', async ({ page }) => {
  await page.goto('/customers');
  await expect(page.getByRole('link', { name: ar.nav.customers })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: ar.nav.skip })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test('the drawer opens, navigates with 44 px links and closes (A10-23, A10-29)', async ({
    page,
  }, testInfo) => {
    await page.goto('/');
    const menu = page.getByRole('button', { name: ar.nav.open });
    expect((await menu.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await menu.click();
    const drawer = page.getByRole('dialog');
    const link = drawer.getByRole('link', { name: ar.nav.customers });
    await expect(link).toBeVisible();
    expect((await link.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await screenshot(page, testInfo, 'shell-drawer');
    await link.click();
    await expect(page).toHaveURL('/customers');
    await expect(drawer).toBeHidden();
  });
});
