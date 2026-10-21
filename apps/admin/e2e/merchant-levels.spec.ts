import type { Page } from '@playwright/test';
import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import { CUSTOMER_IDS } from './customers-mock';
import { expect, PASSWORD, screenshot, TOTP_CODE, test } from './test';

/*
 * Volume levels in the panel (S21 PR 1, F39) against the mocked API: create a level with
 * re-authentication, the refusal of a second level at the same threshold, edit and archive, the
 * merchants list's level column and filter, and the level on the customer profile, with RTL
 * screenshots in both themes.
 */

const m = ar.merchants;
const l = m.levels;

const field = (page: Page, label: string) =>
  page.getByLabel(label, { exact: true }).filter({ visible: true });

async function reauthenticate(page: Page) {
  await expect(page.getByRole('heading', { name: ar.reauth.title })).toBeVisible();
  await field(page, ar.reauth.password).fill(PASSWORD);
  await page.getByRole('textbox').filter({ visible: true }).nth(1).pressSequentially(TOTP_CODE);
  await page.getByRole('button', { name: ar.reauth.submit }).click();
}

async function addLevel(page: Page, name: string, threshold: string) {
  await page.getByRole('button', { name: l.add }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(l.fields.name, { exact: true }).fill(name);
  await dialog.getByLabel(l.fields.threshold, { exact: true }).fill(threshold);
  await dialog.getByRole('button', { name: l.add }).click();
}

test.describe('merchant levels', () => {
  test('creates, refuses a taken threshold, edits and archives a level (LV1, LV6)', async ({
    page,
    admin,
  }) => {
    admin.signedIn = true;
    admin.reauthenticationRequired = true;
    await page.goto('/merchants/levels');
    await expect(page.getByText(l.empty)).toBeVisible();

    await page.getByRole('button', { name: l.add }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: l.add }).click();
    await expect(dialog.getByText(l.validation.name)).toBeVisible();
    await dialog.getByLabel(l.fields.name, { exact: true }).fill('فضي');
    await dialog.getByLabel(l.fields.threshold, { exact: true }).fill('50.5');
    await dialog.getByRole('button', { name: l.add }).click();
    await expect(dialog.getByText(l.validation.threshold)).toBeVisible();
    await dialog.getByLabel(l.fields.threshold, { exact: true }).fill('50');
    await dialog.getByRole('button', { name: l.add }).click();
    await reauthenticate(page);
    await expect(page.getByRole('cell', { name: 'فضي' })).toBeVisible();
    expect(admin.merchants.levels).toHaveLength(1);

    await addLevel(page, 'ذهبي', '50');
    await expect(page.getByText(ar.errors.api.MERCHANT_LEVEL_THRESHOLD_TAKEN)).toBeVisible();
    await page.getByRole('dialog').getByLabel(l.fields.threshold, { exact: true }).fill('200');
    await page.getByRole('dialog').getByRole('button', { name: l.add }).click();
    await expect(page.getByRole('cell', { name: 'ذهبي' })).toBeVisible();

    await page.getByRole('button', { name: l.edit }).first().click();
    await page.getByRole('dialog').getByLabel(l.fields.threshold, { exact: true }).fill('40');
    await page.getByRole('dialog').getByRole('button', { name: l.save }).click();
    await expect(page.getByRole('cell', { name: '$40.00' })).toBeVisible();

    await page.getByRole('button', { name: l.archive }).first().click();
    await page.getByRole('alertdialog').getByRole('button', { name: l.archive }).click();
    await expect(page.getByRole('heading', { name: l.archived })).toBeVisible();
    expect(admin.merchants.levels.filter((level) => level.archivedAt === null)).toHaveLength(1);
  });

  test('shows the level on the merchants list and the profile', async ({ page, admin }) => {
    admin.signedIn = true;
    const application = admin.merchants.seedApplication(CUSTOMER_IDS.sara);
    await page.goto(`/merchants/applications/${application.id}`);
    await page.getByRole('button', { name: m.decisions.approve }).click();
    await page.getByRole('dialog').getByRole('button', { name: m.decisions.approve }).click();
    await expect(page.getByText(m.statuses.approved).first()).toBeVisible();
    await page.goto('/merchants/levels');
    await addLevel(page, 'فضي', '50');
    await expect(page.getByRole('cell', { name: 'فضي' })).toBeVisible();
    admin.merchants.setLevel(CUSTOMER_IDS.sara, admin.merchants.levels[0]?.id ?? null);

    await page.goto('/merchants');
    await expect(page.getByRole('cell', { name: 'فضي' })).toBeVisible();
    await page.goto('/merchants?levelId=none');
    await expect(page.getByText(m.list.emptyFiltered)).toBeVisible();

    await page.goto(`/customers/${CUSTOMER_IDS.sara}`);
    await expect(page.getByText(m.profile.thisMonth)).toBeVisible();
    await expect(page.getByRole('link', { name: 'فضي' })).toBeVisible();
  });
});

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('the levels page and the profile’s merchant card', async ({ page, admin }, testInfo) => {
      admin.signedIn = true;
      const application = admin.merchants.seedApplication(CUSTOMER_IDS.sara);
      await page.goto(`/merchants/applications/${application.id}`);
      await page.getByRole('button', { name: m.decisions.approve }).click();
      await page.getByRole('dialog').getByRole('button', { name: m.decisions.approve }).click();
      await expect(page.getByText(m.statuses.approved).first()).toBeVisible();
      await page.goto('/merchants/levels');
      await addLevel(page, 'فضي', '50');
      await addLevel(page, 'ذهبي', '200');
      await expect(page.getByRole('cell', { name: 'ذهبي' })).toBeVisible();
      admin.merchants.setLevel(CUSTOMER_IDS.sara, admin.merchants.levels[0]?.id ?? null);
      await page.reload();
      await expect(page.getByRole('cell', { name: 'فضي' })).toBeVisible();
      await screenshot(page, testInfo, `merchant-levels-${colorScheme}`);
      await page.goto(`/customers/${CUSTOMER_IDS.sara}`);
      await expect(page.getByText(m.profile.thisMonth)).toBeVisible();
      await screenshot(page, testInfo, `merchant-profile-level-${colorScheme}`, { fullPage: true });
    });
  });
}
