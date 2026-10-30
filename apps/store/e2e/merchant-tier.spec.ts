import {
  type MerchantCertificate,
  type MerchantTierHistory,
  type MerchantTierTable,
  TIER_SETTINGS_DEFAULTS,
} from '@vertex-digital/contracts';
import tools from '../src/features/merchant-tools/messages.ar.json' with { type: 'json' };
import ar from '../src/messages/ar.json' with { type: 'json' };
import { expect, type MockApi, screenshot, test } from './test';
import { tierSummary } from './tier-fixtures';

/*
 * The merchant's tier in the store (S23 PR 2): the badge in the area's header and the account
 * menu (ID2), the tier card (ID3), the celebration (ID4), the tier page with its table, forecast
 * and history (PG1–PG5), the certificate's print and public page (ID7) and the reissue. RTL
 * screenshots at phone width and desktop, dark and light.
 */

const USD = 1_000_000;
const PACK = '0199e300-0000-7000-8000-0000000000c1';
const PACK_2 = '0199e300-0000-7000-8000-0000000000c2';
const lightTheme = () => localStorage.setItem('vertex-theme', 'light');

function signedIn(api: MockApi): MockApi {
  return api.on('GET /api/auth/get-session', 200, {
    user: {
      name: 'سارة الأحمد',
      email: 'sara@example.com',
      emailVerified: true,
      accountType: 'merchant',
    },
    session: { token: 'this-device' },
  });
}

/** A Silver merchant at $720 of $1,000 this month, on the way to Gold. */
const silver = tierSummary({
  tier: 'silver',
  keptUntil: '2026-11-30',
  thisMonthUsdUnits: 720 * USD,
  progress: {
    next: { tier: 'gold', thresholdUsdUnits: 1_000 * USD, missingUsdUnits: 280 * USD },
    reachedPermille: 720,
    keep: null,
  },
  forecast: { kind: 'reach', day: 22 },
  savingsUsdUnits: 12_400_000,
  privileges: TIER_SETTINGS_DEFAULTS.silver,
});

const table: MerchantTierTable = {
  current: 'silver',
  packs: [
    { productId: PACK, gameNameAr: 'ببجي موبايل', nameAr: '60 UC' },
    { productId: PACK_2, gameNameAr: 'فري فاير', nameAr: '100 جوهرة' },
  ],
  tiers: [
    {
      tier: 'bronze',
      available: true,
      thresholdUsdUnits: null,
      privileges: TIER_SETTINGS_DEFAULTS.bronze,
      prices: [940_000, 1_050_000],
    },
    {
      tier: 'silver',
      available: true,
      thresholdUsdUnits: 300 * USD,
      privileges: TIER_SETTINGS_DEFAULTS.silver,
      prices: [930_000, 1_040_000],
    },
    {
      tier: 'gold',
      available: true,
      thresholdUsdUnits: 1_000 * USD,
      privileges: TIER_SETTINGS_DEFAULTS.gold,
      prices: [920_000, 1_030_000],
    },
    {
      tier: 'diamond',
      available: true,
      thresholdUsdUnits: 3_000 * USD,
      privileges: TIER_SETTINGS_DEFAULTS.diamond,
      prices: [910_000, null],
    },
  ],
};

const history: MerchantTierHistory = {
  items: [
    { month: '2026-10', netPurchasesUsdUnits: 720 * USD, tier: 'silver', current: true },
    { month: '2026-09', netPurchasesUsdUnits: 410 * USD, tier: 'silver', current: false },
  ],
};

const certificate: MerchantCertificate = {
  code: 'CertGold0123456789abcd',
  tradeName: 'محل النور للاتصالات',
  city: 'اعزاز',
  governorate: 'aleppo',
  tier: 'silver',
  since: '2026-10-02T09:00:00.000Z',
  reissuedAt: null,
};

function tierPage(api: MockApi, summary = silver): MockApi {
  return signedIn(api)
    .on('GET /api/merchant/tier', 200, summary)
    .on('GET /api/merchant/tier/table', 200, table)
    .on('GET /api/merchant/tier/history', 200, history)
    .on('GET /api/merchant/certificate', 200, certificate);
}

test.describe('the tier page (S23 ID3, PG1–PG5)', () => {
  for (const scheme of ['dark', 'light'] as const) {
    test(`shows the card, forecast, table and history, ${scheme}`, async ({
      page,
      api,
    }, testInfo) => {
      if (scheme === 'light') await page.addInitScript(lightTheme);
      tierPage(api);
      await page.goto('/merchant/tier');
      await expect(page.getByTestId('merchant-tier')).toHaveText(tools.tier.badge.silver);
      const card = page.getByTestId('tier-card');
      await expect(card).toContainText('$720.00');
      await expect(card).toContainText('$280.00');
      await expect(card).toContainText('$12.40');
      await expect(page.getByTestId('tier-forecast')).toContainText('22');
      const tableView = page.getByTestId('tier-table');
      await expect(
        tableView.getByText(tools.tier.page.you).filter({ visible: true }),
      ).toBeVisible();
      await expect(tableView.getByText('$0.92').filter({ visible: true })).toBeVisible();
      await expect(page.getByTestId('tier-history')).toContainText('$410.00');
      await expect(page.getByRole('link', { name: tools.tier.page.print })).toHaveAttribute(
        'href',
        '/merchant/certificate/print',
      );
      await screenshot(page, testInfo, `merchant-tier-page-${scheme}`);
    });
  }

  test('shows the tier card on the dashboard and the badge in the account menu', async ({
    page,
    api,
  }) => {
    signedIn(api).on('GET /api/merchant/tier', 200, silver).on('GET /api/merchant/dashboard', 200, {
      period: 'today',
      from: '2026-10-21T00:00:00.000Z',
      salesUsdUnits: 0,
      salesSypUnits: null,
      spendingUsdUnits: 0,
      profitUsdUnits: 0,
      ordersWithoutSale: 0,
      balanceUsdUnits: 0,
      topProducts: [],
      sellingConfigured: true,
    });
    await page.goto('/merchant');
    await expect(page.getByTestId('tier-card')).toContainText(tools.tier.badge.silver);
    await page.getByRole('button', { name: ar.header.menu }).click();
    await expect(
      page.getByRole('menuitem', { name: new RegExp(ar.header.merchantTools) }),
    ).toContainText('تاجر فضي');
  });

  test('says the history starts this month, and keeps the top tier (PG1, PG5)', async ({
    page,
    api,
  }) => {
    tierPage(
      api,
      tierSummary({
        tier: 'diamond',
        progress: {
          next: null,
          reachedPermille: 400,
          keep: { thresholdUsdUnits: 3_000 * USD, missingUsdUnits: 1_800 * USD },
        },
        privileges: TIER_SETTINGS_DEFAULTS.diamond,
      }),
    ).on('GET /api/merchant/tier/history', 200, { items: [history.items[0]] });
    await page.goto('/merchant/tier');
    await expect(page.getByTestId('tier-card')).toContainText(tools.tier.top);
    await expect(page.getByTestId('tier-card')).toContainText('$1,800.00');
    await expect(page.getByText(tools.tier.page.historyEmpty)).toBeVisible();
  });
});

test.describe('the celebration (S23 ID4)', () => {
  for (const scheme of ['dark', 'light'] as const) {
    test(`shows once after a rise and tells the API, ${scheme}`, async ({
      page,
      api,
    }, testInfo) => {
      if (scheme === 'light') await page.addInitScript(lightTheme);
      tierPage(api, { ...silver, tier: 'gold', celebrate: true });
      api.on('POST /api/merchant/tier/celebrated', 204, null);
      await page.goto('/merchant/tier');
      const sheet = page.getByTestId('tier-celebration');
      await expect(sheet).toBeVisible();
      await expect(sheet).toContainText(tools.tier.badge.gold);
      await screenshot(page, testInfo, `merchant-tier-celebration-${scheme}`);
      await sheet.getByRole('button', { name: tools.tier.celebration.continue }).click();
      await expect(sheet).toBeHidden();
      expect(api.count('POST /api/merchant/tier/celebrated')).toBe(1);
    });
  }
});

test.describe('the certificate (S23 ID7)', () => {
  test('prints the certificate on A4 landscape with its QR', async ({ page, api }, testInfo) => {
    tierPage(api);
    await page.goto('/merchant/certificate/print');
    const document = page.getByTestId('certificate-document');
    await expect(document).toContainText('محل النور للاتصالات');
    await expect(document).toContainText('تاجر فضي معتمد');
    await expect(page.getByRole('img', { name: tools.tier.certificate.scan })).toBeVisible();
    await screenshot(page, testInfo, 'merchant-certificate-print');
  });

  test('reissues the code after a confirmation', async ({ page, api }) => {
    tierPage(api).on('POST /api/merchant/certificate/reissue', 200, {
      ...certificate,
      code: 'CertNew00123456789abcd',
      reissuedAt: '2026-10-21T10:00:00.000Z',
    });
    await page.goto('/merchant/tier');
    await page.getByRole('button', { name: tools.tier.page.reissue }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: tools.tier.page.reissue })
      .click();
    await expect(page.getByText(tools.tier.page.reissueDone)).toBeVisible();
    expect(api.count('POST /api/merchant/certificate/reissue')).toBe(1);
  });

  for (const scheme of ['dark', 'light'] as const) {
    test(`shows the public page of a code, a revoked shop and an unknown code, ${scheme}`, async ({
      page,
    }, testInfo) => {
      if (scheme === 'light') await page.addInitScript(lightTheme);
      await page.goto('/m/CertGold0123456789abcd');
      const shown = page.getByTestId('certificate-public');
      await expect(shown).toContainText('محل النور للاتصالات');
      await expect(shown).toContainText('تاجر ذهبي معتمد');
      await expect(shown).toContainText(tools.tier.public.active);
      await screenshot(page, testInfo, `merchant-certificate-public-${scheme}`);
      await page.goto('/m/CertGone0123456789abcd');
      await expect(page.getByText(tools.tier.public.revoked)).toBeVisible();
      await page.goto('/m/CertNone0123456789abcd');
      await expect(page.getByText(tools.tier.public.notFound)).toBeVisible();
    });
  }
});

test.describe('the tier on receipts (S23 ID5)', () => {
  test('shows the current tier on the verification page', async ({ page }, testInfo) => {
    await page.goto('/v/VrfyShop0123456789abcd');
    await expect(page.getByTestId('tier-line')).toContainText('تاجر ذهبي معتمد من Vertex Digital');
    await screenshot(page, testInfo, 'verification-page-tier');
  });
});
