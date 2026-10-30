import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import type {
  BulkCheckResult,
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
import { PUBG } from './catalog';
import { expect, type MockApi, screenshot, test } from './test';

/*
 * S21 PR 2, the counter tools in the store: the point of sale with its keyboard and confirmation
 * (F32), the bulk check and its payment (F33), the order page's merchant tools and the printed
 * receipt and codes (F34, PR1–PR3), the verification page and the branded receipt link (F35), and
 * the receipt settings with the logo (BR3).
 */

const GAME = PUBG.game.id;
const [P60, P325] = PUBG.products as [
  (typeof PUBG.products)[number],
  (typeof PUBG.products)[number],
];
const ORDER_ID = '0199e200-0000-7000-8000-0000000000a1';
const CODE_ORDER_ID = '0199e200-0000-7000-8000-0000000000a2';
const CHECKOUT_ID = '0199e200-0000-7000-8000-0000000000c1';
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

function pos(api: MockApi): MockApi {
  return signedIn(api)
    .on('GET /api/merchant/games', 200, {
      items: [
        { id: GAME, slug: 'pubg-mobile', nameAr: 'ببجي موبايل' },
        { id: PUBG.game.id.replace(/.$/, 'f'), slug: 'free-fire', nameAr: 'فري فاير' },
      ],
    })
    .on('GET /api/merchant/watches', 200, {
      games: [{ gameId: GAME, nameAr: 'ببجي موبايل' }],
      products: [],
      suggestions: { games: [], products: [] },
    })
    .on('GET /api/catalog/games/pubg-mobile', 200, PUBG)
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

test.describe('the point of sale (F32, PS1–PS5)', () => {
  test('fills a recent id, picks a pack by its number and sells it', async ({
    page,
    api,
  }, testInfo) => {
    pos(api)
      .on('POST /api/player-checks', 200, { result: 'valid', playerName: 'Nour', region: null })
      .on('POST /api/orders', 201, { ...order(), stage: 'processing' });
    await page.goto('/merchant/pos');
    await expect(page.getByRole('button', { name: /60 UC/ })).toBeVisible();
    await page.getByRole('button', { name: /5123456789/ }).click();
    await screenshot(page, testInfo, 'merchant-pos');

    await page.keyboard.press('2');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(tools.pos.confirmTitle)).toBeVisible();
    await expect(dialog.getByText(tools.pos.checkedName.replace('{name}', 'Nour'))).toBeVisible();
    await screenshot(page, testInfo, 'merchant-pos-confirm');
    await dialog.getByRole('button', { name: tools.pos.confirm }).click();
    await expect(page.getByText(tools.pos.placed.replace('{number}', 'VO-SHOP23'))).toBeVisible();
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
    await page.goto('/merchant/pos');
    await page.locator('input[name="player_id"]').fill('5123456789');
    await page.reload();
    await expect(page.locator('input[name="player_id"]')).toHaveValue('5123456789');
  });

  test('asks for the id first, and shows the shortcuts (PS3, PS4)', async ({ page, api }) => {
    pos(api);
    await page.goto('/merchant/pos');
    await page.getByRole('button', { name: /60 UC/ }).click();
    await expect(page.getByText(tools.pos.fillPlayer)).toBeVisible();
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog').getByText(tools.pos.keys.print)).toBeVisible();
  });

  /** Fills the recent id, opens 325 UC by its number and confirms in the sheet. */
  async function sell(page: Page) {
    await page.keyboard.press('2');
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(tools.pos.checkedName.replace('{name}', 'Nour'))).toBeVisible();
    await dialog.getByRole('button', { name: tools.pos.confirm }).click();
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
    await page.goto('/merchant/pos');
    await page.getByRole('button', { name: /5123456789/ }).click();
    const dialog = await sell(page);
    await expect(dialog.getByText(ar.errors.UNKNOWN)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    api.on('POST /api/orders', 201, { ...order(), stage: 'processing' });
    await sell(page);
    await expect(page.getByText(tools.pos.placed.replace('{number}', 'VO-SHOP23'))).toBeVisible();
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
    await page.goto('/merchant/pos');
    await page.getByRole('button', { name: /5123456789/ }).click();
    const dialog = await sell(page);
    await expect(dialog.getByText(ar.errors.PRICE_CHANGED)).toBeVisible();
    await expect(dialog.getByText('$5.40')).toBeVisible();

    api.on('POST /api/orders', 201, { ...order(), stage: 'processing' });
    await dialog.getByRole('button', { name: tools.pos.confirm }).click();
    await expect(page.getByText(tools.pos.placed.replace('{number}', 'VO-SHOP23'))).toBeVisible();
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
    await page.goto('/merchant/pos');
    await page.getByRole('button', { name: /5123456789/ }).click();
    const dialog = await sell(page);
    const sheet = page.getByTestId('terms-sheet');
    await expect(sheet).toBeVisible();
    await sheet.getByRole('checkbox', { name: ar.merchant.terms.check }).check();
    await sheet.getByRole('button', { name: ar.merchant.terms.accept }).click();
    await expect(dialog.getByText(tools.pos.termsAccepted)).toBeVisible();
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
    await page.goto('/merchant/pos');
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
    await page.goto('/merchant/pos');
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
    await page.goto('/merchant/pos');
    await page.getByRole('button', { name: /5123456789/ }).click();
    await page.keyboard.press('2');
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: tools.pos.sellingPrice }).fill('16000');
    await dialog.getByRole('button', { name: tools.pos.confirm }).click();
    await expect(
      page.getByText(tools.pos.saleNotSaved.replace('{number}', 'VO-SHOP23')),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: tools.pos.saleSetOnOrder })).toHaveAttribute(
      'href',
      `/orders/${ORDER_ID}`,
    );
  });

  test('a failed read of the last orders offers a retry (A06-8)', async ({ page, api }) => {
    pos(api).on('GET /api/orders', 500, { code: 'INTERNAL_ERROR' });
    await page.goto('/merchant/pos');
    await expect(page.getByText(tools.pos.stripFailed)).toBeVisible();
    api.on('GET /api/orders', 200, { items: [summary()], nextCursor: null, checkout: null });
    await page.getByRole('button', { name: tools.common.retry }).click();
    await expect(page.getByText('VO-SHOP23')).toBeVisible();
  });

  test('orders the game bar followed first, then by the 30-day units (PS1, Q27)', async ({
    page,
    api,
  }) => {
    const id = (last: string) => PUBG.game.id.replace(/.$/, last);
    pos(api).on('GET /api/merchant/games', 200, {
      items: [
        { id: id('a'), slug: 'free-fire', nameAr: 'فري فاير', recentUnits: 0 },
        { id: id('b'), slug: 'yalla-ludo', nameAr: 'يلا لودو', recentUnits: 12 },
        { id: GAME, slug: 'pubg-mobile', nameAr: 'ببجي موبايل', recentUnits: 0 },
      ],
    });
    await page.goto('/merchant/pos');
    const bar = page.getByRole('navigation', { name: tools.pos.games });
    await expect(bar.getByRole('button')).toHaveText(['ببجي موبايل', 'يلا لودو', 'فري فاير']);
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
    await page.goto('/merchant/pos');
    const codes = page.getByRole('link', { name: tools.pos.printCodes });
    await expect(codes).toHaveCount(1);
    await expect(codes).toHaveAttribute(
      'href',
      `/orders/${CODE_ORDER_ID}/print?paper=58&content=codes`,
    );
    await expect(page.getByRole('link', { name: tools.pos.printReceipt })).toHaveCount(2);
  });
});

const checked: BulkCheckResult = {
  lines: [
    {
      line: 2,
      fields: { player_id: '7000000001' },
      product: { id: P60.id, nameAr: '60 UC' },
      quantity: 1,
      unitPriceUsdUnits: 1_050_000,
      totalUsdUnits: 1_050_000,
      check: { result: 'valid', playerName: 'Nour', region: null },
      needsConfirmation: false,
      errors: [],
    },
    {
      line: 3,
      fields: { player_id: '7000000002' },
      product: { id: P325.id, nameAr: '325 UC' },
      quantity: 1,
      unitPriceUsdUnits: 5_200_000,
      totalUsdUnits: 5_200_000,
      check: { result: 'invalid' },
      needsConfirmation: true,
      errors: [],
    },
    {
      line: 4,
      fields: { player_id: '7000000003' },
      product: null,
      quantity: 1,
      unitPriceUsdUnits: null,
      totalUsdUnits: null,
      check: null,
      needsConfirmation: false,
      errors: [{ code: 'pack_unknown', field: null }],
    },
  ],
  totalUsdUnits: 6_250_000,
  balanceUsdUnits: 50_000_000,
};

test.describe('bulk orders (F33, BK1–BK5)', () => {
  test('checks the lines, removes the bad one, confirms an id and pays all', async ({
    page,
    api,
  }, testInfo) => {
    signedIn(api)
      .on('GET /api/merchant/games', 200, {
        items: [{ id: GAME, slug: 'pubg-mobile', nameAr: 'ببجي موبايل' }],
      })
      .on('POST /api/merchant/bulk/check', 200, checked)
      .on('POST /api/checkouts', 201, {
        id: CHECKOUT_ID,
        totalUsdUnits: 6_250_000,
        totalSypUnits: null,
        orders: [summary(), summary({ id: CODE_ORDER_ID })],
      })
      .on('GET /api/orders', 200, {
        items: [summary()],
        nextCursor: null,
        checkout: { id: CHECKOUT_ID, totalUsdUnits: 6_250_000, orderCount: 2, finishedAt: null },
      });
    await page.goto('/merchant/bulk');
    await page
      .getByRole('textbox', { name: tools.bulk.text })
      .fill('7000000001,60\n7000000002,325\n7000000003,999');
    await page.getByRole('button', { name: tools.bulk.check }).click();
    await expect(page.getByText(tools.bulk.errors.pack_unknown)).toBeVisible();
    await expect(page.getByText(tools.bulk.fixFirst)).toBeVisible();
    await screenshot(page, testInfo, 'merchant-bulk-check');
    expect(api.last('POST /api/merchant/bulk/check')?.body).toEqual({
      gameId: GAME,
      text: '7000000001,60\n7000000002,325\n7000000003,999',
    });

    await page
      .locator('li[data-state="invalid"]')
      .getByRole('button', { name: tools.bulk.remove })
      .click();
    await expect(page.getByText(tools.bulk.confirmFirst)).toBeVisible();
    await page.getByRole('checkbox', { name: tools.bulk.confirm }).check();
    await page.getByRole('button', { name: tools.bulk.pay }).click();
    await expect(page).toHaveURL(new RegExp(`/orders\\?checkout=${CHECKOUT_ID}`));
    expect(api.last('POST /api/checkouts')?.body).toEqual({
      source: 'bulk',
      lines: [
        {
          productId: P60.id,
          quantity: 1,
          fields: { player_id: '7000000001' },
          expectedUnitPriceUsdUnits: 1_050_000,
          confirmPlayer: false,
        },
        {
          productId: P325.id,
          quantity: 1,
          fields: { player_id: '7000000002' },
          expectedUnitPriceUsdUnits: 5_200_000,
          confirmPlayer: true,
        },
      ],
    });
  });

  /** The first line of `checked` alone, valid and ready to pay. */
  const payableLines: BulkCheckResult = {
    ...checked,
    lines: checked.lines.slice(0, 1),
    totalUsdUnits: 1_050_000,
  };

  function bulk(api: MockApi, result: BulkCheckResult = payableLines): MockApi {
    return signedIn(api)
      .on('GET /api/merchant/games', 200, {
        items: [{ id: GAME, slug: 'pubg-mobile', nameAr: 'ببجي موبايل' }],
      })
      .on('POST /api/merchant/bulk/check', 200, result);
  }

  async function checkLines(page: Page) {
    await page.getByRole('textbox', { name: tools.bulk.text }).fill('7000000001,60');
    await page.getByRole('button', { name: tools.bulk.check }).click();
  }

  test('a payment whose answer was lost keeps its key after a reload (A06-5)', async ({
    page,
    api,
  }) => {
    bulk(api).on('POST /api/checkouts', 500, { code: 'INTERNAL_ERROR' });
    await page.goto('/merchant/bulk');
    await checkLines(page);
    await page.getByRole('button', { name: tools.bulk.pay }).click();
    await expect(page.getByText(ar.errors.UNKNOWN)).toBeVisible();

    await page.reload();
    await checkLines(page);
    await page.getByRole('button', { name: tools.bulk.pay }).click();
    await expect(page.getByText(ar.errors.UNKNOWN)).toBeVisible();
    const keys = api.requests
      .filter((request) => request.key === 'POST /api/checkouts')
      .map((request) => request.headers['idempotency-key']);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  test('a paid list is not paid again: coming back shows a new, empty form', async ({
    page,
    api,
  }) => {
    bulk(api)
      .on('POST /api/checkouts', 201, {
        id: CHECKOUT_ID,
        totalUsdUnits: 1_050_000,
        totalSypUnits: null,
        orders: [summary()],
      })
      .on('GET /api/orders', 200, {
        items: [summary()],
        nextCursor: null,
        checkout: { id: CHECKOUT_ID, totalUsdUnits: 1_050_000, orderCount: 1, finishedAt: null },
      });
    await page.goto('/merchant/bulk');
    await checkLines(page);
    await page.getByRole('button', { name: tools.bulk.pay }).click();
    await expect(page).toHaveURL(new RegExp(`/orders\\?checkout=${CHECKOUT_ID}`));

    await page.goBack();
    await expect(page).toHaveURL('/merchant/bulk');
    const lines = page.getByRole('textbox', { name: tools.bulk.text });
    await expect(lines).toHaveValue('');
    await expect(page.getByRole('button', { name: tools.bulk.pay })).toHaveCount(0);
    expect(api.requests.filter((request) => request.key === 'POST /api/checkouts')).toHaveLength(1);
  });

  test('pasted lines survive a reload until they are paid', async ({ page, api }) => {
    bulk(api);
    await page.goto('/merchant/bulk');
    const lines = page.getByRole('textbox', { name: tools.bulk.text });
    await lines.fill('7000000001,60');
    await page.reload();
    await expect(lines).toHaveValue('7000000001,60');
  });

  test('pay all names its total and waits for a top-up while the balance is short (A06-10)', async ({
    page,
    api,
  }) => {
    bulk(api, { ...payableLines, balanceUsdUnits: 500_000 });
    await page.goto('/merchant/bulk');
    await checkLines(page);
    // The amount is kept whole in the Arabic sentence by direction marks (`ltr()`).
    await expect(page.getByText(tools.bulk.shortfall.split('{amount}')[0] as string)).toContainText(
      '$0.55',
    );
    const pay = page.getByRole('button', { name: tools.bulk.pay });
    await expect(pay).toContainText('$1.05');
    await expect(pay).toBeDisabled();
  });

  test('each line names its unit price, and the template lists every pack (BK1, Q27)', async ({
    page,
    api,
  }) => {
    bulk(api).on('GET /api/catalog/games/pubg-mobile', 200, PUBG);
    await page.goto('/merchant/bulk');
    await checkLines(page);
    await expect(page.getByText(tools.bulk.unitPrice.split('{amount}')[0] as string)).toContainText(
      '$1.05',
    );
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: tools.bulk.template }).click();
    const file = await (await download).path();
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    // The header, then one example per pack of the game.
    expect(lines).toHaveLength(PUBG.products.length + 1);
  });

  test('a frozen merchant cannot check or pay (A06-4)', async ({ page, api }) => {
    bulk(api).on('GET /api/auth/get-session', 200, {
      user: {
        name: 'سارة الأحمد',
        email: 'sara@example.com',
        emailVerified: true,
        accountType: 'merchant',
        frozenAt: '2026-10-10T08:00:00.000Z',
      },
      session: { token: 'this-device' },
    });
    await page.goto('/merchant/bulk');
    await expect(page.getByText(tools.common.frozen)).toBeVisible();
    await page.getByRole('textbox', { name: tools.bulk.text }).fill('7000000001,60');
    await expect(page.getByRole('button', { name: tools.bulk.check })).toBeDisabled();
  });

  test('while purchases are stopped no check spends the hour’s checks (A09-24)', async ({
    page,
    api,
  }) => {
    bulk(api).on('GET /api/store/status', 200, {
      registrationOpen: true,
      purchasesStopped: true,
      depositsStopped: false,
    });
    await page.goto('/merchant/bulk');
    await expect(page.getByText(ar.purchase.stopped)).toBeVisible();
    await page.getByRole('textbox', { name: tools.bulk.text }).fill('7000000001,60');
    await expect(page.getByRole('button', { name: tools.bulk.check })).toBeDisabled();
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
