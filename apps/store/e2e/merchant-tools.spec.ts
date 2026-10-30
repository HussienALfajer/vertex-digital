import type {
  AlertSettings,
  MerchantAlertPage,
  MerchantDashboard,
  SellingPriceRow,
  SellingPrices,
  Watches,
} from '@vertex-digital/contracts';
import tools from '../src/features/merchant-tools/messages.ar.json' with { type: 'json' };
import ar from '../src/messages/ar.json' with { type: 'json' };
import { expect, type MockApi, screenshot, test } from './test';

/*
 * S21 PR 1, the merchant area in the store: the account menu's "أدوات التاجر", the dashboard with
 * its empty state, figures, top products and level card (F30), the selling prices with the
 * markup and a pack's own price (F31), the follows, alert settings and events (F37), and the
 * page a customer who is not a merchant sees.
 */

const GAME = '0199e100-0000-7000-8000-0000000000a1';
const PACK = '0199e100-0000-7000-8000-0000000000b1';
const PACK_2 = '0199e100-0000-7000-8000-0000000000b2';
const USD = 1_000_000;
const lightTheme = () => localStorage.setItem('vertex-theme', 'light');

function signedIn(api: MockApi, accountType: 'merchant' | 'customer' = 'merchant'): MockApi {
  return api.on('GET /api/auth/get-session', 200, {
    user: { name: 'سارة الأحمد', email: 'sara@example.com', emailVerified: true, accountType },
    session: { token: 'this-device' },
  });
}

const dashboard = (changes: Partial<MerchantDashboard> = {}): MerchantDashboard => ({
  period: 'today',
  from: '2026-10-21T21:00:00.000Z',
  salesUsdUnits: 48_600_000,
  salesSypUnits: 631_500_000,
  spendingUsdUnits: 41_250_000,
  profitUsdUnits: 7_350_000,
  ordersWithoutSale: 2,
  balanceUsdUnits: 182_400_000,
  topProducts: [
    {
      productId: PACK,
      gameNameAr: 'ببجي موبايل',
      nameAr: '60 شدة',
      units: 18,
      salesUsdUnits: 21_600_000,
    },
    {
      productId: PACK_2,
      gameNameAr: 'ببجي موبايل',
      nameAr: '325 شدة',
      units: 6,
      salesUsdUnits: 27_000_000,
    },
  ],
  sellingConfigured: true,
  ...changes,
});

const row = (changes: Partial<SellingPriceRow> = {}): SellingPriceRow => ({
  productId: PACK,
  nameAr: '60 شدة',
  available: true,
  purchaseUsdUnits: 1_050_000,
  ownPrice: null,
  sellingUsdUnits: 1_160_000,
  sellingSypUnits: 1_510_000,
  source: 'markup',
  belowCost: false,
  ...changes,
});

const prices = (rows: SellingPriceRow[]): SellingPrices => ({
  settings: { markupBp: 1000, sypStepUnits: 50_000 },
  storeStepUnits: 500,
  products: rows,
});

const watches = (changes: Partial<Watches> = {}): Watches => ({
  games: [],
  products: [],
  suggestions: {
    games: [],
    products: [{ productId: PACK, gameId: GAME, gameNameAr: 'ببجي موبايل', nameAr: '60 شدة' }],
  },
  ...changes,
});

const alerts: MerchantAlertPage = {
  items: [
    {
      id: '0199e100-0000-7000-8000-0000000000d1',
      productId: PACK,
      gameNameAr: 'ببجي موبايل',
      productNameAr: '60 شدة',
      kind: 'price_down',
      oldPriceUsdUnits: 1_100_000,
      newPriceUsdUnits: 1_050_000,
      createdAt: '2026-10-21T08:05:00.000Z',
    },
    {
      id: '0199e100-0000-7000-8000-0000000000d2',
      productId: PACK_2,
      gameNameAr: 'ببجي موبايل',
      productNameAr: '325 شدة',
      kind: 'out_of_stock',
      oldPriceUsdUnits: null,
      newPriceUsdUnits: null,
      createdAt: '2026-10-21T07:05:00.000Z',
    },
  ],
  nextCursor: null,
};

const settings: AlertSettings = { lowBalanceUsdUnits: null, dailyEmail: false };

const games = { items: [{ id: GAME, slug: 'pubg-mobile', nameAr: 'ببجي موبايل' }] };

test.describe('the merchant area (S21 PR 1)', () => {
  test('opens from the account menu and shows the dashboard (F30)', async ({
    page,
    api,
  }, testInfo) => {
    signedIn(api).on('GET /api/merchant/dashboard', 200, dashboard());
    await page.goto('/');
    await page.getByRole('button', { name: ar.header.menu }).click();
    await page.getByRole('menuitem', { name: ar.header.merchantTools }).click();
    await expect(page).toHaveURL('/merchant');
    const board = page.getByTestId('merchant-dashboard');
    await expect(board).toContainText('$48.60');
    await expect(board).toContainText('$7.35');
    await expect(board).toContainText(tools.dashboard.withoutSale.replace('{count}', '2'));
    // S23 ID3: the tier card in place of S21's level card.
    await expect(page.getByTestId('tier-card')).toContainText(tools.tier.badge.bronze);
    await screenshot(page, testInfo, 'merchant-dashboard');

    api.on('GET /api/merchant/dashboard', 200, dashboard({ period: 'month' }));
    const month = page.getByRole('button', { name: tools.dashboard.periods.month });
    await month.click();
    await expect(month).toHaveAttribute('aria-pressed', 'true');
  });

  test('asks a new merchant to set a markup, light theme (DB5)', async ({
    page,
    api,
  }, testInfo) => {
    await page.addInitScript(lightTheme);
    signedIn(api).on(
      'GET /api/merchant/dashboard',
      200,
      dashboard({
        salesUsdUnits: 0,
        salesSypUnits: 0,
        profitUsdUnits: 0,
        ordersWithoutSale: 0,
        topProducts: [],
        sellingConfigured: false,
      }),
    );
    await page.goto('/merchant');
    await expect(page.getByText(tools.dashboard.emptyTitle)).toBeVisible();
    await expect(page.getByText(tools.dashboard.topEmpty)).toBeVisible();
    await screenshot(page, testInfo, 'merchant-dashboard-empty');
  });

  test('sets the markup and a pack’s own price (F31, SP1–SP3)', async ({ page, api }, testInfo) => {
    signedIn(api)
      .on('GET /api/merchant/selling-settings', 200, { markupBp: 1000, sypStepUnits: 50_000 })
      .on('GET /api/merchant/games', 200, games)
      .on(
        'GET /api/merchant/selling-prices',
        200,
        prices([
          row(),
          row({
            productId: PACK_2,
            nameAr: '325 شدة',
            purchaseUsdUnits: 4_900_000,
            ownPrice: { currency: 'usd', amountUnits: 4_500_000 },
            sellingUsdUnits: 4_500_000,
            sellingSypUnits: 58_500_000,
            source: 'product',
            belowCost: true,
          }),
        ]),
      )
      .on('PUT /api/merchant/selling-settings', 200, { markupBp: 1250, sypStepUnits: 50_000 })
      .on(
        `PUT /api/merchant/selling-prices/${PACK}`,
        200,
        row({
          ownPrice: { currency: 'syp', amountUnits: 1_500_000 },
          sellingUsdUnits: 1_150_000,
          sellingSypUnits: 1_500_000,
          source: 'product',
        }),
      );
    await page.goto('/merchant/prices');
    const rows = page.getByTestId('selling-prices');
    await expect(rows).toContainText('$1.16');
    await expect(rows).toContainText(tools.prices.belowCost);
    await screenshot(page, testInfo, 'merchant-prices');

    await page.getByLabel(tools.prices.markup).fill('12.5');
    await page.getByRole('button', { name: tools.common.save }).first().click();
    await expect(page.getByRole('status')).toHaveText(tools.common.saved);
    expect(api.last('PUT /api/merchant/selling-settings')?.body).toEqual({
      markupBp: 1250,
      sypStepUnits: 50_000,
    });

    await page.getByRole('button', { name: tools.prices.edit }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(tools.prices.amount).fill('15000');
    await screenshot(page, testInfo, 'merchant-price-dialog');
    await dialog.getByRole('button', { name: tools.common.save }).click();
    await expect(dialog).toBeHidden();
    expect(api.last(`PUT /api/merchant/selling-prices/${PACK}`)?.body).toEqual({
      currency: 'syp',
      amountUnits: 1_500_000,
    });
    await expect(rows).toContainText(tools.prices.sources.product);
  });

  test('follows a game and sets the low-balance alert (F37, AL1, AL5)', async ({
    page,
    api,
  }, testInfo) => {
    signedIn(api)
      .on('GET /api/merchant/watches', 200, watches())
      .on('GET /api/merchant/games', 200, games)
      .on('GET /api/merchant/alert-settings', 200, settings)
      .on('GET /api/merchant/alerts', 200, alerts)
      .on(
        'PUT /api/merchant/watches',
        200,
        watches({ games: [{ gameId: GAME, nameAr: 'ببجي موبايل' }] }),
      )
      .on('PUT /api/merchant/alert-settings', 200, {
        lowBalanceUsdUnits: 20 * USD,
        dailyEmail: true,
      });
    await page.goto('/merchant/alerts');
    await expect(page.getByTestId('merchant-alerts')).toContainText(tools.alerts.kinds.price_down);
    await screenshot(page, testInfo, 'merchant-alerts');

    await page.getByRole('switch', { name: 'ببجي موبايل' }).click();
    await expect
      .poll(() => api.last('PUT /api/merchant/watches')?.body)
      .toEqual({
        gameIds: [GAME],
        productIds: [],
      });
    await page.getByLabel(tools.alerts.lowBalance).fill('20');
    await page.getByRole('switch', { name: tools.alerts.dailyEmail }).click();
    await page.getByRole('button', { name: tools.common.save }).click();
    await expect(page.getByRole('status')).toHaveText(tools.common.saved);
    expect(api.last('PUT /api/merchant/alert-settings')?.body).toEqual({
      lowBalanceUsdUnits: 20 * USD,
      dailyEmail: true,
    });
  });

  test('tells a customer the area is for merchants (MA1)', async ({ page, api }) => {
    signedIn(api, 'customer').on('GET /api/merchant/dashboard', 403, {
      statusCode: 403,
      code: 'NOT_MERCHANT',
      message: 'Not a merchant',
    });
    await page.goto('/merchant');
    await expect(page.getByText(tools.common.notMerchant)).toBeVisible();
    await page.getByRole('button', { name: ar.header.menu }).click();
    await expect(page.getByRole('menuitem', { name: ar.header.merchantTools })).toHaveCount(0);
  });
});
