import type { Page } from '@playwright/test';
import { ROOT_PRICE_LIST_IDS } from '@vertex-digital/contracts';
import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import { CUSTOMER_IDS } from './customers-mock';
import { type AdminApi, expect, PASSWORD, screenshot, TOTP_CODE, test } from './test';

/*
 * Merchants in the panel (S20 PR 3) against the mocked API: the applications queue, an
 * application's decisions (request information, then approval with re-authentication; a
 * rejection with its reason), the direct grant and the revocation from the customer's profile,
 * the merchants list, the settings refused below the deposit minimum, with RTL screenshots in
 * both themes. S21 PR 2: the player-check quota in the settings, and the receipt branding on the
 * profile with the logo's removal (BR3).
 */

const LOGO = '0199e300-0000-7000-8000-0000000000f1';

/** An approved merchant with a logo and a shown WhatsApp number. */
async function brandedMerchant(page: Page, admin: AdminApi) {
  const application = seed(admin);
  await page.goto(`/merchants/applications/${application.id}`);
  await page.getByRole('button', { name: m.decisions.approve }).click();
  await page.getByRole('dialog').getByRole('button', { name: m.decisions.approve }).click();
  await expect(page.getByText(m.statuses.approved).first()).toBeVisible();
  admin.merchants.setBranding(CUSTOMER_IDS.sara, {
    showWhatsapp: true,
    whatsapp: '+963933123456',
    logoFileId: LOGO,
  });
}

const m = ar.merchants;

const field = (page: Page, label: string) =>
  page.getByLabel(label, { exact: true }).filter({ visible: true });

async function reauthenticate(page: Page) {
  await expect(page.getByRole('heading', { name: ar.reauth.title })).toBeVisible();
  await field(page, ar.reauth.password).fill(PASSWORD);
  await page.getByRole('textbox').filter({ visible: true }).nth(1).pressSequentially(TOTP_CODE);
  await page.getByRole('button', { name: ar.reauth.submit }).click();
}

function seed(admin: AdminApi) {
  admin.signedIn = true;
  return admin.merchants.seedApplication(CUSTOMER_IDS.sara);
}

test.describe('merchants', () => {
  test('requests information, then approves the resubmitted application (MA4, MA5)', async ({
    page,
    admin,
  }) => {
    const application = seed(admin);
    await page.goto('/merchants/applications');
    await page.getByRole('link', { name: application.tradeName }).click();
    await expect(page).toHaveURL(`/merchants/applications/${application.id}`);
    // The link is text with a copy button, never a link.
    await expect(page.getByText('https://instagram.com/nour.shop')).toBeVisible();
    await expect(page.getByRole('link', { name: 'https://instagram.com/nour.shop' })).toHaveCount(
      0,
    );

    await page.getByRole('button', { name: m.decisions.request_info }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: m.decisions.request_info }).click();
    await expect(dialog.getByText(m.validation.message)).toBeVisible();
    await dialog.getByLabel(m.decisions.request_infoField).fill('أرسل صورة واضحة لواجهة المحل');
    await dialog.getByRole('button', { name: m.decisions.request_info }).click();
    await expect(page.getByText(m.statuses.info_requested).first()).toBeVisible();
    await expect(page.getByRole('button', { name: m.decisions.approve })).toHaveCount(0);

    admin.merchants.resubmit(application.id);
    admin.reauthenticationRequired = true;
    await page.reload();
    await page.getByRole('button', { name: m.decisions.approve }).click();
    await page.getByRole('dialog').getByRole('button', { name: m.decisions.approve }).click();
    await reauthenticate(page);
    await expect(page.getByText(m.statuses.approved).first()).toBeVisible();
    // The mock's state, once the approval's answer landed: the status text can show first (a
    // flake on main's CI after #178).
    await expect.poll(() => admin.merchants.isMerchant(CUSTOMER_IDS.sara)).toBe(true);
    await expect(page.getByText(m.events.resubmitted)).toBeVisible();
  });

  test('rejects with the reason the customer reads, an empty one refused in place (MA4, A06-49)', async ({
    page,
    admin,
  }) => {
    const application = seed(admin);
    await page.goto(`/merchants/applications/${application.id}`);
    await page.getByRole('button', { name: m.decisions.reject, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: m.decisions.reject }).click();
    await expect(dialog.getByText(m.validation.message)).toBeVisible();
    await expect(dialog.getByLabel(m.decisions.rejectField)).toBeFocused();
    await dialog.getByLabel(m.decisions.rejectField).fill('لم نتمكن من التحقق من المحل');
    await dialog.getByRole('button', { name: m.decisions.reject }).click();
    await expect(page.getByText(m.statuses.rejected).first()).toBeVisible();
    await page.goto('/merchants/applications');
    await expect(page.getByText(m.applications.empty.under_review)).toBeVisible();
  });

  test('a frozen applicant cannot be approved, and a freeze meanwhile says why (A06-46)', async ({
    page,
    admin,
  }) => {
    admin.signedIn = true;
    const frozen = admin.merchants.seedApplication(CUSTOMER_IDS.rami);
    await page.goto(`/merchants/applications/${frozen.id}`);
    await expect(page.getByText(m.decisions.customerBlocked)).toBeVisible();
    await expect(
      page.getByRole('button', { name: m.decisions.approve, exact: true }),
    ).toBeDisabled();
    await expect(page.getByRole('button', { name: m.decisions.reject, exact: true })).toBeEnabled();

    // Frozen after the page loaded: the approval's refusal says what to do, not to refresh.
    const application = admin.merchants.seedApplication(CUSTOMER_IDS.sara);
    await page.goto(`/merchants/applications/${application.id}`);
    await expect(page.getByText(m.customer.since)).toBeVisible();
    const sara = admin.customers.find(CUSTOMER_IDS.sara);
    if (sara) sara.frozenAt = new Date().toISOString();
    await page.getByRole('button', { name: m.decisions.approve, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: m.decisions.approve }).click();
    await expect(dialog.getByText(m.decisions.customerBlocked)).toBeVisible();
    expect(admin.merchants.isMerchant(CUSTOMER_IDS.sara)).toBe(false);
  });

  test('a failed read of the lists in the approval offers a retry (A06-44)', async ({
    page,
    admin,
  }) => {
    const application = seed(admin);
    let fail = true;
    await page.route('**/api/admin/pricing/lists', (route) =>
      fail
        ? route.fulfill({
            status: 500,
            json: { statusCode: 500, code: 'INTERNAL_ERROR', message: 'x' },
          })
        : route.fallback(),
    );
    await page.goto(`/merchants/applications/${application.id}`);
    await page.getByRole('button', { name: m.decisions.approve, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(ar.errors.generic)).toBeVisible();
    await expect(dialog.getByRole('button', { name: m.decisions.approve })).toBeDisabled();
    fail = false;
    await dialog.getByRole('button', { name: ar.common.retry }).click();
    await expect(dialog.getByRole('combobox', { name: m.fields.priceList })).toBeVisible();
    await dialog.getByRole('button', { name: m.decisions.approve }).click();
    await expect(page.getByText(m.statuses.approved).first()).toBeVisible();
  });

  test('a failed read of the applicant’s summary offers a retry (A06-45)', async ({
    page,
    admin,
  }) => {
    const application = seed(admin);
    let fail = true;
    await page.route(`**/api/admin/customers/${CUSTOMER_IDS.sara}`, (route) =>
      fail
        ? route.fulfill({
            status: 500,
            json: { statusCode: 500, code: 'INTERNAL_ERROR', message: 'x' },
          })
        : route.fallback(),
    );
    await page.goto(`/merchants/applications/${application.id}`);
    await expect(page.getByText(ar.errors.generic)).toBeVisible();
    fail = false;
    await page.getByRole('button', { name: ar.common.retry }).click();
    await expect(page.getByText(m.customer.since)).toBeVisible();
    await expect(page.getByText(ar.errors.generic)).toHaveCount(0);
  });

  test('grants from the profile, lists the merchant and revokes it (MA6, MA7)', async ({
    page,
    admin,
  }) => {
    admin.signedIn = true;
    admin.reauthenticationRequired = true;
    await page.goto(`/customers/${CUSTOMER_IDS.layla}`);
    await page.getByRole('button', { name: ar.customers.actions.menu }).click();
    await page.getByRole('menuitem', { name: m.grant.action }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: m.grant.submit }).click();
    await expect(dialog.getByText(m.validation.tradeName)).toBeVisible();
    await dialog.getByLabel(m.fields.tradeName, { exact: true }).fill('متجر الشام');
    await dialog.getByRole('combobox', { name: m.fields.governorate }).click();
    await page.getByRole('option', { name: m.governorates.damascus, exact: true }).click();
    await dialog.getByLabel(m.fields.city, { exact: true }).fill('دمشق');
    await dialog.getByLabel(m.fields.reason, { exact: true }).fill('تاجر معروف لدينا منذ سنوات');
    await dialog.getByRole('button', { name: m.grant.submit }).click();
    await reauthenticate(page);
    await expect(page.getByText(m.profile.title)).toBeVisible();
    await expect(page.getByText(m.profile.termsPending)).toBeVisible();
    await expect(
      page.getByText(ar.customers.limits.sources.default_merchant).first(),
    ).toBeVisible();

    await page.goto(`/merchants?listId=${ROOT_PRICE_LIST_IDS.wholesale}`);
    await expect(page.getByRole('cell', { name: 'متجر الشام' })).toBeVisible();
    await page.getByRole('button', { name: m.revoke.action }).click();
    await page.getByRole('dialog').getByLabel(m.fields.reason).fill('لم يعد يعمل في المحل');
    await page.getByRole('dialog').getByRole('button', { name: m.revoke.submit }).click();
    await expect(page.getByText(m.list.emptyFiltered)).toBeVisible();
    expect(admin.merchants.isMerchant(CUSTOMER_IDS.layla)).toBe(false);
  });

  test('removes a merchant’s logo with a reason and re-authentication (S21 BR3)', async ({
    page,
    admin,
  }) => {
    await brandedMerchant(page, admin);
    admin.reauthenticationRequired = true;
    await page.goto(`/customers/${CUSTOMER_IDS.sara}`);
    await expect(page.getByRole('img', { name: m.profile.logoAlt })).toBeVisible();
    await expect(page.getByText(m.profile.whatsappShown)).toBeVisible();
    await page.getByRole('button', { name: m.profile.removeLogo }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: m.profile.removeSubmit }).click();
    await expect(dialog.getByText(m.validation.reason)).toBeVisible();
    await dialog.getByLabel(m.fields.reason, { exact: true }).fill('شعار مضلل للعملاء');
    await dialog.getByRole('button', { name: m.profile.removeSubmit }).click();
    await reauthenticate(page);
    await expect(page.getByText(m.profile.noLogo)).toBeVisible();
  });

  test('saves the merchants’ player-check quota (S21 BK4)', async ({ page, admin }) => {
    admin.signedIn = true;
    await page.goto('/settings/merchants');
    await expect(field(page, m.settings.fields.playerChecksPerHour)).toHaveValue('100');
    await field(page, m.settings.fields.playerChecksPerHour).fill('5');
    await page.getByRole('button', { name: m.settings.save }).click();
    await expect(field(page, m.settings.fields.playerChecksPerHour)).toBeFocused();
    await field(page, m.settings.fields.playerChecksPerHour).fill('150');
    await page.getByRole('button', { name: m.settings.save }).click();
    await expect(page.getByText(m.settings.saved)).toBeVisible();
    expect(admin.merchants.settings.playerChecksPerHour).toBe(150);
  });

  test('refuses merchant limits below the deposit minimum', async ({ page, admin }) => {
    admin.signedIn = true;
    await page.goto('/settings/merchants');
    await expect(field(page, m.settings.fields.perDepositUsdUnits)).toHaveValue('2000');
    await field(page, m.settings.fields.perDepositUsdUnits).fill('1');
    await page.getByRole('button', { name: m.settings.save }).click();
    await expect(field(page, m.settings.fields.perDepositUsdUnits)).toBeFocused();
    await expect(page.getByText(/لا يقل عن/).last()).toBeVisible();
    await field(page, m.settings.fields.perDepositUsdUnits).fill('1500');
    await page.getByRole('button', { name: m.settings.save }).click();
    await expect(page.getByText(m.settings.saved)).toBeVisible();
    expect(admin.merchants.settings.perDepositUsdUnits).toBe(1_500_000_000);
  });
});

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('the queue, an application, the merchants and the settings', async ({
      page,
      admin,
    }, testInfo) => {
      const application = seed(admin);
      admin.merchants.seedApplication(CUSTOMER_IDS.omar, {
        tradeName: 'صالة الألعاب الذهبية',
        activity: 'gaming_lounge',
        governorate: 'damascus',
        monthlyVolume: '200_500',
      });
      await page.goto('/merchants/applications');
      await expect(page.getByRole('link', { name: application.tradeName })).toBeVisible();
      await screenshot(page, testInfo, `merchant-applications-${colorScheme}`);
      await page.goto(`/merchants/applications/${application.id}`);
      await expect(page.getByText(application.streetAddress)).toBeVisible();
      await screenshot(page, testInfo, `merchant-application-${colorScheme}`, { fullPage: true });
      admin.merchants.resubmit(application.id);
      await page.goto('/settings/merchants');
      await expect(field(page, m.settings.fields.ordersPerTenMinutes)).toHaveValue('60');
      await screenshot(page, testInfo, `merchant-settings-${colorScheme}`);
    });

    test('a merchant on the customer profile and the merchants list', async ({
      page,
      admin,
    }, testInfo) => {
      await brandedMerchant(page, admin);
      const application = admin.merchants.applications[0] as { tradeName: string };
      await page.goto(`/customers/${CUSTOMER_IDS.sara}`);
      await expect(page.getByText(m.profile.title)).toBeVisible();
      await expect(page.getByRole('img', { name: m.profile.logoAlt })).toBeVisible();
      await screenshot(page, testInfo, `merchant-profile-${colorScheme}`, { fullPage: true });
      await page.goto('/merchants');
      await expect(page.getByRole('cell', { name: application.tradeName })).toBeVisible();
      await screenshot(page, testInfo, `merchants-${colorScheme}`);
    });
  });
}
