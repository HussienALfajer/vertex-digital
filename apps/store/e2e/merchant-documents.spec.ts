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
  return (
    api
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
          { id: GAME, slug: 'pubg-mobile', nameAr: 'ببجي موبايل', ...CATEGORY, recentUnits: 6 },
          { id: GAME_2, slug: 'free-fire', nameAr: 'فري فاير', ...CATEGORY, recentUnits: 0 },
        ],
      })
      // The picker's covers: an index without the games shows their names alone.
      .on('GET /api/catalog/search-index', 200, { games: [], products: [] })
  );
}

const CATEGORY = { categoryId: '0199e300-0000-7000-8000-0000000000e1', categoryNameAr: 'ألعاب' };

/** Text without the bidi isolates that keep amounts whole inside Arabic sentences. */
const plain = (text: string | null) => (text ?? '').replace(/[\u2066-\u2069]/g, '');

const list = (changes: Partial<MerchantPriceList> = {}): MerchantPriceList => ({
  tradeName: 'محل النور للاتصالات',
  logoFileId: null,
  whatsapp: '+963933123456',
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
  sales: {
    salesUsdUnits: 13_100_000,
    costUsdUnits: 11_200_000,
    profitUsdUnits: 1_900_000,
    ordersWithoutSale: 1,
  },
  ...changes,
});

/** A list long enough for several A4 pages: `count` packs of one game. */
const longList = (count: number, changes: Partial<MerchantPriceList> = {}) =>
  list({
    games: [
      {
        gameId: GAME,
        nameAr: 'ببجي موبايل',
        rows: Array.from({ length: count }, (_, index) => ({
          productId: `0199e300-0000-7000-8000-${String(index).padStart(12, '0')}`,
          nameAr: `${index + 1} UC`,
          available: true,
          usdUnits: 1_000_000 + index * 10_000,
          sypUnits: 1_300_000 + index * 13_000,
        })),
      },
    ],
    ...changes,
  });

test.describe('the price list (F36, PL1–PL3)', () => {
  test('previews an A4 page, warns on purchase prices and downloads the image', async ({
    page,
    api,
  }, testInfo) => {
    signedIn(api).on('GET /api/merchant/price-list', 200, list());
    api.image('GET /api/merchant/price-list.png');
    await page.goto('/merchant/price-list');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(tools.nav.priceList);
    const preview = page.getByTestId('price-list-document');
    await expect(preview.getByText('محل النور للاتصالات')).toBeVisible();
    await expect(preview.getByText('15,000 ل.س')).toBeVisible();
    // The footer: the date, "قابلة للتغيير" and the shop's WhatsApp.
    await expect(preview).toContainText(tools.priceList.changeable);
    await expect(preview).toContainText('+963933123456');
    await expect(
      page.getByText(
        `${tools.priceList.pagesLine.replace('{page}', '1').replace('{pages}', '1')} · 3 باقات`,
      ),
    ).toBeVisible();
    await expect(page.getByTestId('price-list-omitted')).toBeVisible();
    // The settings: the games the API chose, shown in the picker's bar.
    await expect(page.getByTestId('price-list-settings')).toContainText('ببجي موبايل');
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

  test('pages a long list, chooses its image, and says the hourly limit plainly', async ({
    page,
    api,
  }, testInfo) => {
    signedIn(api).on('GET /api/merchant/price-list', 200, longList(70, { imagePages: 2 }));
    api.image('GET /api/merchant/price-list.png');
    await page.goto('/merchant/price-list');
    await expect(page.getByText(/صفحة 1 من 3/)).toBeVisible();
    await page.getByRole('button', { name: tools.priceList.next }).click();
    await expect(page.getByText(/صفحة 2 من 3/)).toBeVisible();
    await expect(page.getByTestId('price-list-document')).toContainText('17 UC');
    await screenshot(page, testInfo, 'merchant-price-list-pages');

    // One selector, one download: the second image.
    await page.getByRole('combobox', { name: tools.priceList.whichImage }).click();
    await page
      .getByRole('option', {
        name: tools.priceList.imageOf.replace('{page}', '2').replace('{pages}', '2'),
      })
      .click();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: tools.priceList.image }).click();
    await download;
    expect(api.last('GET /api/merchant/price-list.png')?.search).toContain('page=2');

    api.on('GET /api/merchant/price-list.png', 429, { code: 'RATE_LIMITED' });
    await page.getByRole('button', { name: tools.priceList.image }).click();
    await expect(page.getByText(tools.priceList.imageLimit.replace('{max}', '20'))).toBeVisible();
  });

  test('starts from "ألعابك", and asks for games when none are pinned or sold', async ({
    page,
    api,
  }) => {
    signedIn(api)
      .on('GET /api/merchant/price-list', 200, list({ gameIds: [], games: [], omittedCount: 0 }))
      .on('GET /api/merchant/pinned-games', 200, { gameIds: [GAME_2] });
    await page.goto('/merchant/price-list');
    await expect(page.getByText(tools.priceList.noGames)).toBeVisible();
    // Never the whole catalog: the list was asked without games, the API chose none.
    expect(api.last('GET /api/merchant/price-list')?.search).not.toContain('gameIds');

    api.on('GET /api/merchant/price-list', 200, list({ gameIds: [GAME_2] }));
    await page.getByRole('button', { name: tools.sale.yourGames, exact: true }).click();
    await expect
      .poll(() => api.last('GET /api/merchant/price-list')?.search)
      .toContain(`gameIds=${GAME_2}`);
  });

  test('prints the list on A4 without the site frame, USD before SYP', async ({
    page,
    api,
  }, testInfo) => {
    signedIn(api).on('GET /api/merchant/price-list', 200, list({ currency: 'both' }));
    await page.goto(`/merchant/price-list/print?gameIds=${GAME}&mode=selling&currency=both`);
    const row = page.getByRole('row', { name: /325 UC/ });
    await expect(row).toContainText('$5.72');
    const text = plain(await row.textContent());
    expect(text.indexOf('$5.72')).toBeLessThan(text.indexOf('74,500'));
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
  function months(api: MockApi): MockApi {
    return api.on('GET /api/merchant/statements', 200, {
      items: [
        { month: MONTH, current: true },
        { month: '2026-09', current: false },
      ],
    });
  }

  test('shows this month in a sentence, four figures, sales, the tier and the movements', async ({
    page,
    api,
  }, testInfo) => {
    months(signedIn(api))
      .on(`GET /api/merchant/statements/${MONTH}`, 200, statement())
      .on(`GET /api/merchant/statements/${MONTH}/export`, 200, {});
    await page.goto('/merchant/statements');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(tools.nav.statements);
    await expect(page.getByRole('heading', { name: 'تشرين الأول 2026' })).toBeVisible();
    await expect
      .poll(async () => plain(await page.getByTestId('statement-summary').textContent()))
      .toBe('بدأت الشهر بـ $12.00، أضيف $50.00، ودفعت $22.20، فرصيدك الآن $39.80.');
    const sales = page.getByTestId('statement-sales');
    await expect(sales).toContainText('$13.10');
    await expect(sales).toContainText('$11.20');
    await expect(sales).toContainText('+$1.90');
    await expect(sales).toContainText(tools.statements.screen.sales.estimate);
    await expect(sales).toContainText(tools.statements.screen.sales.without.one);
    await expect
      .poll(async () => plain(await page.getByTestId('statement-tier').textContent()))
      .toContain('الباقي للذهبي $977.80');
    const movements = page.getByTestId('statement-movements');
    await expect(movements.getByText('9 تشرين الأول 2026')).toBeVisible();
    await expect(movements.getByText('إيداع عبر شام كاش')).toBeVisible();
    await expect(movements.getByText('شراء 660 UC')).toBeVisible();
    await expect(movements.getByRole('link', { name: 'الطلب VO-SHOP23' })).toHaveAttribute(
      'href',
      '/orders/0199e300-0000-7000-8000-0000000000c1',
    );
    await screenshot(page, testInfo, 'merchant-statement');

    // Search by a player id, chips by kind.
    await page.getByRole('searchbox', { name: tools.statements.screen.search }).fill('99887');
    await expect(movements.getByText('شراء سلة بطلب واحد')).toBeVisible();
    await expect(movements.getByText('شراء 660 UC')).toHaveCount(0);
    await page.getByRole('searchbox', { name: tools.statements.screen.search }).fill('');
    await page
      .getByRole('button', { name: new RegExp(`^${tools.statements.screen.chips.deposit}`) })
      .click();
    await expect(movements.getByText('إيداع عبر شام كاش')).toBeVisible();
    await expect(movements.getByText('شراء 660 UC')).toHaveCount(0);

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: tools.statements.excel }).click();
    expect((await download).suggestedFilename()).toBe(`statement-${MONTH}.xlsx`);
  });

  test('moves to the month before in place, a past month in its own words', async ({
    page,
    api,
  }) => {
    months(signedIn(api))
      .on(`GET /api/merchant/statements/${MONTH}`, 200, statement())
      .on('GET /api/merchant/statements/2026-09', 200, {
        ...statement({ month: '2026-09', current: false, entries: [], totals: [] }),
        openingUsdUnits: 12 * USD,
        closingUsdUnits: 12 * USD,
      });
    await page.goto('/merchant/statements');
    await page.getByRole('link', { name: tools.statements.screen.monthPrev }).click();
    await expect(page).toHaveURL('/merchant/statements/2026-09');
    await expect(page.getByRole('heading', { name: 'أيلول 2026' })).toBeVisible();
    await expect
      .poll(async () => plain(await page.getByTestId('statement-summary').textContent()))
      .toContain('فبقي $12.00');
    await expect(page.getByText(tools.statements.entriesEmpty)).toBeVisible();
    await expect(
      page.getByRole('button', { name: tools.statements.screen.monthPrev }),
    ).toBeDisabled();
  });

  test('prints a month on A4, and explains a month outside the account', async ({
    page,
    api,
  }, testInfo) => {
    months(signedIn(api))
      .on(`GET /api/merchant/statements/${MONTH}`, 200, statement({ current: false }))
      .on('GET /api/merchant/statements/2020-01', 400, {
        statusCode: 400,
        code: 'STATEMENT_MONTH_INVALID',
      });
    await page.goto(`/merchant/statements/${MONTH}/print`);
    // The official statement, unchanged: every entry with the full player ID.
    const document = page.getByTestId('statement-document');
    await expect(page.getByText(tools.statements.closing)).toBeVisible();
    await expect(document.getByText('5123456789').filter({ visible: true })).toBeVisible();
    await expect(document.getByText('VO-BULK01').filter({ visible: true })).toBeVisible();
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
    months(signedIn(api)).on(`GET /api/merchant/statements/${MONTH}`, 200, statement());
    await page.goto(`/merchant/statements/${MONTH}`);
    await expect(page.getByTestId('statement-movements')).toBeVisible();
    await screenshot(page, testInfo, 'merchant-statement-light');
  });
});
