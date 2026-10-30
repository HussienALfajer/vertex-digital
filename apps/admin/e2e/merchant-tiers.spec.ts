import type { Locator, Page } from '@playwright/test';
import { formatUsd, TIER_LIST_NAMES } from '@vertex-digital/contracts';
import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import { CUSTOMER_IDS } from './customers-mock';
import { type AdminApi, chooseOption, expect, PASSWORD, screenshot, TOTP_CODE, test } from './test';

/*
 * Merchant tiers in the panel (S23 PR 1b) against the mocked API: the tiers page with each tier's
 * threshold, list and privileges edited under re-authentication (TS1, TS2) and a tier stopped, the
 * threshold preview (AD3), a manual grant from the customer's profile and its early end (MG1, MG3),
 * the merchants list's tier column and filter (AD1), with RTL screenshots in both themes.
 */

const m = ar.merchants;
const tiers = m.tiers;
const USD = 1_000_000;

const field = (scope: Page | Locator, label: string) =>
  scope.getByLabel(label, { exact: true }).filter({ visible: true });

async function reauthenticate(page: Page) {
  await expect(page.getByRole('heading', { name: ar.reauth.title })).toBeVisible();
  await field(page, ar.reauth.password).fill(PASSWORD);
  await page.getByRole('textbox').filter({ visible: true }).nth(1).pressSequentially(TOTP_CODE);
  await page.getByRole('button', { name: ar.reauth.submit }).click();
}

/** The production setup's tiers, Sara a Bronze merchant ($180 this month) and Omar a Gold one. */
function setup(admin: AdminApi) {
  admin.signedIn = true;
  for (const [id, tradeName] of [
    [CUSTOMER_IDS.sara, 'متجر نور'],
    [CUSTOMER_IDS.omar, 'صالة الألعاب الذهبية'],
  ] as const) {
    admin.merchants.answer(
      'POST',
      new URL(`http://admin.test/api/admin/customers/${id}/merchant`),
      { tradeName, governorate: 'damascus', city: 'دمشق', reason: 'تاجر معروف لدينا' },
    );
  }
  admin.merchants.setupTiers();
  admin.merchants.setMonths(CUSTOMER_IDS.omar, 1_200 * USD, 400 * USD);
}

const card = (page: Page, tier: string) =>
  page.locator('[data-slot="card"]').filter({ has: page.getByRole('group', { name: tier }) });

test.describe('merchant tiers', () => {
  test('edits a threshold, a list check and the privileges, then stops a tier (TS1, TS2, MG7)', async ({
    page,
    admin,
  }) => {
    setup(admin);
    admin.reauthenticationRequired = true;
    await page.goto('/merchants/tiers');
    const gold = card(page, m.tierNames.gold);
    await expect(card(page, m.tierNames.silver).getByText(formatUsd(300 * USD))).toBeVisible();
    await expect(gold.getByText(formatUsd(1_000 * USD))).toBeVisible();
    await expect(gold.getByRole('link', { name: TIER_LIST_NAMES.gold })).toBeVisible();
    await expect(card(page, m.tierNames.bronze).getByText(tiers.everyMerchant)).toBeVisible();
    await expect(
      gold.getByText(tiers.merchants.replace('{{earned}}', '1').replace('{{granted}}', '0')),
    ).toBeVisible();

    // A threshold below Silver's is refused by the server's order rule.
    await gold.getByRole('button', { name: tiers.editLevel }).click();
    let dialog = page.getByRole('dialog');
    await field(dialog, tiers.level.threshold).fill('200');
    await dialog.getByRole('button', { name: tiers.level.submit }).click();
    await reauthenticate(page);
    await expect(dialog.getByText(ar.errors.api.MERCHANT_TIER_ORDER_INVALID)).toBeVisible();
    await field(dialog, tiers.level.threshold).fill('800');
    await dialog.getByRole('button', { name: tiers.level.submit }).click();
    await expect(dialog).toBeHidden();
    await expect(gold.getByText(formatUsd(800 * USD))).toBeVisible();
    expect(admin.merchants.levels.gold?.monthlyThresholdUsdUnits).toBe(800 * USD);

    // The privileges: a limit below the deposit minimum is refused in place.
    await gold.getByRole('button', { name: tiers.editSettings }).click();
    dialog = page.getByRole('dialog');
    const perDeposit = field(dialog, tiers.settings.fields.perDepositUsdUnits);
    await expect(perDeposit).toHaveValue('5000');
    await perDeposit.fill('1');
    await dialog.getByRole('button', { name: tiers.settings.submit }).click();
    await expect(perDeposit).toBeFocused();
    await perDeposit.fill('6000');
    await field(dialog, tiers.settings.fields.supportReplyMinutes).fill('');
    await dialog.getByRole('switch', { name: tiers.settings.fields.fastAlerts }).click();
    await dialog.getByRole('button', { name: tiers.settings.submit }).click();
    await expect(dialog).toBeHidden();
    await expect(
      gold.getByText(`${formatUsd(6_000 * USD)} / ${formatUsd(15_000 * USD)}`),
    ).toBeVisible();
    await expect(gold.getByText(tiers.noPromise)).toBeVisible();
    expect(admin.merchants.tierSettings.gold).toMatchObject({
      perDepositUsdUnits: 6_000 * USD,
      supportReplyMinutes: null,
      fastAlerts: false,
    });

    // Stopping Diamond leaves it off.
    const diamond = card(page, m.tierNames.diamond);
    await diamond.getByRole('button', { name: tiers.archive }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: tiers.archive }).click();
    await expect(diamond.getByText(tiers.off)).toBeVisible();
    await expect(diamond.getByRole('button', { name: tiers.addLevel })).toBeVisible();
    expect(admin.merchants.levels.diamond).toBeUndefined();
  });

  test('previews other thresholds (AD3)', async ({ page, admin }) => {
    setup(admin);
    await page.goto('/merchants/tiers');
    await page.getByRole('button', { name: tiers.preview.open }).click();
    const sheet = page.getByRole('dialog');
    const silver = field(sheet, tiers.preview.threshold.replace('{{tier}}', m.tierNames.silver));
    await expect(silver).toHaveValue('300');
    // Thresholds must rise with the tier.
    await silver.fill('5000');
    await sheet.getByRole('button', { name: tiers.preview.submit, exact: true }).click();
    await expect(sheet.getByText(tiers.preview.order)).toBeVisible();
    await silver.fill('150');
    await sheet.getByRole('button', { name: tiers.preview.submit, exact: true }).click();
    const rising = sheet.getByRole('listitem').filter({ hasText: 'متجر نور' });
    await expect(rising).toBeVisible();
    await expect(rising.getByText(m.tierNames.silver)).toBeVisible();
    // Nothing is saved.
    expect(admin.merchants.levels.silver?.monthlyThresholdUsdUnits).toBe(300 * USD);
  });

  test('grants a tier from the profile, filters it, then ends it (MG1, MG3, AD1, AD5)', async ({
    page,
    admin,
  }) => {
    setup(admin);
    admin.reauthenticationRequired = true;
    await page.goto(`/customers/${CUSTOMER_IDS.sara}`);
    await expect(page.getByText(tiers.profile.earnedSource, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: tiers.grant.action }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: tiers.grant.submit }).click();
    await expect(dialog.getByText(tiers.grant.tierError)).toBeVisible();
    await expect(dialog.getByText(m.validation.reason)).toBeVisible();
    await chooseOption(
      page,
      dialog.getByRole('combobox', { name: tiers.grant.tier }),
      m.tierNames.diamond,
    );
    await field(dialog, m.fields.reason).fill('تجربة شهر بأسعار الماسية');
    await dialog.getByRole('button', { name: tiers.grant.submit }).click();
    await reauthenticate(page);
    await expect(dialog).toBeHidden();
    await expect(page.getByText(tiers.grantedMark).first()).toBeVisible();
    await expect(page.getByText(/ممنوحة يدوياً حتى/)).toBeVisible();
    await expect(page.getByText(tiers.grant.running)).toBeVisible();
    await expect(page.getByText(`الافتراضي: ${m.tierNames.diamond}`).first()).toBeVisible();

    await page.goto('/merchants');
    const tierFilter = page.getByRole('combobox', { name: m.list.tierFilter });
    await chooseOption(page, tierFilter, m.list.granted);
    await expect(page).toHaveURL(/tier=granted/);
    await expect(page.getByRole('cell', { name: 'متجر نور' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'صالة الألعاب الذهبية' })).toHaveCount(0);
    await chooseOption(page, tierFilter, m.tierNames.gold);
    await expect(page.getByRole('cell', { name: 'صالة الألعاب الذهبية' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'متجر نور' })).toHaveCount(0);

    await page.goto(`/customers/${CUSTOMER_IDS.sara}`);
    await page.getByRole('button', { name: tiers.grant.end }).click();
    await field(page.getByRole('dialog'), m.fields.reason).fill('انتهت التجربة مبكراً');
    await page.getByRole('dialog').getByRole('button', { name: tiers.grant.endSubmit }).click();
    await expect(page.getByRole('button', { name: tiers.grant.action })).toBeVisible();
    await expect(page.getByText(/أنهاها المدير/)).toBeVisible();
    expect(admin.merchants.profileOf(CUSTOMER_IDS.sara)?.tier.tier).toBe('bronze');
  });
});

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('the tiers page, the preview, the grant and the filtered merchants', async ({
      page,
      admin,
    }, testInfo) => {
      test.setTimeout(90_000);
      setup(admin);
      await page.goto('/merchants/tiers');
      await expect(card(page, m.tierNames.gold).getByText(formatUsd(1_000 * USD))).toBeVisible();
      // S23 PX5: the best sellers with each tier's price, Diamond's fixed on the first.
      const sellers = page.getByTestId('tier-best-sellers');
      await expect(sellers).toContainText('660 UC');
      await expect(sellers).toContainText(tiers.bestSellers.fixed);
      await screenshot(page, testInfo, `merchant-tiers-${colorScheme}`, { fullPage: true });
      await card(page, m.tierNames.gold).getByRole('button', { name: tiers.editSettings }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await screenshot(page, testInfo, `merchant-tier-settings-${colorScheme}`);
      await page.getByRole('button', { name: ar.common.close }).first().click();
      await page.getByRole('button', { name: tiers.preview.open }).click();
      const sheet = page.getByRole('dialog');
      await field(sheet, tiers.preview.threshold.replace('{{tier}}', m.tierNames.silver)).fill(
        '150',
      );
      await sheet.getByRole('button', { name: tiers.preview.submit, exact: true }).click();
      await expect(sheet.getByText('متجر نور')).toBeVisible();
      await screenshot(page, testInfo, `merchant-tier-preview-${colorScheme}`);

      await page.goto(`/customers/${CUSTOMER_IDS.sara}`);
      await page.getByRole('button', { name: tiers.grant.action }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await screenshot(page, testInfo, `merchant-tier-grant-${colorScheme}`);
      await chooseOption(
        page,
        page.getByRole('dialog').getByRole('combobox', { name: tiers.grant.tier }),
        m.tierNames.gold,
      );
      await field(page.getByRole('dialog'), m.fields.reason).fill('تجربة بأسعار الذهبية');
      await page.getByRole('dialog').getByRole('button', { name: tiers.grant.submit }).click();
      await expect(page.getByText(tiers.grant.running)).toBeVisible();
      await screenshot(page, testInfo, `merchant-tier-profile-${colorScheme}`, { fullPage: true });

      await page.goto('/merchants?tier=gold');
      await expect(page.getByRole('cell', { name: 'متجر نور' })).toBeVisible();
      await screenshot(page, testInfo, `merchants-tier-${colorScheme}`);
    });
  });
}
