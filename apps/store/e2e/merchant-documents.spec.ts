import type { MerchantPriceList, Statement } from '@vertex-digital/contracts';
import tools from '../src/features/merchant-tools/messages.ar.json' with { type: 'json' };
import { expect, type MockApi, screenshot, test } from './test';

/*
 * S21 PR 3, the merchant's documents in the store: the price list with its options, preview,
 * print page and image (F36, PL1–PL3), and the statements: the months, a month's statement, its
 * print page and Excel file (F38, ST1–ST3).
 */

const GAME = '0199e300-0000-7000-8000-0000000000a1';
const GAME_2 = '0199e300-0000-7000-8000-0000000000a2';
const USD = 1_000_000;
const MONTH = '2026-10';
const lightTheme = () => localStorage.setItem('vertex-theme', 'light');

function signedIn(api: MockApi): MockApi {
  return api
    .on('GET /api/auth/get-session', 200, {
      user: {
        name: 'سارة الأحمد',
        email: 'sara@example.com',
        emailVerified: true,
        accountType: 'merchant',
      },
      session: { token: 'this-device' },
    })
    .on('GET /api/merchant/games', 200, {
      items: [
        { id: GAME, slug: 'pubg-mobile', nameAr: 'ببجي موبايل' },
        { id: GAME_2, slug: 'free-fire', nameAr: 'فري فاير' },
      ],
    });
}

const list = (changes: Partial<MerchantPriceList> = {}): MerchantPriceList => ({
  tradeName: 'محل النور للاتصالات',
  logoFileId: null,
  tier: 'gold',
  largeLogo: true,
  generatedAt: '2026-10-21T09:30:00.000Z',
  mode: 'selling',
  currency: 'syp',
  gameIds: [GAME],
  games: [
    {
      gameId: GAME,
      nameAr: 'ببجي موبايل',
      rows: [
        {
          productId: '0199e300-0000-7000-8000-0000000000b1',
          nameAr: '60 UC',
          available: true,
          usdUnits: 1_160_000,
          sypUnits: 1_500_000,
        },
        {
          productId: '0199e300-0000-7000-8000-0000000000b2',
          nameAr: '325 UC',
          available: true,
          usdUnits: 5_720_000,
          sypUnits: 7_450_000,
        },
        {
          productId: '0199e300-0000-7000-8000-0000000000b3',
          nameAr: '660 UC',
          available: true,
          usdUnits: 11_200_000,
          sypUnits: 14_500_000,
        },
      ],
    },
  ],
  omittedCount: 1,
  imagePages: 1,
  ...changes,
});

const statement = (changes: Partial<Statement> = {}): Statement => ({
  month: MONTH,
  current: true,
  generatedAt: '2026-10-21T09:30:00.000Z',
  tradeName: 'محل النور للاتصالات',
  email: 'sara@example.com',
  openingUsdUnits: 12 * USD,
  closingUsdUnits: 39_800_000,
  entries: [
    {
      occurredAt: '2026-10-02T08:00:00.000Z',
      kind: 'deposit',
      amountUnits: 50 * USD,
      balanceAfterUnits: 62 * USD,
      deposit: {
        method: 'sham_cash',
        referenceCode: 'VD-7K2M9Q',
        syp: { amountUnits: 65_000_000, rate: '13000' },
      },
      adjustment: null,
      order: null,
      checkout: null,
    },
    {
      occurredAt: '2026-10-05T11:20:00.000Z',
      kind: 'purchase',
      amountUnits: -11_200_000,
      balanceAfterUnits: 50_800_000,
      deposit: null,
      adjustment: null,
      order: {
        id: '0199e300-0000-7000-8000-0000000000c1',
        number: 'VO-SHOP23',
        gameNameAr: 'ببجي موبايل',
        productNameAr: '660 UC',
        quantity: 1,
        fields: [{ labelAr: 'معرّف اللاعب (ID)', value: '5123456789' }],
      },
      checkout: null,
    },
    {
      occurredAt: '2026-10-09T15:45:00.000Z',
      kind: 'purchase',
      amountUnits: -11 * USD,
      balanceAfterUnits: 39_800_000,
      deposit: null,
      adjustment: null,
      order: null,
      checkout: {
        id: '0199e300-0000-7000-8000-0000000000d1',
        orders: [
          {
            id: '0199e300-0000-7000-8000-0000000000c2',
            number: 'VO-BULK01',
            gameNameAr: 'فري فاير',
            productNameAr: '520 جوهرة',
            quantity: 2,
            fields: [{ labelAr: 'معرّف اللاعب', value: '9988776655' }],
          },
        ],
      },
    },
  ],
  totals: [
    { kind: 'deposit', count: 1, amountUnits: 50 * USD },
    { kind: 'purchase', count: 2, amountUnits: -22_200_000 },
  ],
  tier: {
    tier: 'silver',
    netPurchasesUsdUnits: 22_200_000,
    savingsUsdUnits: 1_240_000,
    next: { tier: 'gold', missingUsdUnits: 977_800_000 },
  },
  ...changes,
});

test.describe('the price list (F36, PL1–PL3)', () => {
  test('previews the list, warns on purchase prices and downloads the image', async ({
    page,
    api,
  }, testInfo) => {
    signedIn(api).on('GET /api/merchant/price-list', 200, list());
    api.image('GET /api/merchant/price-list.png');
    await page.goto('/merchant/price-list');
    const preview = page.getByTestId('price-list-document');
    await expect(preview.getByText('محل النور للاتصالات')).toBeVisible();
    await expect(preview.getByText('15,000 ل.س')).toBeVisible();
    await expect(page.getByTestId('price-list-omitted')).toBeVisible();
    await screenshot(page, testInfo, 'merchant-price-list');

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: tools.priceList.image }).click();
    expect((await download).suggestedFilename()).toBe('price-list-1.png');

    api.on('GET /api/merchant/price-list', 200, list({ mode: 'purchase', omittedCount: 0 }));
    await page.getByRole('button', { name: tools.priceList.modes.purchase }).click();
    await expect(page.getByText(tools.priceList.purchaseNote)).toBeVisible();
    await expect(page.getByRole('link', { name: tools.priceList.print })).toHaveAttribute(
      'href',
      '/merchant/price-list/print?mode=purchase&currency=syp&unavailable=false',
    );
  });

  test('prints the list on A4 without the site frame', async ({ page, api }, testInfo) => {
    signedIn(api).on('GET /api/merchant/price-list', 200, list({ currency: 'both' }));
    await page.goto(`/merchant/price-list/print?gameIds=${GAME}&mode=selling&currency=both`);
    await expect(page.getByText('$5.72')).toBeVisible();
    await expect(page.locator('header').first()).toBeHidden();
    await expect(page.getByRole('navigation', { name: tools.title })).toHaveCount(0);
    await screenshot(page, testInfo, 'merchant-price-list-print');
  });

  test('shows the price list in the light theme', async ({ page, api }, testInfo) => {
    await page.addInitScript(lightTheme);
    signedIn(api).on('GET /api/merchant/price-list', 200, list({ omittedCount: 0 }));
    await page.goto('/merchant/price-list');
    await expect(page.getByTestId('price-list-document')).toBeVisible();
    await screenshot(page, testInfo, 'merchant-price-list-light');
  });
});

test.describe('the statements (F38, ST1–ST3)', () => {
  test('lists the months and shows a month with its balance and entries', async ({
    page,
    api,
  }, testInfo) => {
    signedIn(api)
      .on('GET /api/merchant/statements', 200, {
        items: [
          { month: MONTH, current: true },
          { month: '2026-09', current: false },
        ],
      })
      .on(`GET /api/merchant/statements/${MONTH}`, 200, statement())
      .on(`GET /api/merchant/statements/${MONTH}/export`, 200, {});
    await page.goto('/merchant/statements');
    await expect(page.getByTestId('statement-months').getByRole('link')).toHaveCount(2);
    await screenshot(page, testInfo, 'merchant-statements');

    await page.getByTestId('statement-months').getByRole('link').first().click();
    const document = page.getByTestId('statement-document');
    await expect(document.getByText(tools.statements.opening)).toBeVisible();
    await expect(document.getByText('5123456789').filter({ visible: true })).toBeVisible();
    await expect(document.getByText('VO-BULK01').filter({ visible: true })).toBeVisible();
    await expect(document.getByText('$39.80').first()).toBeVisible();
    await screenshot(page, testInfo, 'merchant-statement');

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: tools.statements.excel }).click();
    expect((await download).suggestedFilename()).toBe(`statement-${MONTH}.xlsx`);
  });

  test('prints a month on A4, and explains a month outside the account', async ({
    page,
    api,
  }, testInfo) => {
    signedIn(api)
      .on(`GET /api/merchant/statements/${MONTH}`, 200, statement({ current: false }))
      .on('GET /api/merchant/statements/2020-01', 400, {
        statusCode: 400,
        code: 'STATEMENT_MONTH_INVALID',
      });
    await page.goto(`/merchant/statements/${MONTH}/print`);
    await expect(page.getByText(tools.statements.closing)).toBeVisible();
    await expect(page.locator('header').first()).toBeHidden();
    await screenshot(page, testInfo, 'merchant-statement-print');

    await page.goto('/merchant/statements/2020-01');
    await expect(page.getByText(tools.statements.invalid)).toBeVisible();
    // Its print page says the same, with no retry that could never succeed (A06-18).
    await page.goto('/merchant/statements/2020-01/print');
    await expect(page.getByText(tools.statements.invalid)).toBeVisible();
    await expect(page.getByRole('button', { name: tools.common.retry })).toHaveCount(0);
  });

  test('shows a statement in the light theme', async ({ page, api }, testInfo) => {
    await page.addInitScript(lightTheme);
    signedIn(api).on(`GET /api/merchant/statements/${MONTH}`, 200, statement());
    await page.goto(`/merchant/statements/${MONTH}`);
    await expect(page.getByTestId('statement-document')).toBeVisible();
    await screenshot(page, testInfo, 'merchant-statement-light');
  });
});
