import type { Page } from '@playwright/test';
import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import { type AdminApi, expect, PASSWORD, screenshot, TOTP_CODE, test } from './test';

/*
 * The store switches (S05, F26): the switches page with its confirmation, re-authentication and
 * history, and the banner on every page while a stop or a pause is on, against the mocked API.
 */

const field = (page: Page, label: string) =>
  page.getByLabel(label, { exact: true }).filter({ visible: true });

async function open(page: Page, admin: AdminApi, path: string) {
  admin.signedIn = true;
  await page.goto(path);
}

/** Re-authenticates in the dialog the API's refusal opened (S01 rule D5). */
async function reauthenticate(page: Page) {
  await expect(page.getByRole('heading', { name: ar.reauth.title })).toBeVisible();
  await field(page, ar.reauth.password).fill(PASSWORD);
  await page.getByRole('textbox').filter({ visible: true }).nth(1).pressSequentially(TOTP_CODE);
  await page.getByRole('button', { name: ar.reauth.submit }).click();
}

const toggle = (page: Page, name: string) => page.getByRole('switch', { name, exact: true });

const rows = (page: Page) => page.getByRole('table').getByRole('row');

test.describe('store switches', () => {
  test('stops deposits after a confirmation and a re-authentication, with the banner', async ({
    page,
    admin,
  }) => {
    admin.reauthenticationRequired = true;
    await open(page, admin, '/settings/switches');
    await expect(page.getByRole('heading', { name: ar.switches.title, level: 1 })).toBeVisible();
    await expect(page.getByText(ar.switches.history.empty)).toBeVisible();
    await expect(toggle(page, ar.switches.names.deposits_stopped)).not.toBeChecked();

    await toggle(page, ar.switches.names.deposits_stopped).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog.getByText(ar.switches.confirm.deposits_stopped.true.body)).toBeVisible();
    await dialog
      .getByRole('button', { name: ar.switches.confirm.deposits_stopped.true.action })
      .click();
    await reauthenticate(page);
    await expect(toggle(page, ar.switches.names.deposits_stopped)).toBeChecked();
    expect(admin.lastBody('POST /api/admin/switches')).toEqual({
      switch: 'deposits_stopped',
      value: true,
    });

    // Rule SW10: the banner names the stop, here and on every other page.
    await expect(page.getByText(ar.switches.banner.stoppedTitle)).toBeVisible();
    await expect(rows(page)).toHaveCount(2);
    await expect(rows(page).nth(1)).toContainText(ar.switches.names.deposits_stopped);
    await expect(rows(page).nth(1)).toContainText(ar.switches.channels.admin);
    await page.goto('/rates');
    await expect(page.getByText(ar.switches.banner.stoppedTitle)).toBeVisible();
    await page.getByRole('link', { name: ar.switches.banner.action }).click();
    await expect(page).toHaveURL('/settings/switches');

    // Reopening asks again; cancelling changes nothing.
    await toggle(page, ar.switches.names.deposits_stopped).click();
    await page.getByRole('button', { name: ar.common.cancel }).click();
    await expect(toggle(page, ar.switches.names.deposits_stopped)).toBeChecked();
    await toggle(page, ar.switches.names.deposits_stopped).click();
    await page
      .getByRole('button', { name: ar.switches.confirm.deposits_stopped.false.action })
      .click();
    await expect(toggle(page, ar.switches.names.deposits_stopped)).not.toBeChecked();
    await expect(page.getByText(ar.switches.banner.stoppedTitle)).toBeHidden();
    await expect(rows(page)).toHaveCount(3);
  });

  test('warns before opening registration, shows a paused method and filters the history', async ({
    page,
    admin,
  }) => {
    await open(page, admin, '/settings/switches');
    await expect(
      page.getByText(ar.switches.unconfigured).first(),
      'the deposit settings were never saved',
    ).toBeVisible();

    await toggle(page, ar.switches.names.registration_open).click();
    await expect(page.getByText(ar.switches.confirm.registrationWarning)).toBeVisible();
    await page
      .getByRole('button', { name: ar.switches.confirm.registration_open.true.action })
      .click();
    await expect(toggle(page, ar.switches.names.registration_open)).toBeChecked();
    // Open registration is no emergency: no banner.
    await expect(page.getByText(ar.switches.banner.pausedTitle)).toBeHidden();

    await toggle(page, ar.switches.names.usdt_trc20_paused).click();
    await page
      .getByRole('button', { name: ar.switches.confirm.usdt_trc20_paused.true.action })
      .click();
    await expect(page.getByText(ar.switches.banner.pausedTitle)).toBeVisible();
    await expect(rows(page)).toHaveCount(3);

    await page.getByRole('combobox', { name: ar.switches.history.filter }).click();
    await page.getByRole('option', { name: ar.switches.names.registration_open }).click();
    await expect(page).toHaveURL('/settings/switches?switch=registration_open');
    await expect(rows(page)).toHaveCount(2);
    expect(admin.lastBody('POST /api/admin/switches')).toEqual({
      switch: 'usdt_trc20_paused',
      value: true,
    });
  });
});

// RTL screenshots in both themes: the design review evidence (ADR 0011).
for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('S05 switch screenshots', async ({ page, admin }, testInfo) => {
      const at = new Date(Date.now() - 25 * 60_000).toISOString();
      admin.switchChanges = [
        {
          id: '0199a000-0000-7000-8000-000000000502',
          switch: 'deposits_stopped',
          value: true,
          channel: 'telegram',
          createdAt: at,
        },
        {
          id: '0199a000-0000-7000-8000-000000000501',
          switch: 'sham_cash_paused',
          value: true,
          channel: 'admin',
          createdAt: at,
        },
      ];
      await open(page, admin, '/settings/switches');
      await expect(rows(page)).toHaveCount(3);
      await screenshot(page, testInfo, `switches-${colorScheme}`, { fullPage: true });

      await toggle(page, ar.switches.names.registration_open).click();
      await expect(page.getByRole('alertdialog')).toBeVisible();
      await screenshot(page, testInfo, `switches-confirm-${colorScheme}`);
      await page.keyboard.press('Escape');

      await page.goto('/');
      await expect(page.getByText(ar.switches.banner.stoppedTitle)).toBeVisible();
      await screenshot(page, testInfo, `switches-banner-${colorScheme}`);
    });
  });
}
