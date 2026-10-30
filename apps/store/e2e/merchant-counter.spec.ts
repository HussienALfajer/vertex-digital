import type { Page } from '@playwright/test';
import type {
  Order,
  OrderPrint,
  OrderSummary,
  ReceiptSettings,
  SellingPriceRow,
  SellingPrices,
} from '@vertex-digital/contracts';
import tools from '../src/features/merchant-tools/messages.ar.json' with { type: 'json' };
import orderTexts from '../src/features/orders/messages.ar.json' with { type: 'json' };
import ar from '../src/messages/ar.json' with { type: 'json' };
import { PUBG, searchIndex } from './catalog';
import { expect, type MockApi, screenshot, test } from './test';

/*
 * S21 PR 2, the counter tools in the store: the sale mode with its keyboard and confirmation
 * (F32), the order page's merchant tools and the printed receipt and codes (F34, PR1–PR3), the
 * verification page and the branded receipt link (F35), and the receipt settings with the logo
 * (BR3). Bulk orders (F33) were removed by the owner on 2026-10-30.
 */

const GAME = PUBG.game.id;
const [P60, P325] = PUBG.products as [
  (typeof PUBG.products)[number],
  (typeof PUBG.products)[number],
];
const ORDER_ID = '0199e200-0000-7000-8000-0000000000a1';
/** The category of the merchant games' picker (owner, 2026-10-30). */
const GAMES = { categoryId: '0199e200-0000-7000-8000-0000000000e1', categoryNameAr: 'ألعاب' };
const CODE_ORDER_ID = '0199e200-0000-7000-8000-0000000000a2';
const lightTheme = () => localStorage.setItem('vertex-theme', 'light');

/** Text without the bidi isolates that keep amounts whole inside Arabic sentences. */
const plain = (text: string | null) => (text ?? '').replace(/[\u2066-\u2069]/g, '');

/** Slides the confirmation's handle to its end from the keyboard (`End`), once it can slide. */
async function slide(dialog: ReturnType<Page['getByRole']>) {
  const handle = dialog.getByRole('slider', { name: tools.sale.slide });
  await expect(handle).not.toHaveAttribute('aria-disabled', 'true');
  await handle.press('End');
}

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

const row = (pack: { id: string; nameAr: string }, changes: Partial<SellingPriceRow> = {}) => ({
  productId: pack.id,
  nameAr: pack.nameAr,
  available: true,
  purchaseUsdUnits: 1_050_000,
  ownPrice: null,
  sellingUsdUnits: 1_160_000,
  sellingSypUnits: 1_510_000,
  source: 'markup' as const,
  belowCost: false,
  ...changes,
});

const prices: SellingPrices = {
  settings: { markupBp: 1000, sypStepUnits: 50_000 },
  storeStepUnits: 500,
  products: [
    row(P60),
    row(P325, {
      purchaseUsdUnits: 5_200_000,
      sellingUsdUnits: 5_720_000,
      sellingSypUnits: 7_450_000,
    }),
  ],
};

const summary = (changes: Partial<OrderSummary> = {}): OrderSummary => ({
  id: ORDER_ID,
  number: 'VO-SHOP23',
  stage: 'delivered',
  productNameAr: '60 UC',
  productKind: 'direct',
  game: { id: GAME, slug: 'pubg-mobile', nameAr: 'ببجي موبايل', cover: null },
  quantity: 1,
  totalUsdUnits: 1_050_000,
  totalSypUnits: null,
  placedByStore: null,
  customerNote: null,
  expiresAt: null,
  checkoutId: null,
  isGift: false,
  repeatable: true,
  createdAt: '2026-10-21T09:30:00.000Z',
  ...changes,
});

function order(changes: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    number: 'VO-SHOP23',
    stage: 'delivered',
    placedByStore: null,
    customerNote: null,
    product: { id: P60.id, nameAr: '60 UC', kind: 'direct', regionAr: null, redemptionAr: null },
    game: { id: GAME, slug: 'pubg-mobile', nameAr: 'ببجي موبايل', cover: null },
    fields: [
      { key: 'player_id', labelAr: 'معرّف اللاعب (ID)', value: '5123456789', valueLabelAr: null },
    ],
    quantity: 1,
    deliveredQuantity: 1,
    refundedQuantity: 0,
    unitPriceUsdUnits: 1_050_000,
    totalUsdUnits: 1_050_000,
    totalSypUnits: null,
    refundedUsdUnits: 0,
    refundReason: null,
    timeline: [
      { step: 'paid', at: '2026-10-21T09:30:00.000Z' },
      { step: 'sent', at: '2026-10-21T09:30:01.000Z' },
      { step: 'delivered', at: '2026-10-21T09:30:12.000Z' },
    ],
    codes: [],
    expiresAt: null,
    cancelReason: null,
    playerName: 'Nour',
    playerRegion: null,
    deliveryStats: null,
    expectedWithinMinutes: null,
    checkoutId: null,
    isGift: false,
    gift: null,
    shareLinks: [],
    privatePrice: true,
    repeatable: true,
    verificationCode: 'VrfyShop0123456789abcd',
    sale: {
      currency: 'syp',
      unitAmountUnits: 1_500_000,
      unitUsdUnits: 1_150_000,
      source: 'markup',
    },
    codeReleases: [],
    // S22 OP2: no problem card unless a test sets one.
    help: { status: 'awaiting_balance', paidAt: null, finishedAt: null, openTicketId: null },
    createdAt: '2026-10-21T09:30:00.000Z',
    ...changes,
  };
}

const codeOrder = order({
  id: CODE_ORDER_ID,
  number: 'VO-CODE30',
  product: {
    id: '0199e200-0000-7000-8000-0000000000b9',
    nameAr: 'بطاقة جوجل بلاي $10',
    kind: 'code',
    regionAr: 'تركيا',
    redemptionAr: 'افتح متجر Google Play، ثم «استرداد رمز»، والصق الكود.',
  },
  fields: [],
  quantity: 3,
  deliveredQuantity: 3,
  codes: [1, 2, 3].map((position) => ({
    id: `0199e200-0000-7000-8000-00000000010${position}`,
    position,
    masked: `••••••${position}AB${position}`,
    firstRevealedAt: null,
  })),
  codeReleases: [
    { purpose: 'export', positions: [1, 2, 3], createdAt: '2026-10-21T10:02:00.000Z' },
    { purpose: 'print', positions: [1, 2, 3], createdAt: '2026-10-21T10:01:00.000Z' },
  ],
  sale: null,
});

const print = (changes: Partial<OrderPrint> = {}): OrderPrint => ({
  orderId: ORDER_ID,
  orderNumber: 'VO-SHOP23',
  stage: 'delivered',
  createdAt: '2026-10-21T09:30:00.000Z',
  game: { nameAr: 'ببجي موبايل' },
  product: { nameAr: '60 UC', kind: 'direct', redemptionAr: null },
  quantity: 1,
  deliveredQuantity: 1,
  fields: [{ labelAr: 'معرّف اللاعب (ID)', value: '••••6789' }],
  issuer: { kind: 'merchant', tradeName: 'محل النور للاتصالات', tier: 'silver' },
  whatsapp: '+963933123456',
  logoFileId: null,
  welcomeText: 'أهلاً بكم في محل النور',
  largeLogo: false,
  price: {
    kind: 'selling',
    currency: 'syp',
    unitAmountUnits: 1_500_000,
    totalAmountUnits: 1_500_000,
  },
  verificationCode: 'VrfyShop0123456789abcd',
  ...changes,
});

/** The merchant's own prices of the game: the SYP of the purchase price, at the rate in force. */
const own = {
  priceKind: 'wholesale' as const,
  products: PUBG.products.map((product) => {
    const paid = product.id === P60.id ? 1_050_000 : product.id === P325.id ? 5_200_000 : null;
    return {
      id: product.id,
      available: paid !== null,
      priceUsdUnits: paid,
      priceSypUnits: product.id === P60.id ? 1_370_000 : product.id === P325.id ? 6_770_000 : null,
      savings: null,
      perHundredUsdUnits: null,
      bestValue: false,
      earlyAccess: false,
    };
  }),
  earlyProducts: [],
  rateId: PUBG.rateId,
};

/** The sale mode as the switch leaves it on this browser; once: a test may turn it off. */
function saleModeOn(page: Page) {
  return page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('vd-merchant', '1');
    localStorage.setItem('vd-sale-mode', '1');
  });
}

/** The sale mode on, on the game's page. */
async function openCounter(page: Page) {
  await saleModeOn(page);
  await page.goto('/games/pubg-mobile');
}

function pos(api: MockApi): MockApi {
  return signedIn(api)
    .on('GET /api/merchant/games', 200, {
      items: [
        { id: GAME, slug: 'pubg-mobile', nameAr: 'ببجي موبايل', ...GAMES, recentUnits: 4 },
        {
          id: PUBG.game.id.replace(/.$/, 'f'),
          slug: 'free-fire',
          nameAr: 'فري فاير',
          ...GAMES,
          recentUnits: 0,
        },
      ],
    })
    .on('GET /api/merchant/watches', 200, {
      games: [{ gameId: GAME, nameAr: 'ببجي موبايل' }],
      products: [],
      suggestions: { games: [], products: [] },
    })
    .on('GET /api/catalog/games/pubg-mobile/prices', 200, own)
    .on('GET /api/merchant/selling-prices', 200, prices)
    .on('GET /api/merchant/recent-players', 200, {
      items: [
        {
          fields: { player_id: '5123456789' },
          playerName: 'Nour',
          lastUsedAt: '2026-10-21T09:30:00.000Z',
        },
        {
          fields: { player_id: '5987654321' },
          playerName: null,
          lastUsedAt: '2026-10-20T18:00:00.000Z',
        },
      ],
    })
    .on('GET /api/orders', 200, {
      items: [summary(), summary({ id: CODE_ORDER_ID, number: 'VO-CODE30', stage: 'processing' })],
      nextCursor: null,
      checkout: null,
    });
}

test.describe('the sale mode (F32, PS1–PS6)', () => {
  test('shows each pack in both currencies with its profit, and hides the cost', async ({
    page,
    api,
  }, testInfo) => {
    pos(api).on('POST /api/player-checks', 200, {
      result: 'valid',
      playerName: 'Nour',
      region: null,
    });
    await openCounter(page);
    const tile = page.getByRole('button', { name: /60 UC/ });
    // USD leads, SYP follows after "≈" (owner, 2026-10-30).
    await expect(tile).toContainText(`${tools.sale.selling}$1.16≈ 15,100 ل.س`);
    await expect(tile).toContainText(`${tools.sale.purchase}$1.05≈ 13,700 ل.س`);
    await expect
      .poll(async () => plain(await tile.textContent()))
      .toContain('ربحك +$0.11 ≈ 1,400 ل.س');
    expect((await tile.boundingBox())?.width).toBeGreaterThan(150);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      page.viewportSize()?.width ?? 0,
    );
    await screenshot(page, testInfo, 'merchant-sale-game');

    // One press: the customer sees the selling price alone, here and in the confirmation.
    await page.getByRole('button', { name: tools.sale.hideCost }).click();
    await expect(tile).toContainText('$1.16≈ 15,100 ل.س');
    await expect(tile).not.toContainText(tools.sale.purchase);
    await expect(tile).not.toContainText('ربحك');
    await screenshot(page, testInfo, 'merchant-sale-game-cost-hidden');
    await page.getByRole('button', { name: /5123456789/ }).click();
    await tile.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(tools.sale.sellingPrice)).toBeVisible();
    await expect(dialog.getByText(tools.sale.total)).toHaveCount(0);
    await expect(dialog.getByText('$1.05')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // It stays hidden across a reload, and the shortcut brings it back.
    await page.reload();
    await expect(tile).toContainText('$1.16');
    await expect(tile).not.toContainText('ربحك');
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    await page.keyboard.press('h');
    await expect(tile).toContainText('ربحك');
  });

  test('shows the game page in the light theme', async ({ page, api }, testInfo) => {
    await page.addInitScript(lightTheme);
    pos(api);
    await openCounter(page);
    await expect(page.getByRole('button', { name: /60 UC/ })).toContainText('ربحك');
    await screenshot(page, testInfo, 'merchant-sale-game-light');
  });

  test('warns below cost, and leads with USD whatever the price was set in', async ({
    page,
    api,
  }) => {
    pos(api).on('GET /api/merchant/selling-prices', 200, {
      ...prices,
      products: [
        row(P60, { sellingUsdUnits: 900_000, sellingSypUnits: 1_180_000, belowCost: true }),
        row(P325, {
          purchaseUsdUnits: 5_200_000,
          ownPrice: { currency: 'usd', amountUnits: 6_000_000 },
          sellingUsdUnits: 6_000_000,
          sellingSypUnits: 7_800_000,
          source: 'product',
        }),
      ],
    });
    await openCounter(page);
    const low = page.getByRole('button', { name: /60 UC/ });
    await expect(low).toContainText(tools.prices.belowCost);
    await expect
      .poll(async () => plain(await low.textContent()))
      .toContain('ربحك -$0.15 ≈ -1,900 ل.س');
    const own_ = page.getByRole('button', { name: /325 UC/ });
    await expect(own_).toContainText(`${tools.sale.selling}$6.00≈ 78,000 ل.س`);
    await expect(own_).toContainText(`${tools.sale.purchase}$5.20≈ 67,700 ل.س`);
    await expect
      .poll(async () => plain(await own_.textContent()))
      .toContain('ربحك +$0.80 ≈ 10,300 ل.س');
  });

  test('a customer sees no switch and no counter on the game page', async ({ page, api }) => {
    api.on('GET /api/auth/get-session', 200, {
      user: { name: 'علي', email: 'ali@example.com', emailVerified: true, accountType: 'customer' },
      session: { token: 'this-device' },
    });
    api.on('GET /api/catalog/games/pubg-mobile/prices', 200, { ...own, priceKind: 'retail' });
    // A sale mode left on this browser counts for nobody else.
    await page.addInitScript(() => localStorage.setItem('vd-sale-mode', '1'));
    await page.goto('/games/pubg-mobile');
    await expect(page.getByRole('button', { name: /^60 UC/ })).toBeVisible();
    await expect(page.getByRole('switch', { name: tools.nav.saleMode })).toHaveCount(0);
    await expect(page.getByRole('button', { name: tools.sale.hideCost })).toHaveCount(0);
  });

  test('turns off on the game page and shows it as to a customer, at merchant prices', async ({
    page,
    api,
  }) => {
    pos(api);
    await openCounter(page);
    await expect(page.getByRole('button', { name: tools.sale.hideCost })).toBeVisible();
    await page.getByRole('switch', { name: tools.nav.saleMode }).click();
    await expect(page.getByRole('button', { name: tools.sale.hideCost })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^60 UC/ })).toContainText('$1.05');
    await expect(page.locator('html')).not.toHaveAttribute('data-sale-mode-hint', '');
    await page.reload();
    await expect(page.getByRole('button', { name: /^60 UC/ })).toContainText('$1.05');
    await expect(page.getByRole('switch', { name: tools.nav.saleMode })).not.toBeChecked();
  });

  test('a link for the buy box opens it even with the mode on', async ({ page, api }) => {
    pos(api);
    await saleModeOn(page);
    await page.goto(`/games/pubg-mobile?pack=${P60.id}&via=q`);
    await expect(page.getByRole('button', { name: ar.purchase.cart.add })).toBeVisible();
    await expect(page.getByRole('button', { name: tools.sale.hideCost })).toHaveCount(0);
  });

  test('while the cost is hidden a link for the buy box waits, then opens (PS1b)', async ({
    page,
    api,
  }) => {
    pos(api);
    await saleModeOn(page);
    await page.addInitScript(() => localStorage.setItem('vd-hide-cost', '1'));
    await page.goto(`/games/pubg-mobile?pack=${P60.id}&via=q`);
    await expect(page.getByText(tools.sale.linkNeedsCost)).toBeVisible();
    const tile = page.getByRole('button', { name: /60 UC/ });
    await expect(tile).not.toContainText(tools.sale.purchase);
    await expect(page).toHaveURL(/via=q/);
    await page.getByRole('button', { name: tools.sale.showCost }).click();
    await expect(page.getByRole('button', { name: ar.purchase.cart.add })).toBeVisible();
  });

  test('a changed price shows its total even with the cost hidden (A06-2, PS1b)', async ({
    page,
    api,
  }) => {
    pos(api)
      .on('POST /api/player-checks', 200, { result: 'valid', playerName: 'Nour', region: null })
      .on('POST /api/orders', 409, {
        code: 'PRICE_CHANGED',
        message: 'Price changed',
        details: { unitPriceUsdUnits: 5_400_000 },
      });
    await saleModeOn(page);
    await page.addInitScript(() => localStorage.setItem('vd-hide-cost', '1'));
    await page.goto('/games/pubg-mobile');
    await page.getByRole('button', { name: /5123456789/ }).click();
    await page.keyboard.press('2');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(tools.sale.total)).toHaveCount(0);
    await expect(dialog.getByText(tools.sale.checkedName.replace('{name}', 'Nour'))).toBeVisible();
    await slide(dialog);
    await expect(dialog.getByText('$5.40', { exact: true })).toBeVisible();
  });

  test('a search result for a pack opens its sale, asking for the id first', async ({
    page,
    api,
  }) => {
    pos(api);
    await saleModeOn(page);
    await page.goto(`/games/pubg-mobile?pack=${P60.id}`);
    await expect(page.getByText(tools.sale.fillPlayer)).toBeVisible();
  });

  test('fills a recent id, picks a pack by its number and sells it', async ({
    page,
    api,
  }, testInfo) => {
    pos(api)
      .on('POST /api/player-checks', 200, { result: 'valid', playerName: 'Nour', region: null })
      .on('POST /api/orders', 201, { ...order(), stage: 'processing' });
    await openCounter(page);
    await expect(page.getByRole('button', { name: /60 UC/ })).toBeVisible();
    await page.getByRole('button', { name: /5123456789/ }).click();
    await screenshot(page, testInfo, 'merchant-sale-recent');

    await page.keyboard.press('2');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(tools.sale.confirmTitle)).toBeVisible();
    await expect(dialog.getByText(tools.sale.checkedName.replace('{name}', 'Nour'))).toBeVisible();
    await screenshot(page, testInfo, 'merchant-sale-confirm');
    await slide(dialog);
    await expect(page.getByText(tools.sale.placed.replace('{number}', 'VO-SHOP23'))).toBeVisible();
    const sent = api.last('POST /api/orders');
    expect(sent?.body).toEqual({
      productId: P325.id,
      quantity: 1,
      fields: { player_id: '5123456789' },
      expectedUnitPriceUsdUnits: 5_200_000,
      confirmPlayer: false,
    });
    expect(sent?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    // The selling price was the pack's: no manual sale was written (SP4 wrote it).
    expect(api.last(`PUT /api/orders/${ORDER_ID}/sale`)).toBeUndefined();
    // The next customer's sale never starts with this one's id, typed or restored.
    await expect(page.locator('input[name="player_id"]')).toHaveValue('');
    await page.reload();
    await expect(page.locator('input[name="player_id"]')).toHaveValue('');
  });

  test('a typed player id survives a reload until the sale goes through', async ({ page, api }) => {
    pos(api);
    await openCounter(page);
    await page.locator('input[name="player_id"]').fill('5123456789');
    await page.reload();
    await expect(page.locator('input[name="player_id"]')).toHaveValue('5123456789');
  });

  test('asks for the id first, and shows the shortcuts (PS3, PS4)', async ({ page, api }) => {
    pos(api);
    await openCounter(page);
    await page.getByRole('button', { name: /60 UC/ }).click();
    await expect(page.getByText(tools.sale.fillPlayer)).toBeVisible();
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog').getByText(tools.sale.keys.print)).toBeVisible();
  });

  /** Fills the recent id, opens 325 UC by its number and confirms in the sheet. */
  async function sell(page: Page) {
    await page.keyboard.press('2');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(tools.sale.checkedName.replace('{name}', 'Nour'))).toBeVisible();
    await slide(dialog);
    return dialog;
  }

  const orderKeys = (api: MockApi) =>
    api.requests
      .filter((request) => request.key === 'POST /api/orders')
      .map((request) => request.headers['idempotency-key']);

  test('a sale whose answer was lost keeps its key when the sheet is opened again (A06-1)', async ({
    page,
    api,
  }) => {
    pos(api)
      .on('POST /api/player-checks', 200, { result: 'valid', playerName: 'Nour', region: null })
      .on('POST /api/orders', 500, { code: 'INTERNAL_ERROR' });
    await openCounter(page);
    await page.getByRole('button', { name: /5123456789/ }).click();
    const dialog = await sell(page);
    await expect(dialog.getByText(ar.errors.UNKNOWN)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    api.on('POST /api/orders', 201, { ...order(), stage: 'processing' });
    await sell(page);
    await expect(page.getByText(tools.sale.placed.replace('{number}', 'VO-SHOP23'))).toBeVisible();
    const keys = orderKeys(api);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  test('a changed price shows the new total and is confirmed with it (A06-2)', async ({
    page,
    api,
  }) => {
    pos(api)
      .on('POST /api/player-checks', 200, { result: 'valid', playerName: 'Nour', region: null })
      .on('POST /api/orders', 409, {
        code: 'PRICE_CHANGED',
        message: 'Price changed',
        details: { unitPriceUsdUnits: 5_400_000 },
      });
    await openCounter(page);
    await page.getByRole('button', { name: /5123456789/ }).click();
    const dialog = await sell(page);
    await expect(dialog).toContainText(ar.purchase.priceChanged.split('{price}')[0] as string);
    await expect(dialog.getByText('$5.40', { exact: true })).toBeVisible();

    api.on('POST /api/orders', 201, { ...order(), stage: 'processing' });
    await slide(dialog);
    await expect(page.getByText(tools.sale.placed.replace('{number}', 'VO-SHOP23'))).toBeVisible();
    expect(api.last('POST /api/orders')?.body).toMatchObject({
      expectedUnitPriceUsdUnits: 5_400_000,
    });
  });

  test('a sale refused for the merchant terms opens the terms sheet (A06-3, MT2)', async ({
    page,
    api,
  }) => {
    pos(api)
      .on('POST /api/player-checks', 200, { result: 'valid', playerName: 'Nour', region: null })
      .on('POST /api/orders', 409, { code: 'MERCHANT_TERMS_REQUIRED' })
      .on('GET /api/merchant/application', 200, {
        application: null,
        canApply: false,
        availableAt: null,
        termsVersionId: '0199e200-0000-7000-8000-0000000000f1',
      })
      .on('POST /api/merchant/terms', 204, null);
    await openCounter(page);
    await page.getByRole('button', { name: /5123456789/ }).click();
    const dialog = await sell(page);
    const sheet = page.getByTestId('terms-sheet');
    await expect(sheet).toBeVisible();
    await sheet.getByRole('checkbox', { name: ar.merchant.terms.check }).check();
    await sheet.getByRole('button', { name: ar.merchant.terms.accept }).click();
    await expect(dialog.getByText(tools.sale.termsAccepted)).toBeVisible();
    expect(api.last('POST /api/merchant/terms')?.body).toEqual({
      versionId: '0199e200-0000-7000-8000-0000000000f1',
    });
  });

  test('a frozen merchant sees the notice and no pack opens a sale (A06-4)', async ({
    page,
    api,
  }) => {
    pos(api).on('GET /api/auth/get-session', 200, {
      user: {
        name: 'سارة الأحمد',
        email: 'sara@example.com',
        emailVerified: true,
        accountType: 'merchant',
        frozenAt: '2026-10-10T08:00:00.000Z',
      },
      session: { token: 'this-device' },
    });
    await openCounter(page);
    await expect(page.getByText(tools.common.frozen)).toBeVisible();
    await page.getByRole('button', { name: /5123456789/ }).click();
    await expect(page.getByRole('button', { name: /325 UC/ })).toBeDisabled();
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    await page.keyboard.press('2');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(api.last('POST /api/player-checks')).toBeUndefined();
  });

  test('while purchases are stopped the notice shows and no pack opens a sale (A09-24)', async ({
    page,
    api,
  }) => {
    pos(api).on('GET /api/store/status', 200, {
      registrationOpen: true,
      purchasesStopped: true,
      depositsStopped: false,
    });
    await openCounter(page);
    await expect(page.getByText(ar.purchase.stopped)).toBeVisible();
    await page.getByRole('button', { name: /5123456789/ }).click();
    await expect(page.getByRole('button', { name: /325 UC/ })).toBeDisabled();
  });

  test('a typed price that was not saved is said, with the order to set it on (A06-7)', async ({
    page,
    api,
  }) => {
    pos(api)
      .on('POST /api/player-checks', 200, { result: 'valid', playerName: 'Nour', region: null })
      .on('POST /api/orders', 201, { ...order(), stage: 'processing' })
      .on(`PUT /api/orders/${ORDER_ID}/sale`, 500, { code: 'INTERNAL_ERROR' });
    await openCounter(page);
    await page.getByRole('button', { name: /5123456789/ }).click();
    await page.keyboard.press('2');
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: tools.prices.syp, exact: true }).click();
    await dialog.getByRole('textbox', { name: tools.sale.sellingPrice }).fill('16000');
    await slide(dialog);
    await expect(
      page.getByText(tools.sale.saleNotSaved.replace('{number}', 'VO-SHOP23')),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: tools.sale.saleSetOnOrder })).toHaveAttribute(
      'href',
      `/orders/${ORDER_ID}`,
    );
  });

  test('a failed read of the last orders offers a retry (A06-8)', async ({ page, api }) => {
    pos(api).on('GET /api/orders', 500, { code: 'INTERNAL_ERROR' });
    await openCounter(page);
    await expect(page.getByText(tools.sale.stripFailed)).toBeVisible();
    api.on('GET /api/orders', 200, { items: [summary()], nextCursor: null, checkout: null });
    await page.getByRole('button', { name: tools.common.retry }).click();
    await expect(page.getByText('VO-SHOP23')).toBeVisible();
  });

  test('a delivered code pack prints its codes from the strip (PS5, Q27)', async ({
    page,
    api,
  }) => {
    pos(api).on('GET /api/orders', 200, {
      items: [
        summary(),
        summary({ id: CODE_ORDER_ID, number: 'VO-CODE30', productKind: 'code', quantity: 30 }),
      ],
      nextCursor: null,
      checkout: null,
    });
    await openCounter(page);
    const codes = page.getByRole('link', { name: tools.sale.printCodes });
    await expect(codes).toHaveCount(1);
    await expect(codes).toHaveAttribute(
      'href',
      `/orders/${CODE_ORDER_ID}/print?paper=58&content=codes`,
    );
    await expect(page.getByRole('link', { name: tools.sale.printReceipt })).toHaveCount(2);
  });

  test('the selling price starts in USD and never carries a typed amount to the other currency', async ({
    page,
    api,
  }, testInfo) => {
    pos(api)
      .on('POST /api/player-checks', 200, { result: 'valid', playerName: 'Nour', region: null })
      .on('POST /api/orders', 201, { ...order(), stage: 'processing' });
    await openCounter(page);
    await page.getByRole('button', { name: /5123456789/ }).click();
    await page.getByRole('button', { name: /60 UC/ }).click();
    const dialog = page.getByRole('dialog');
    const field = dialog.getByRole('textbox', { name: tools.sale.sellingPrice });
    // Untouched: the API's ready amount in each currency, USD first.
    await expect(field).toHaveValue('1.16');
    await dialog.getByRole('button', { name: tools.prices.syp, exact: true }).click();
    await expect(field).toHaveValue('15100');
    await screenshot(page, testInfo, 'merchant-sale-confirm-syp');
    // Typed: a currency change clears it, so 730 SYP is never sent as $730.
    await field.fill('730');
    await dialog.getByRole('button', { name: tools.prices.usd, exact: true }).click();
    await expect(field).toHaveValue('');
    await slide(dialog);
    await expect(page.getByText(tools.sale.placed.replace('{number}', 'VO-SHOP23'))).toBeVisible();
    // Cleared, the pack's own price stands: no manual sale is written.
    expect(api.last(`PUT /api/orders/${ORDER_ID}/sale`)).toBeUndefined();
  });

  test('the slide waits for the check, then for an unfound id to be confirmed', async ({
    page,
    api,
  }, testInfo) => {
    pos(api)
      .on('POST /api/player-checks', 200, { result: 'invalid' })
      .on('POST /api/orders', 201, { ...order(), stage: 'processing' });
    await openCounter(page);
    await page.getByRole('button', { name: /5123456789/ }).click();
    await page.getByRole('button', { name: /60 UC/ }).click();
    const dialog = page.getByRole('dialog');
    const handle = dialog.getByRole('slider', { name: tools.sale.slide });
    await expect(dialog.getByText(tools.sale.checkInvalid)).toBeVisible();
    await expect(handle).toHaveAttribute('aria-disabled', 'true');
    await expect(dialog.getByText(tools.sale.slideNeedsPlayer)).toBeVisible();
    await screenshot(page, testInfo, 'merchant-sale-confirm-unfound');
    await handle.press('End');
    expect(api.last('POST /api/orders')).toBeUndefined();
    await dialog.getByRole('checkbox', { name: tools.sale.confirmPlayer }).check();
    await slide(dialog);
    await expect(page.getByText(tools.sale.placed.replace('{number}', 'VO-SHOP23'))).toBeVisible();
    expect(api.last('POST /api/orders')?.body).toMatchObject({ confirmPlayer: true });
  });

  test('unavailable packs go last, and the number keys reach available packs only', async ({
    page,
    api,
  }) => {
    pos(api)
      .on('GET /api/merchant/selling-prices', 200, {
        ...prices,
        products: [
          row(P60, { available: false, purchaseUsdUnits: null }),
          row(P325, { purchaseUsdUnits: 5_200_000, sellingUsdUnits: 5_720_000 }),
        ],
      })
      .on('POST /api/player-checks', 200, { result: 'valid', playerName: 'Nour', region: null });
    await openCounter(page);
    const packs = page.getByTestId('sale-packs').getByRole('button');
    await expect(packs.first()).toContainText('325 UC');
    await expect(packs.last()).toContainText(tools.sale.unavailable);
    await page.getByRole('button', { name: /5123456789/ }).click();
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    await page.keyboard.press('1');
    await expect(page.getByRole('dialog').getByText('325 UC')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press('2');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('the shortcuts sheet names End for the slide', async ({ page, api }) => {
    pos(api);
    await openCounter(page);
    await expect(page.getByRole('button', { name: /60 UC/ })).toBeVisible();
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    await page.keyboard.press('?');
    const help = page.getByRole('dialog');
    await expect(help.getByText('End', { exact: true })).toBeVisible();
    await expect(help.getByText('Enter', { exact: true })).toHaveCount(0);
  });
});

test.describe('the sale mode on a touch screen (owner, 2026-10-30)', () => {
  test.use({ hasTouch: true, isMobile: true });

  test('shows no shortcut numbers where there is no keyboard', async ({ page, api }) => {
    pos(api);
    await openCounter(page);
    await expect(page.getByRole('button', { name: /60 UC/ })).toBeVisible();
    expect(await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches)).toBe(true);
    await expect(page.getByTestId('sale-packs').locator('kbd').first()).toBeHidden();
  });
});

test.describe('the home page for a merchant (PS1, PS7, PS8)', () => {
  function home(api: MockApi): MockApi {
    const id = (last: string) => PUBG.game.id.replace(/.$/, last);
    return pos(api)
      .on('GET /api/merchant/games', 200, {
        items: [
          { id: id('a'), slug: 'free-fire', nameAr: 'فري فاير', recentUnits: 0 },
          { id: id('b'), slug: 'yalla-ludo', nameAr: 'يلا لودو', recentUnits: 12 },
          { id: GAME, slug: 'pubg-mobile', nameAr: 'ببجي موبايل', recentUnits: 0 },
        ],
      })
      .on('GET /api/catalog/search-index', 200, searchIndex());
  }

  for (const scheme of ['dark', 'light'] as const) {
    test(`turns the mode on from the home page, with "ألعابك" first (${scheme})`, async ({
      page,
      api,
    }, testInfo) => {
      if (scheme === 'light') await page.addInitScript(lightTheme);
      home(api);
      await page.goto('/');
      const toggle = page.getByRole('switch', { name: tools.nav.saleMode });
      await expect(toggle).not.toBeChecked();
      await expect(page.getByRole('heading', { name: tools.sale.yourGames })).toHaveCount(0);
      await screenshot(page, testInfo, `merchant-home-${scheme}`);

      await toggle.click();
      const row = page.getByRole('region', { name: tools.sale.yourGames });
      // Nothing pinned: suggestions, followed first, then the 30-day units, each "مقترحة".
      await expect(row.getByRole('link')).toHaveCount(2);
      await expect(row.getByRole('link').first()).toContainText('ببجي موبايل');
      await expect(row.getByRole('link').nth(1)).toContainText('يلا لودو');
      await expect(row.getByText(tools.pins.suggested)).toHaveCount(2);
      // Categories first, then "ألعابك", then the banners and the games (owner, 2026-10-30).
      const categories = page.getByRole('navigation', { name: ar.catalog.browse });
      expect((await categories.boundingBox())?.y ?? 0).toBeLessThan(
        (await row.boundingBox())?.y ?? 0,
      );
      await expect(page.getByRole('heading', { level: 1 })).toBeAttached();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        page.viewportSize()?.width ?? 0,
      );
      await screenshot(page, testInfo, `merchant-home-sale-${scheme}`);

      // It stays on across pages until turned off, and the search still opens with Ctrl+K.
      await row.getByRole('link').first().click();
      await expect(page).toHaveURL('/games/pubg-mobile');
      await expect(page.getByRole('button', { name: tools.sale.hideCost })).toBeVisible();
      await page.keyboard.press('Control+K');
      await expect(page.getByRole('dialog')).toBeVisible();
    });
  }

  test('pins a game with its star, shows it first in its order, and arranges the pinned ones', async ({
    page,
    api,
  }, testInfo) => {
    const id = (last: string) => PUBG.game.id.replace(/.$/, last);
    home(api).on('GET /api/merchant/pinned-games', 200, { gameIds: [id('a')] });
    api.on('PUT /api/merchant/pinned-games', 200, { gameIds: [id('a'), GAME] });
    await saleModeOn(page);
    await page.goto('/');
    const row = page.getByRole('region', { name: tools.sale.yourGames });
    await expect(row.getByRole('link').first()).toContainText('فري فاير');
    await expect(row.getByRole('link')).toHaveCount(3);
    // The pinned game carries no "مقترحة".
    await expect(row.getByText(tools.pins.suggested)).toHaveCount(2);
    await screenshot(page, testInfo, 'merchant-home-your-games');

    // The star on a game's card pins it at the end of the list.
    await row
      .getByRole('button', { name: tools.pins.pin.replace('{name}', 'ببجي موبايل') })
      .click();
    await expect
      .poll(() => api.last('PUT /api/merchant/pinned-games')?.body)
      .toEqual({ gameIds: [id('a'), GAME] });
    await expect(
      row.getByRole('button', { name: tools.pins.unpin.replace('{name}', 'ببجي موبايل') }),
    ).toHaveAttribute('aria-pressed', 'true');

    // "ترتيب": move up and down, each saved at once.
    api.on('PUT /api/merchant/pinned-games', 200, { gameIds: [GAME, id('a')] });
    await page.getByRole('button', { name: tools.pins.arrange }).click();
    const dialog = page.getByRole('dialog');
    await expect(
      dialog.getByText(tools.pins.count.replace('{count}', '2').replace('{max}', '20')),
    ).toBeVisible();
    await screenshot(page, testInfo, 'merchant-home-arrange');
    await dialog
      .getByRole('button', { name: tools.pins.moveUp.replace('{name}', 'ببجي موبايل') })
      .click();
    await expect
      .poll(() => api.last('PUT /api/merchant/pinned-games')?.body)
      .toEqual({ gameIds: [GAME, id('a')] });
    await dialog.getByRole('button', { name: tools.pins.done }).click();
    await expect(row.getByRole('link').first()).toContainText('ببجي موبايل');
  });

  test('a customer sees no star on the cards, and the cached page keeps no room for it', async ({
    page,
    api,
  }) => {
    api.on('GET /api/auth/get-session', 200, {
      user: { name: 'علي', email: 'ali@example.com', emailVerified: true, accountType: 'customer' },
      session: { token: 'this-device' },
    });
    await page.goto('/categories/games');
    await expect(page.getByRole('link', { name: /ببجي موبايل/ }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /ألعابك/ })).toHaveCount(0);
    expect(api.last('GET /api/merchant/pinned-games')).toBeUndefined();
  });

  test('pins a game from its page, kept in place while it loads', async ({ page, api }) => {
    pos(api).on('PUT /api/merchant/pinned-games', 200, { gameIds: [GAME] });
    await page.addInitScript(() => localStorage.setItem('vd-merchant', '1'));
    await page.goto('/games/pubg-mobile');
    const pin = page.getByRole('button', { name: tools.pins.pinShort });
    await pin.click();
    await expect(page.getByRole('button', { name: tools.pins.pinned })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(api.last('PUT /api/merchant/pinned-games')?.body).toEqual({ gameIds: [GAME] });
  });

  test('shows the sidebar on a wide screen and in a sheet on a phone (PS8)', async ({
    page,
    api,
  }, testInfo) => {
    home(api);
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: tools.title });
    if (testInfo.project.name === 'phone') {
      await expect(nav).toBeHidden();
      await page
        .getByRole('button', { name: tools.nav.open.replace('{section}', tools.title) })
        .click();
      await expect(nav).toBeVisible();
      await screenshot(page, testInfo, 'merchant-home-sheet');
      await nav.getByRole('link', { name: tools.nav.saleMode }).click();
      await expect(nav).toBeHidden();
    } else {
      await expect(nav).toBeVisible();
      await expect(page.getByRole('complementary')).toContainText('سارة الأحمد');
      await nav.getByRole('link', { name: tools.nav.saleMode }).click();
      await expect(nav.locator('[aria-current="page"]')).toHaveText(tools.nav.saleMode);
    }
    await expect(page.getByRole('switch', { name: tools.nav.saleMode })).toBeChecked();
    await expect(page).toHaveURL('/');
  });

  test('the old address opens the home page with the mode on (PS7)', async ({ page, api }) => {
    home(api);
    await page.goto('/merchant/pos');
    await expect(page.getByRole('switch', { name: tools.nav.saleMode })).toBeChecked();
    await expect(page).toHaveURL('/');
    // Turned off, it stays off: the address does not hold it on.
    await page.getByRole('switch', { name: tools.nav.saleMode }).click();
    await page.reload();
    await expect(page.getByRole('switch', { name: tools.nav.saleMode })).not.toBeChecked();
  });

  test('the removed bulk page leads to the merchant area (F33, 2026-10-30)', async ({
    page,
    api: _api,
  }) => {
    const answer = await page.request.get('/merchant/bulk', { maxRedirects: 0 });
    expect(answer.status()).toBe(307);
    expect(new URL(answer.headers().location ?? '', 'http://store').pathname).toBe('/merchant');
  });

  test('the old address asks a visitor to sign in and comes back to it (PS7)', async ({
    page,
    api: _api,
  }) => {
    await page.goto('/merchant/pos');
    await expect(page).toHaveURL(`/sign-in?next=${encodeURIComponent('/?sale=1')}`);
  });

  test('a customer and a visitor see the home page as it was, with no room kept', async ({
    page,
    api,
  }) => {
    const width = async () =>
      (
        await page
          .getByRole('heading', { level: 1 })
          .locator('xpath=ancestor::section')
          .boundingBox()
      )?.width;
    await page.goto('/');
    await expect(page.getByRole('complementary')).toHaveCount(0);
    await expect(page.getByRole('switch', { name: tools.nav.saleMode })).toHaveCount(0);
    expect(await width()).toBe(page.viewportSize()?.width);

    api.on('GET /api/auth/get-session', 200, {
      user: { name: 'علي', email: 'ali@example.com', emailVerified: true, accountType: 'customer' },
      session: { token: 'this-device' },
    });
    await page.reload();
    await expect(page.getByRole('switch', { name: tools.nav.saleMode })).toHaveCount(0);
    expect(await width()).toBe(page.viewportSize()?.width);
  });
});

test.describe('the order page, printing and verification (F34, F35)', () => {
  test('shows the selling price, prints and the release log for codes', async ({
    page,
    api,
  }, testInfo) => {
    signedIn(api).on(`GET /api/orders/${CODE_ORDER_ID}`, 200, codeOrder);
    await page.goto(`/orders/${CODE_ORDER_ID}`);
    const tools_ = page.getByTestId('order-tools');
    await expect(tools_.getByText(tools.order.sellingNone)).toBeVisible();
    await expect(tools_.getByRole('button', { name: tools.order.exportCodes })).toBeVisible();
    await expect(
      tools_.getByText(
        tools.order.logLine
          .replace('{purpose}', tools.order.purposes.export)
          .replace('{positions}', '1، 2، 3'),
      ),
    ).toBeVisible();
    await expect(page.getByText(orderTexts.qr.title).first()).toBeVisible();
    await screenshot(page, testInfo, 'merchant-order-tools');

    api.on(`PUT /api/orders/${CODE_ORDER_ID}/sale`, 200, {
      currency: 'usd',
      unitAmountUnits: 12_000_000,
      unitUsdUnits: 12_000_000,
      source: 'manual',
    });
    await tools_.getByRole('button', { name: tools.order.edit }).click();
    await tools_.getByRole('button', { name: tools.prices.usd, exact: true }).click();
    await tools_.getByRole('textbox', { name: tools.order.sellingPrice }).fill('12');
    await tools_.getByRole('button', { name: tools.order.save }).click();
    await expect
      .poll(() => api.last(`PUT /api/orders/${CODE_ORDER_ID}/sale`)?.body)
      .toEqual({
        currency: 'usd',
        amountUnits: 12_000_000,
      });
  });

  test('copies the codes with one logged release, the write started in the tap (audit A06-21)', async ({
    page,
    api,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    signedIn(api)
      .on(`GET /api/orders/${CODE_ORDER_ID}`, 200, codeOrder)
      .on(`POST /api/orders/${CODE_ORDER_ID}/codes/release`, 200, {
        codes: codeOrder.codes.map((code) => ({
          id: code.id,
          position: code.position,
          code: `GPLAY-${code.position}A2B`,
        })),
      });
    await page.goto(`/orders/${CODE_ORDER_ID}`);
    const tools_ = page.getByTestId('order-tools');
    await tools_.getByRole('button', { name: tools.order.copyCodes }).click();
    await expect(tools_.getByRole('status')).toHaveText(tools.order.copied);
    // Windows' clipboard reads its line ends back as CRLF.
    expect(
      (await page.evaluate(() => navigator.clipboard.readText())).replaceAll('\r\n', '\n'),
    ).toBe(codeOrder.codes.map((code) => `GPLAY-${code.position}A2B`).join('\n'));
    expect(api.last(`POST /api/orders/${CODE_ORDER_ID}/codes/release`)?.body).toEqual({
      purpose: 'copy',
    });
  });

  test('a refused copy release shows its reason and copies nothing (audit A06-21)', async ({
    page,
    api,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    signedIn(api)
      .on(`GET /api/orders/${CODE_ORDER_ID}`, 200, codeOrder)
      .on(`POST /api/orders/${CODE_ORDER_ID}/codes/release`, 409, {
        statusCode: 409,
        code: 'CODES_NOT_DELIVERED',
      });
    await page.goto(`/orders/${CODE_ORDER_ID}`);
    const tools_ = page.getByTestId('order-tools');
    await expect(tools_.getByRole('button', { name: tools.order.copyCodes })).toBeVisible();
    await page.evaluate(() => navigator.clipboard.writeText('before'));
    await tools_.getByRole('button', { name: tools.order.copyCodes }).click();
    await expect(tools_.getByText(ar.errors.CODES_NOT_DELIVERED)).toBeVisible();
    await expect(tools_.getByRole('status')).toBeHidden();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('before');
  });

  test('prints the 58 mm receipt with the shop and the QR, never the price paid (PR2, BR1)', async ({
    page,
    api,
  }, testInfo) => {
    signedIn(api).on(`GET /api/orders/${ORDER_ID}/print`, 200, print());
    await page.goto(`/orders/${ORDER_ID}/print?paper=58&content=receipt`);
    await expect(page.getByText('محل النور للاتصالات')).toBeVisible();
    // S23 ID5, RC1: the tier's line and the welcome line under the shop's name.
    await expect(page.getByTestId('tier-line')).toHaveText('تاجر فضي معتمد من Vertex Digital');
    await expect(page.getByTestId('welcome-line')).toHaveText('أهلاً بكم في محل النور');
    await expect(page.getByRole('img', { name: tools.print.verify })).toBeVisible();
    await expect(page.getByText('$1.05')).toBeHidden();
    await expect(page.locator('header').first()).toBeHidden();
    await screenshot(page, testInfo, 'merchant-print-receipt-58');
  });

  test('prints the codes on 80 mm, each print a logged release (PR3, CR1)', async ({
    page,
    api,
  }, testInfo) => {
    signedIn(api)
      .on(
        `GET /api/orders/${CODE_ORDER_ID}/print`,
        200,
        print({
          orderId: CODE_ORDER_ID,
          orderNumber: 'VO-CODE30',
          product: codeOrder.product,
          quantity: 3,
          deliveredQuantity: 3,
          fields: [],
          price: null,
        }),
      )
      .on(`POST /api/orders/${CODE_ORDER_ID}/codes/release`, 200, {
        codes: codeOrder.codes.map((code) => ({
          id: code.id,
          position: code.position,
          code: `GPLAY-${code.position}A2B-${code.position}C3D-EEFF`,
        })),
      });
    await page.goto(`/orders/${CODE_ORDER_ID}/print?paper=80&content=codes`);
    await expect(page.getByText('GPLAY-1A2B-1C3D-EEFF')).toBeVisible();
    expect(api.last(`POST /api/orders/${CODE_ORDER_ID}/codes/release`)?.body).toEqual({
      purpose: 'print',
    });
    await screenshot(page, testInfo, 'merchant-print-codes-80');
  });

  test('codes not delivered yet say so with no retry (audit A04-44)', async ({ page, api }) => {
    signedIn(api)
      .on(`GET /api/orders/${CODE_ORDER_ID}/print`, 200, print({ orderId: CODE_ORDER_ID }))
      .on(`POST /api/orders/${CODE_ORDER_ID}/codes/release`, 409, {
        statusCode: 409,
        code: 'CODES_NOT_DELIVERED',
      });
    await page.goto(`/orders/${CODE_ORDER_ID}/print?paper=80&content=codes`);
    await expect(page.getByText(ar.errors.CODES_NOT_DELIVERED)).toBeVisible();
    await expect(page.getByRole('button', { name: tools.common.retry })).toHaveCount(0);
  });

  test('signing in comes back to the same paper and content (audit A04-32)', async ({
    page,
    api,
  }) => {
    api.on(`GET /api/orders/${ORDER_ID}/print`, 401, { statusCode: 401, code: 'UNAUTHORIZED' });
    await page.goto(`/orders/${ORDER_ID}/print?paper=58&content=codes`);
    await expect(page).toHaveURL(
      `/sign-in?next=${encodeURIComponent(`/orders/${ORDER_ID}/print?paper=58&content=codes`)}`,
    );
  });

  test('prints on A4', async ({ page, api }, testInfo) => {
    signedIn(api).on(`GET /api/orders/${ORDER_ID}/print`, 200, print({ whatsapp: null }));
    await page.goto(`/orders/${ORDER_ID}/print?paper=a4&content=receipt`);
    await expect(page.getByText('محل النور للاتصالات')).toBeVisible();
    await screenshot(page, testInfo, 'merchant-print-receipt-a4');
  });

  test('verifies a merchant’s order with no price, and an unknown code (VF2, VF3)', async ({
    page,
  }, testInfo) => {
    await page.goto('/v/VrfyShop0123456789abcd');
    await expect(page.getByText('محل النور للاتصالات')).toBeVisible();
    await expect(page.getByText(tools.verify.verifiedBy)).toBeVisible();
    await expect(page.getByText(tools.verify.real)).toBeVisible();
    await expect(page.getByText('••••6789')).toBeVisible();
    await screenshot(page, testInfo, 'verification-page');
    // The page streams inside its boundary, so it answers 200 with the not-found view (as the S10
    // share pages do); the API answers 404 and the page is never indexed.
    await page.goto('/v/UnknownCode0123456789a');
    await expect(page.getByText(tools.verify.notFound)).toBeVisible();
  });

  test('shows the verification page in the light theme', async ({ page }, testInfo) => {
    await page.addInitScript(lightTheme);
    await page.goto('/v/VrfyRcpt0123456789abcd');
    await expect(page.getByText(tools.verify.real)).toBeVisible();
    await screenshot(page, testInfo, 'verification-page-light');
  });

  test('shows a branded receipt link with the shop and its selling price (BR1)', async ({
    page,
  }, testInfo) => {
    await page.goto('/r/Br4ndedT0kenAAAAAAAAAA');
    await expect(page.getByText('محل النور للاتصالات')).toBeVisible();
    await expect(page.getByText(tools.share.verifiedBy)).toBeVisible();
    await expect(page.getByRole('img', { name: tools.share.qr })).toBeVisible();
    await screenshot(page, testInfo, 'branded-receipt-link');
  });
});

test.describe('receipt settings (BR3)', () => {
  const saved: ReceiptSettings = {
    tradeName: 'محل النور للاتصالات',
    showWhatsapp: false,
    whatsapp: '+963933123456',
    logoFileId: null,
    welcomeText: null,
    welcomeAllowed: false,
  };

  test('shows the WhatsApp on the preview and saves it', async ({ page, api }, testInfo) => {
    signedIn(api)
      .on('GET /api/merchant/receipt-settings', 200, saved)
      .on('PUT /api/merchant/receipt-settings', 200, { ...saved, showWhatsapp: true });
    await page.goto('/merchant/receipt');
    await page.getByRole('switch', { name: tools.receipt.showWhatsapp }).click();
    await expect(page.getByTestId('receipt-preview').getByText('+963933123456')).toBeVisible();
    await screenshot(page, testInfo, 'merchant-receipt-settings');
    await page.getByRole('button', { name: tools.common.save }).click();
    await expect(page.getByText(tools.receipt.saved)).toBeVisible();
    expect(api.last('PUT /api/merchant/receipt-settings')?.body).toEqual({
      showWhatsapp: true,
      whatsapp: '+963933123456',
      logoFileId: null,
      welcomeText: null,
    });
  });

  test('keeps a typed WhatsApp number when a logo is uploaded (A06-11)', async ({ page, api }) => {
    const logo = '0199e200-0000-7000-8000-0000000000e1';
    signedIn(api)
      .on('GET /api/merchant/receipt-settings', 200, saved)
      .on('POST /api/merchant/logo', 201, { fileId: logo })
      .image(`GET /api/merchant/logo/${logo}`);
    await page.goto('/merchant/receipt');
    const whatsapp = page.getByRole('textbox', { name: tools.receipt.whatsapp });
    await whatsapp.fill('+963944555666');
    await page.locator('input[type="file"]').setInputFiles({
      name: 'logo.png',
      mimeType: 'image/png',
      buffer: Buffer.from('logo'),
    });
    await expect(page.getByRole('button', { name: tools.receipt.logoReplace })).toBeVisible();
    await expect(whatsapp).toHaveValue('+963944555666');
    // The logo joined the settings in place: no read again, no form remounted.
    expect(api.requests.filter((r) => r.key === 'GET /api/merchant/receipt-settings')).toHaveLength(
      1,
    );
  });

  test('shows the receipt settings in the light theme', async ({ page, api }, testInfo) => {
    await page.addInitScript(lightTheme);
    signedIn(api).on('GET /api/merchant/receipt-settings', 200, saved);
    await page.goto('/merchant/receipt');
    await expect(page.getByText(tools.receipt.title)).toBeVisible();
    await screenshot(page, testInfo, 'merchant-receipt-settings-light');
  });
});
