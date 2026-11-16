import type { Page } from '@playwright/test';
import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import { rateId } from './rates-mock';
import { type AdminApi, chooseOption, expect, PASSWORD, screenshot, TOTP_CODE, test } from './test';

/*
 * S27 (F46) in the panel against the mocked API: `/rates` with its sources and a pending
 * suggestion, approving it with FX2's typed confirmation and re-authentication, rejecting it, the
 * source form with its test read, and the automatic updates' settings. RTL screenshots in both
 * themes.
 */

const field = (page: Page, label: string) =>
  page.getByLabel(label, { exact: true }).filter({ visible: true });

const fill = (text: string, values: Record<string, string>) =>
  Object.entries(values).reduce((out, [key, value]) => out.replace(`{{${key}}}`, value), text);

async function open(page: Page, admin: AdminApi, path: string) {
  admin.signedIn = true;
  await page.goto(path);
}

async function reauthenticate(page: Page) {
  await expect(page.getByRole('heading', { name: ar.reauth.title })).toBeVisible();
  await field(page, ar.reauth.password).fill(PASSWORD);
  await page.getByRole('textbox').filter({ visible: true }).nth(1).pressSequentially(TOTP_CODE);
  await page.getByRole('button', { name: ar.reauth.submit }).click();
}

test.describe('automatic exchange-rate updates (S27)', () => {
  test('shows the sources and approves a suggestion above 5% with its typed confirmation', async ({
    page,
    admin,
  }) => {
    admin.rateAuto.suggest('125');
    admin.reauthenticationRequired = true;
    await open(page, admin, '/rates');
    await expect(page.getByRole('heading', { name: ar.rates.suggestion.title })).toBeVisible();
    await expect(page.getByText(ar.rates.reasons.single_source)).toBeVisible();
    await expect(page.getByText(ar.rates.auto.off)).toBeVisible();
    await expect(page.getByText('قناة أسعار دمشق').first()).toBeVisible();
    await expect(page.getByText(ar.rates.health.broken)).toBeVisible();

    await page.getByRole('button', { name: ar.rates.suggestion.approve, exact: true }).click();
    const dialog = page.getByRole('dialog');
    const inDialog = (label: string) => dialog.getByLabel(label, { exact: true });
    // «اعتماد 124.5 ل.س»: the rate sits in direction marks, so the button is found by its type.
    const submit = dialog.locator('button[type="submit"]');
    await expect(inDialog(ar.rates.form.rate)).toHaveValue('125');
    await inDialog(ar.rates.form.rate).fill('124.5');
    await expect(submit).toContainText('124.5');
    await submit.click();
    await expect(dialog.getByText(ar.rates.form.errors.confirmation)).toBeVisible();
    await inDialog(ar.rates.form.confirmation).fill('124.5');
    await submit.click();
    await reauthenticate(page);
    await expect(page.getByText(fill(ar.rates.current.value, { rate: '124.5' }))).toBeVisible();
    expect(admin.lastBody(`POST /api/admin/rate-suggestions/${rateId(50)}/approve`)).toEqual({
      sypPerUsd: '124.5',
      rateConfirmation: '124.5',
    });
    await expect(page.getByRole('heading', { name: ar.rates.suggestion.title })).toBeHidden();
    await expect(page.getByRole('row').nth(1)).toContainText(ar.rates.origins.suggestion);
  });

  test('rejects a suggestion and keeps the rate', async ({ page, admin }) => {
    admin.rateAuto.suggest('120');
    await open(page, admin, '/rates');
    await page.getByRole('button', { name: ar.rates.suggestion.reject, exact: true }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByRole('button', { name: ar.rates.suggestion.reject }).click();
    await expect(page.getByRole('heading', { name: ar.rates.suggestion.title })).toBeHidden();
    await expect(page.getByText(fill(ar.rates.current.value, { rate: '118' }))).toBeVisible();
  });

  test('adds a channel after a test read, and disables a source', async ({ page, admin }) => {
    admin.rateAuto.pages.set('aleppo_rates', 'حلب مبيع 132\nدمشق شراء 130 مبيع ١٣١٫٢٥');
    await open(page, admin, '/rates');
    await page.getByRole('link', { name: ar.rates.sources.add }).click();
    await expect(page).toHaveURL('/rates/sources/new');
    await field(page, ar.rates.sourceForm.label).fill('قناة حلب');
    await field(page, ar.rates.sourceForm.handle.telegram_channel).fill('bad handle');
    await page.getByRole('button', { name: ar.rates.sourceForm.test }).click();
    await expect(page.getByText(ar.rates.sourceForm.errors.handle.telegram_channel)).toBeVisible();
    await field(page, ar.rates.sourceForm.handle.telegram_channel).fill('@aleppo_rates');
    await field(page, ar.rates.sourceForm.cityWord).fill('دمشق');
    await page.getByRole('button', { name: ar.rates.sourceForm.test }).click();
    await expect(page.getByText('دمشق شراء 130 مبيع 131.25')).toBeVisible();
    await expect(page.getByText('131.25', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: ar.rates.sourceForm.save }).click();
    await expect(page).toHaveURL('/rates');
    expect(admin.lastBody('POST /api/admin/rate-sources')).toEqual({
      kind: 'telegram_channel',
      label: 'قناة حلب',
      handle: 'aleppo_rates',
      parser: { cityWord: 'دمشق', sellWord: 'مبيع', unit: 'new_syp' },
      enabled: true,
    });
    await expect(page.getByText('قناة حلب')).toBeVisible();

    await page.getByRole('switch', { name: ar.rates.sources.enabled }).first().click();
    await expect(page.getByRole('switch').first()).not.toBeChecked();
    expect(admin.lastBody(`PATCH /api/admin/rate-sources/${rateId(1)}`)).toEqual({
      enabled: false,
    });
  });

  test('switches the kind of a new source to a sp-today page with its own sell word', async ({
    page,
    admin,
  }) => {
    await open(page, admin, '/rates/sources/new');
    await chooseOption(
      page,
      page.getByRole('combobox', { name: ar.rates.sourceForm.kind }),
      ar.rates.kinds.sp_today_page,
    );
    await expect(field(page, ar.rates.sourceForm.sellWord)).toHaveValue('بيع');
    await expect(field(page, ar.rates.sourceForm.handle.sp_today_page)).toBeVisible();
  });

  test('turns automatic updates on with its thresholds, re-authenticated', async ({
    page,
    admin,
  }) => {
    admin.reauthenticationRequired = true;
    await open(page, admin, '/rates/settings');
    await field(page, ar.rates.settings.fields.autoMaxMoveBps.label).fill('3.5');
    await page.getByRole('switch', { name: ar.rates.settings.autoEnabled }).click();
    await page.getByRole('button', { name: ar.rates.settings.save }).click();
    await expect(page.getByText(ar.rates.settings.fields.autoMaxMoveBps.error)).toBeVisible();
    await field(page, ar.rates.settings.fields.autoMaxMoveBps.label).fill('1.5');
    await page.getByRole('button', { name: ar.rates.settings.save }).click();
    await reauthenticate(page);
    await expect(page.getByText(ar.rates.settings.saved)).toBeVisible();
    expect(admin.lastBody('POST /api/admin/rate-settings')).toMatchObject({
      autoEnabled: true,
      autoMaxMoveBps: 150,
      telegramApproveMaxBps: 500,
    });
    await page.goto('/rates');
    await expect(page.getByText(ar.rates.auto.onHelp)).toBeVisible();
  });
});

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('S27 rate screenshots', async ({ page, admin }, testInfo) => {
      admin.rateAuto.suggest('121.5', 'sources_disagree');
      await open(page, admin, '/rates');
      await expect(page.getByText(ar.rates.health.broken)).toBeVisible();
      await screenshot(page, testInfo, `rates-auto-${colorScheme}`, { fullPage: true });

      await page.getByRole('button', { name: ar.rates.suggestion.approve, exact: true }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await screenshot(page, testInfo, `rates-approve-${colorScheme}`);
      await page.keyboard.press('Escape');

      await page.goto('/rates/sources/new');
      await field(page, ar.rates.sourceForm.label).fill('قناة أسعار دمشق 2');
      await field(page, ar.rates.sourceForm.handle.telegram_channel).fill('damascus_rates');
      await field(page, ar.rates.sourceForm.cityWord).fill('دمشق');
      await page.getByRole('button', { name: ar.rates.sourceForm.test }).click();
      await expect(page.getByText('دمشق: شراء 130 | مبيع 131')).toBeVisible();
      await screenshot(page, testInfo, `rates-source-${colorScheme}`, { fullPage: true });

      await page.goto('/rates/settings');
      await expect(
        page.getByRole('heading', { name: ar.rates.settings.title, level: 1 }),
      ).toBeVisible();
      await screenshot(page, testInfo, `rates-settings-${colorScheme}`, { fullPage: true });
    });
  });
}
