import type { Page } from '@playwright/test';
import {
  formatUsd,
  type Order,
  type OrderSummary,
  type SavedPlayer,
  type StoreProduct,
} from '@vertex-digital/contracts';
import ar from '../src/messages/ar.json' with { type: 'json' };
import { PUBG, pack, searchIndex } from './catalog';
import { CATALOG_PORT } from './servers';
import shares from './share-fixtures.json' with { type: 'json' };
import { expect, type MockApi, screenshot, test } from './test';

/*
 * S10 in the store: saved player IDs in the buy box (SP1, SP3, SP6, SP7), the gift (GF1, GF3),
 * the cart (CT1–CT6) and its checkout view, one-tap repeat (OT1), the order page's gift and
 * receipt (GF4, RC1–RC3), "معرّفاتي" (SP5), the public gift and receipt pages (GF5, RC2, SH5,
 * SH6), the calculator's "add all" (CT3) and the wallet's checkout entry (W5).
 */

const p = ar.purchase;
const c = ar.cart;
const fill = (text: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce(
    (result, [key, value]) => result.replace(`{${key}}`, `${value}`),
    text,
  );
const lightTheme = () => localStorage.setItem('vertex-theme', 'light');
const ltr = (text: string) => `⁦${text}⁩`;

const USD = 1_000_000;
const ORDER_ID = '0199e000-0000-7000-8000-000000000001';
const GIFT_ORDER_ID = '0199e000-0000-7000-8000-000000000002';
const CHECKOUT_ID = '0199e000-0000-7000-8000-0000000000c1';
const p60 = pack(PUBG, '60 UC');
const p325 = pack(PUBG, '325 UC');
const p660 = pack(PUBG, '660 UC');
const p1800 = pack(PUBG, '1800 UC');

function signedIn(api: MockApi, balanceUnits = 50 * USD): MockApi {
  return api
    .on('GET /api/auth/get-session', 200, {
      user: { name: 'سارة الأحمد', email: 'sara@example.com', emailVerified: true },
      session: { token: 'this-device' },
    })
    .on('GET /api/wallet', 200, { balanceUnits, syp: null });
}

function saved(changes: Partial<SavedPlayer>): SavedPlayer {
  return {
    id: '0199e000-0000-7000-8000-0000000000d1',
    gameId: PUBG.game.id,
    gameSlug: 'pubg-mobile',
    gameNameAr: PUBG.game.nameAr,
    cover: PUBG.game.cover,
    gameShown: true,
    label: 'حسابي',
    fields: { player_id: '51234567' },
    fieldLabels: { player_id: 'معرّف اللاعب (ID)' },
    playerName: 'Lina_99',
    rejected: false,
    complete: true,
    lastUsedAt: new Date(Date.now() - 3_600_000).toISOString(),
    ...changes,
  };
}

const MINE = saved({});
const BROTHER = saved({
  id: '0199e000-0000-7000-8000-0000000000d2',
  label: 'أخي',
  fields: { player_id: '51234568' },
  playerName: null,
  rejected: true,
});
const OLD = saved({
  id: '0199e000-0000-7000-8000-0000000000d3',
  label: 'القديم',
  fields: { player_id: '12' },
  playerName: null,
  complete: false,
});

function order(product: StoreProduct, changes: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    number: 'VO-NEW234',
    stage: 'delivered',
    product: {
      id: product.id,
      nameAr: product.nameAr,
      kind: 'direct',
      regionAr: null,
      redemptionAr: null,
    },
    game: { id: PUBG.game.id, slug: 'pubg-mobile', nameAr: 'ببجي موبايل', cover: null },
    fields: [{ key: 'player_id', labelAr: 'معرّف اللاعب (ID)', value: '51234567' }],
    quantity: 1,
    deliveredQuantity: 1,
    refundedQuantity: 0,
    unitPriceUsdUnits: product.priceUsdUnits as number,
    totalUsdUnits: product.priceUsdUnits as number,
    totalSypUnits: null,
    refundedUsdUnits: 0,
    refundReason: null,
    timeline: [
      { step: 'paid', at: '2026-10-09T10:00:00.000Z' },
      { step: 'delivered', at: '2026-10-09T10:00:12.000Z' },
    ],
    codes: [],
    expiresAt: null,
    cancelReason: null,
    playerName: 'Lina_99',
    deliveryStats: product.deliveryStats,
    checkoutId: null,
    isGift: false,
    gift: null,
    shareLinks: [],
    repeatable: true,
    createdAt: '2026-10-09T10:00:00.000Z',
    ...changes,
  };
}

function summary(product: StoreProduct, changes: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id: ORDER_ID,
    number: 'VO-NEW234',
    stage: 'delivered',
    productNameAr: product.nameAr,
    game: { id: PUBG.game.id, slug: 'pubg-mobile', nameAr: 'ببجي موبايل', cover: null },
    quantity: 1,
    totalUsdUnits: product.priceUsdUnits as number,
    totalSypUnits: null,
    expiresAt: null,
    checkoutId: null,
    isGift: false,
    repeatable: true,
    createdAt: '2026-10-09T10:00:00.000Z',
    ...changes,
  };
}

/** A cart line as the buy box stores it (rule CT1). */
function line(product: StoreProduct, changes: Record<string, unknown> = {}) {
  return {
    id: `line-${product.id}`,
    productId: product.id,
    gameSlug: 'pubg-mobile',
    quantity: 1,
    maxQuantity: product.maxQuantity,
    fields: { player_id: '51234567' },
    expectedUnitPriceUsdUnits: product.priceUsdUnits ?? 1_000_000,
    confirmPlayer: false,
    playerCheck: { result: 'valid', playerName: 'Lina_99' },
    display: {
      gameNameAr: PUBG.game.nameAr,
      productNameAr: product.nameAr,
      cover: PUBG.game.cover,
      fields: [{ key: 'player_id', labelAr: 'معرّف اللاعب (ID)', value: '51234567' }],
    },
    ...changes,
  };
}

/** Seeds the cart once per test: a later navigation keeps what the page changed. */
async function seedCart(page: Page, lines: unknown[]) {
  await page.addInitScript((value) => {
    if (sessionStorage.getItem('vd:e2e-seeded')) return;
    sessionStorage.setItem('vd:e2e-seeded', '1');
    localStorage.setItem('vd-cart', JSON.stringify({ v: 1, lines: value }));
  }, lines);
}

const cartCount = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('vd-cart') ?? '{"lines":[]}').lines.length);

const buyBox = (page: Page) =>
  page.getByRole('dialog').or(page.getByRole('complementary', { name: ar.game.buyBox }));

const idField = (page: Page) => buyBox(page).getByLabel('معرّف اللاعب (ID)');

test.describe('saved player IDs in the buy box (SP1, SP3, SP6, SP7)', () => {
  test('a saved ID opens the slide step at once with its label and last name (step 2)', async ({
    page,
    api,
  }) => {
    signedIn(api)
      .on('GET /api/saved-players', 200, { items: [MINE, BROTHER, OLD] })
      .on('POST /api/orders', 201, order(p325))
      .on(`GET /api/orders/${ORDER_ID}`, 200, order(p325));
    await page.goto(`/games/pubg-mobile?pack=${p325.id}`);
    await buyBox(page)
      .getByRole('button', { name: /^حسابي/ })
      .click();
    await expect(buyBox(page).getByRole('slider', { name: p.slidePay })).toBeVisible();
    await expect(buyBox(page).getByText(p.saved.lastName)).toBeVisible();
    await expect(buyBox(page).getByText('Lina_99')).toBeVisible();
    await buyBox(page).getByRole('slider').focus();
    await page.keyboard.press('End');
    await expect(page).toHaveURL(`/orders/${ORDER_ID}`);
    expect(api.last('POST /api/orders')?.body).toEqual({
      productId: p325.id,
      quantity: 1,
      fields: { player_id: '51234567' },
      expectedUnitPriceUsdUnits: p325.priceUsdUnits,
      whenBalanceShort: 'refuse',
      confirmPlayer: true,
    });
    // A saved ID needs no new check.
    expect(api.requests.some((request) => request.key === 'POST /api/player-checks')).toBe(false);
  });

  test('a rejected ID warns and goes through the check; an incomplete one shows what is missing', async ({
    page,
    api,
  }) => {
    signedIn(api)
      .on('GET /api/saved-players', 200, { items: [MINE, BROTHER, OLD] })
      .on('POST /api/player-checks', 200, { result: 'invalid' });
    await page.goto(`/games/pubg-mobile?pack=${p60.id}`);
    await buyBox(page).getByRole('button', { name: /أخي/ }).click();
    await expect(buyBox(page).getByText(p.saved.rejected)).toBeVisible();
    await expect(idField(page)).toHaveValue('51234568');
    await expect(buyBox(page).getByText(p.playerInvalid)).toBeVisible();
    await expect(buyBox(page).getByRole('slider')).toBeHidden();
    await buyBox(page)
      .getByRole('button', { name: /^القديم/ })
      .click();
    await expect(buyBox(page).getByText(p.saved.incomplete)).toBeVisible();
    await expect(
      buyBox(page).getByText(fill(p.fieldErrors.digits, { min: 5, max: 12 })),
    ).toBeVisible();
    await buyBox(page).getByRole('button', { name: p.saved.new }).click();
    await expect(idField(page)).toHaveValue('');
  });

  test('saves a new ID and sends a gift; a message with a phone number is refused (steps 1, 4)', async ({
    page,
    api,
  }) => {
    signedIn(api)
      .on('GET /api/saved-players', 200, { items: [MINE] })
      .on('POST /api/player-checks', 200, { result: 'valid', playerName: 'Omar_7' })
      .on('POST /api/orders', 201, order(p325))
      .on(`GET /api/orders/${ORDER_ID}`, 200, order(p325));
    await page.goto(`/games/pubg-mobile?pack=${p325.id}`);
    await idField(page).fill('51234568');
    await expect(buyBox(page).getByText('Omar_7')).toBeVisible();
    await buyBox(page).getByText(p.save.toggle, { exact: true }).click();
    await buyBox(page).getByLabel(p.save.label).fill('أخي');
    await buyBox(page).getByText(p.gift.toggle, { exact: true }).click();
    await buyBox(page).getByLabel(p.gift.sender).fill('أحمد');
    await buyBox(page).getByLabel(p.gift.message).fill('تواصل معي 0933123456');
    await buyBox(page).getByRole('button', { name: p.continue }).click();
    await expect(buyBox(page).getByText(p.gift.refused)).toBeVisible();
    await expect(buyBox(page).getByRole('slider')).toBeHidden();
    await buyBox(page).getByLabel(p.gift.message).fill('كل عام وأنت بخير');
    await buyBox(page).getByRole('button', { name: p.continue }).click();
    await expect(buyBox(page).getByText(fill(p.gift.from, { name: 'أحمد' }))).toBeVisible();
    await buyBox(page).getByRole('slider').focus();
    await page.keyboard.press('End');
    await expect(page).toHaveURL(`/orders/${ORDER_ID}`);
    expect(api.last('POST /api/orders')?.body).toMatchObject({
      fields: { player_id: '51234568' },
      savePlayer: { label: 'أخي' },
      gift: { senderName: 'أحمد', message: 'كل عام وأنت بخير' },
    });
  });

  test('"اشترِ مجدداً" opens the slide step with the order’s ID at today’s price (step 3)', async ({
    page,
    api,
  }) => {
    signedIn(api)
      .on(`GET /api/orders/${ORDER_ID}`, 200, order(p60))
      .on('POST /api/orders', 201, order(p60));
    await page.goto(`/orders/${ORDER_ID}`);
    await page.getByRole('link', { name: ar.orders.repeat }).click();
    await expect(page).toHaveURL(new RegExp(`pack=${p60.id}&repeat=${ORDER_ID}`));
    await expect(buyBox(page).getByRole('slider', { name: p.slidePay })).toBeVisible();
    await expect(buyBox(page).getByText('51234567')).toBeVisible();
    await buyBox(page).getByRole('slider').focus();
    await page.keyboard.press('End');
    await expect(page).toHaveURL(`/orders/${ORDER_ID}`);
    expect(api.last('POST /api/orders')?.body).toMatchObject({
      productId: p60.id,
      expectedUnitPriceUsdUnits: p60.priceUsdUnits,
      confirmPlayer: true,
    });
  });
});

test('a repeat link for an order that was not delivered is typed again (OT1, OT3)', async ({
  page,
  api,
}) => {
  const refused = order(p60, {
    stage: 'refunded',
    refundReason: 'input_rejected',
    deliveredQuantity: 0,
    repeatable: false,
  });
  signedIn(api)
    .on(`GET /api/orders/${ORDER_ID}`, 200, refused)
    .on('POST /api/player-checks', 200, { result: 'invalid' });
  await page.goto(`/games/pubg-mobile?pack=${p60.id}&repeat=${ORDER_ID}`);
  await expect(buyBox(page).getByText(p.repeat.failed)).toBeVisible();
  await expect(buyBox(page).getByRole('slider')).toBeHidden();
  await expect(idField(page)).toHaveValue('');
});

test.describe('the cart (CT1–CT6)', () => {
  test('adds lines signed out and counts them in the header; a full cart refuses (step 10)', async ({
    page,
    api: _api,
  }) => {
    await page.goto(`/games/pubg-mobile?pack=${p60.id}`);
    await idField(page).fill('51234567');
    await buyBox(page).getByRole('button', { name: p.cart.add }).click();
    await expect(buyBox(page).getByText(p.cart.added)).toBeVisible();
    // On phones the buy box is a modal sheet: the header behind it is out of the a11y tree.
    await expect(page.locator('header a[href="/cart"]')).toHaveAttribute(
      'aria-label',
      fill(ar.header.cartCount, { count: 1 }),
    );
    expect(await cartCount(page)).toBe(1);
    await page.evaluate(
      (lines) => localStorage.setItem('vd-cart', JSON.stringify({ v: 1, lines })),
      Array.from({ length: 10 }, (_, index) =>
        line(p60, { id: `l${index}`, fields: { player_id: `5123456${index}` } }),
      ),
    );
    await buyBox(page).getByRole('button', { name: p.cart.add }).click();
    await expect(buyBox(page).getByText(p.cart.full)).toBeVisible();
    expect(await cartCount(page)).toBe(10);
  });

  test('moves a changed price, removes an unavailable line, pays in one slide (step 5)', async ({
    page,
    api,
  }) => {
    await seedCart(page, [
      line(p60, { expectedUnitPriceUsdUnits: 900_000 }),
      line(p325, {
        gift: { senderName: 'أحمد', message: 'كل عام وأنت بخير' },
        fields: { player_id: '51234568' },
      }),
      line(p1800, { expectedUnitPriceUsdUnits: 19_990_000 }),
    ]);
    const orders = [
      summary(p60, { checkoutId: CHECKOUT_ID, stage: 'processing', repeatable: false }),
      summary(p325, {
        id: GIFT_ORDER_ID,
        number: 'VO-GIFT23',
        checkoutId: CHECKOUT_ID,
        isGift: true,
        stage: 'processing',
        repeatable: false,
      }),
    ];
    const total = (p60.priceUsdUnits as number) + (p325.priceUsdUnits as number);
    signedIn(api)
      .on('GET /api/catalog/search-index', 200, searchIndex())
      .on('POST /api/checkouts', 201, {
        id: CHECKOUT_ID,
        totalUsdUnits: total,
        totalSypUnits: null,
        orders,
      })
      .on('GET /api/orders', 200, {
        items: orders,
        nextCursor: null,
        checkout: { id: CHECKOUT_ID, totalUsdUnits: total, orderCount: 2, finishedAt: null },
      });
    await page.goto('/cart');
    await expect(page.locator('del').getByText(formatUsd(900_000))).toBeVisible();
    await expect(page.getByText(c.unavailable)).toBeVisible();
    await expect(page.getByText(c.removeUnavailable)).toBeVisible();
    await expect(page.getByText(c.gift, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: fill(c.remove, { name: '1800 UC' }) }).click();
    const slider = page.getByRole('slider', {
      name: fill(c.slide, { total: ltr(formatUsd(total)) }),
    });
    await expect(slider).toBeVisible();
    await slider.focus();
    await page.keyboard.press('End');
    await expect(page).toHaveURL(`/orders?checkout=${CHECKOUT_ID}`);
    await expect(page.getByText(fill(ar.orders.checkout.title, { count: 2 }))).toBeVisible();
    await expect(page.getByText(ar.orders.gift.badge)).toBeVisible();
    const sent = api.last('POST /api/checkouts');
    expect(sent?.body).toEqual({
      lines: [
        {
          productId: p60.id,
          quantity: 1,
          fields: { player_id: '51234567' },
          expectedUnitPriceUsdUnits: p60.priceUsdUnits,
          confirmPlayer: false,
        },
        {
          productId: p325.id,
          quantity: 1,
          fields: { player_id: '51234568' },
          expectedUnitPriceUsdUnits: p325.priceUsdUnits,
          confirmPlayer: false,
          gift: { senderName: 'أحمد', message: 'كل عام وأنت بخير' },
        },
      ],
    });
    expect(sent?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(await cartCount(page)).toBe(0);
    expect(api.last('GET /api/orders')).toBeTruthy();
  });

  test('a refused cart marks each line; the fixed cart goes with a new key (CT6, edge 1)', async ({
    page,
    api,
  }) => {
    await seedCart(page, [
      line(p60),
      line(p325, { playerCheck: null, fields: { player_id: '51234568' } }),
    ]);
    signedIn(api)
      .on('GET /api/catalog/search-index', 200, searchIndex())
      .on('POST /api/checkouts', 409, {
        code: 'CHECKOUT_REFUSED',
        details: {
          lines: [
            { index: 0, code: 'PRICE_CHANGED', details: { unitPriceUsdUnits: 1_090_000 } },
            { index: 1, code: 'PLAYER_NOT_CONFIRMED', details: {} },
          ],
        },
      });
    await page.goto('/cart');
    await page.getByRole('slider').focus();
    await page.keyboard.press('End');
    await expect(page.getByText(c.refused)).toBeVisible();
    await expect(page.getByText(c.refusals.PRICE_CHANGED)).toBeVisible();
    await expect(page.getByText(c.refusals.PLAYER_NOT_CONFIRMED)).toBeVisible();
    const first = api.last('POST /api/checkouts');
    await page.getByText(p.confirmPlayer, { exact: true }).click();
    api.on('POST /api/checkouts', 402, { code: 'INSUFFICIENT_BALANCE' });
    await page.getByRole('slider').focus();
    await page.keyboard.press('End');
    await expect(page.getByText(ar.errors.INSUFFICIENT_BALANCE)).toBeVisible();
    const second = api.last('POST /api/checkouts');
    expect(second?.body).toMatchObject({
      lines: [{ expectedUnitPriceUsdUnits: 1_090_000 }, { confirmPlayer: true }],
    });
    expect(second?.headers['idempotency-key']).not.toBe(first?.headers['idempotency-key']);
  });

  test('a short balance shows what is missing with the deposit; signed out asks to sign in', async ({
    page,
    api,
  }) => {
    await seedCart(page, [line(p660)]);
    api.on('GET /api/catalog/search-index', 200, searchIndex());
    await page.goto('/cart');
    await expect(page.getByRole('link', { name: c.signIn })).toHaveAttribute(
      'href',
      '/sign-in?next=%2Fcart',
    );
    signedIn(api, 5 * USD);
    await page.reload();
    await expect(
      page.getByText(
        fill(c.shortfall, { balance: ltr('$5.00'), missing: ltr(formatUsd(4_990_000)) }),
      ),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: c.deposit })).toHaveAttribute(
      'href',
      '/wallet/deposit?amount=499',
    );
  });

  test('signing out clears the cart (step 11, edge 17)', async ({ page, api }) => {
    await seedCart(page, [line(p60)]);
    signedIn(api).on('POST /api/auth/sign-out', 200, { success: true });
    await page.goto('/');
    await expect(
      page.getByRole('link', { name: fill(ar.header.cartCount, { count: 1 }) }),
    ).toBeVisible();
    await page.getByRole('button', { name: ar.header.menu }).click();
    api.on('GET /api/auth/get-session', 200, null);
    await page.getByRole('menuitem', { name: ar.header.signOut }).click();
    await expect(page.getByRole('link', { name: ar.header.cart, exact: true })).toBeVisible();
    expect(await cartCount(page)).toBe(0);
  });

  test('the calculator adds every pack, or none past 10 lines (step 10, CT3, edge 22)', async ({
    page,
    api: _api,
  }) => {
    await page.goto('/games/pubg-mobile');
    await page.getByRole('button', { name: ar.calculator.title }).click();
    const target = page.getByLabel(ar.calculator.target);
    await target.fill('20000');
    await page.getByRole('button', { name: ar.calculator.addAll }).click();
    await expect(page.getByText(fill(ar.calculator.tooMany, { max: 10 }))).toBeVisible();
    await target.fill('1045');
    await page.getByRole('button', { name: ar.calculator.addAll }).click();
    await expect(buyBox(page).getByRole('heading', { name: p.bundle.title })).toBeVisible();
    await idField(page).fill('51234567');
    await buyBox(page).getByRole('button', { name: p.cart.addAll }).click();
    await expect(buyBox(page).getByText(p.cart.added)).toBeVisible();
    // 660 + 325 + 60: one line each (the packs sell one at a time).
    expect(await cartCount(page)).toBe(3);
  });
});

test.describe('gift and receipt links (GF4, GF5, RC1–RC3, SH5, SH6)', () => {
  const GIFT_LINK = {
    id: '0199e000-0000-7000-8000-0000000000e1',
    kind: 'gift' as const,
    url: 'http://127.0.0.1:4001/g/G1ftT0kenAAAAAAAAAAAAA',
    showPrice: false,
    playerDisplay: 'masked' as const,
    createdAt: '2026-10-09T10:00:00.000Z',
  };
  const RECEIPT_LINK = {
    ...GIFT_LINK,
    id: '0199e000-0000-7000-8000-0000000000e2',
    kind: 'receipt' as const,
    url: 'http://127.0.0.1:4001/r/R3ceiptT0kenAAAAAAAAAA',
    showPrice: false,
    playerDisplay: 'full' as const,
  };
  const giftOrder = (changes: Partial<Order> = {}) =>
    order(p325, {
      id: GIFT_ORDER_ID,
      number: 'VO-GIFT23',
      isGift: true,
      checkoutId: CHECKOUT_ID,
      gift: { senderName: 'أحمد', message: 'كل عام وأنت بخير' },
      shareLinks: [GIFT_LINK],
      fields: [{ key: 'player_id', labelAr: 'معرّف اللاعب (ID)', value: '51234568' }],
      ...changes,
    });

  test('the gift section shares, then revokes and makes a new link (step 6)', async ({
    page,
    api,
  }) => {
    signedIn(api)
      .on(`GET /api/orders/${GIFT_ORDER_ID}`, 200, giftOrder())
      .on(`POST /api/orders/${GIFT_ORDER_ID}/share-links/${GIFT_LINK.id}/revoke`, 204, null)
      .on(`POST /api/orders/${GIFT_ORDER_ID}/gift-link`, 201, GIFT_LINK)
      .image('GET /api/shares/G1ftT0kenAAAAAAAAAAAAA/image');
    await page.goto(`/orders/${GIFT_ORDER_ID}`);
    await expect(page.getByText(fill(ar.orders.gift.from, { name: 'أحمد' }))).toBeVisible();
    await expect(page.getByText(GIFT_LINK.url)).toBeVisible();
    await expect(page.getByRole('link', { name: ar.orders.checkout.partOf })).toHaveAttribute(
      'href',
      `/orders?checkout=${CHECKOUT_ID}`,
    );
    await expect(page.getByRole('link', { name: ar.orders.share.download })).toHaveAttribute(
      'href',
      '/api/shares/G1ftT0kenAAAAAAAAAAAAA/image?format=square',
    );
    await page.getByRole('button', { name: ar.orders.share.revoke }).click();
    api.on(`GET /api/orders/${GIFT_ORDER_ID}`, 200, giftOrder({ shareLinks: [] }));
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: ar.orders.share.revokeConfirm })
      .click();
    await expect(page.getByText(ar.orders.gift.noLink)).toBeVisible();
    api.on(`GET /api/orders/${GIFT_ORDER_ID}`, 200, giftOrder());
    await page.getByRole('button', { name: ar.orders.share.newLink }).click();
    await expect(page.getByText(GIFT_LINK.url)).toBeVisible();
  });

  test('the receipt sheet previews the choices, then creates the link (step 7)', async ({
    page,
    api,
  }) => {
    signedIn(api)
      .on(`GET /api/orders/${ORDER_ID}`, 200, order(p60))
      .on(`PUT /api/orders/${ORDER_ID}/receipt-link`, 200, RECEIPT_LINK);
    await page.goto(`/orders/${ORDER_ID}`);
    await page.getByRole('button', { name: ar.orders.receipt.open }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet.getByText('••••4567')).toBeVisible();
    await expect(sheet.getByText(ar.share.receipt.total)).toBeVisible();
    await sheet.getByRole('switch').click();
    await sheet.getByRole('button', { name: ar.orders.receipt.displays.full }).click();
    await expect(sheet.getByText('51234567')).toBeVisible();
    await expect(sheet.getByText(ar.share.receipt.total)).toBeHidden();
    api.on(`GET /api/orders/${ORDER_ID}`, 200, order(p60, { shareLinks: [RECEIPT_LINK] }));
    await sheet.getByRole('button', { name: ar.orders.receipt.create }).click();
    await expect(sheet.getByText(RECEIPT_LINK.url)).toBeVisible();
    expect(api.last(`PUT /api/orders/${ORDER_ID}/receipt-link`)?.body).toEqual({
      showPrice: false,
      playerDisplay: 'full',
    });
  });

  test('the public pages show only what was chosen, with the visitor’s address passed on', async ({
    page,
    api: _api,
    request,
  }) => {
    await page.setExtraHTTPHeaders({ 'x-forwarded-for': '203.0.113.9' });
    const response = await page.goto('/g/G1ftT0kenAAAAAAAAAAAAA');
    expect(response?.headers()['x-robots-tag']).toBe('noindex, nofollow');
    await expect(page.getByRole('heading', { name: ar.share.gift.title })).toBeVisible();
    await expect(page.getByText(fill(ar.share.gift.from, { name: 'أحمد' }))).toBeVisible();
    await expect(page.getByText('••••4568')).toBeVisible();
    await expect(page.getByText(ar.share.stages.delivered)).toBeVisible();
    await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      'content',
      /\/api\/shares\/G1ftT0kenAAAAAAAAAAAAA\/image\?format=og$/,
    );
    const seen = await request.get(`http://127.0.0.1:${CATALOG_PORT}/_seen`);
    expect(await seen.json()).toEqual({ forwardedFor: '203.0.113.9' });
    expect(shares.G1ftT0kenAAAAAAAAAAAAA.price).toBeNull();

    await page.goto('/r/R3ceiptT0kenAAAAAAAAAA');
    await expect(page.getByRole('heading', { name: ar.share.receipt.title })).toBeVisible();
    await expect(page.getByText('VO-RCPT23')).toBeVisible();
    await expect(
      page.getByText(fill(ar.share.stages.partially_delivered, { delivered: 1, quantity: 2 })),
    ).toBeVisible();
    // A gift token is not a receipt, and an unknown one is not found.
    await page.goto('/r/G1ftT0kenAAAAAAAAAAAAA');
    await expect(page.getByText(ar.share.unavailableTitle)).toBeVisible();
    await page.goto('/g/unknown');
    await expect(page.getByText(ar.share.unavailableTitle)).toBeVisible();
  });
});

test.describe('"معرّفاتي" (SP5)', () => {
  test('lists by game, renames, deletes, and opens the game with the ID chosen', async ({
    page,
    api,
  }) => {
    const renamed = { ...BROTHER, label: 'أخي الصغير' };
    signedIn(api)
      .on('GET /api/saved-players', 200, { items: [MINE, BROTHER] })
      .on(`PATCH /api/saved-players/${BROTHER.id}`, 200, renamed)
      .on(`DELETE /api/saved-players/${BROTHER.id}`, 204, null);
    await page.goto('/account/players');
    await expect(page.getByRole('heading', { name: PUBG.game.nameAr })).toBeVisible();
    await expect(page.getByText('••••4567 · Lina_99')).toBeVisible();
    await expect(page.getByRole('link', { name: ar.players.topUp }).first()).toHaveAttribute(
      'href',
      `/games/pubg-mobile?player=${MINE.id}`,
    );
    await page.getByRole('button', { name: ar.players.rename }).nth(1).click();
    await page.getByLabel(ar.players.label).fill('أخي الصغير');
    api.on('GET /api/saved-players', 200, { items: [MINE, renamed] });
    await page.getByRole('button', { name: ar.players.save }).click();
    await expect(page.getByText('أخي الصغير')).toBeVisible();
    expect(api.last(`PATCH /api/saved-players/${BROTHER.id}`)?.body).toEqual({
      label: 'أخي الصغير',
    });
    await page.getByRole('button', { name: ar.players.delete }).nth(1).click();
    api.on('GET /api/saved-players', 200, { items: [MINE] });
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: ar.players.deleteConfirm })
      .click();
    await expect(page.getByText('أخي الصغير')).toBeHidden();

    await page.getByRole('link', { name: ar.players.topUp }).click();
    await page.getByRole('button', { name: /^60 UC/ }).click();
    await expect(idField(page)).toHaveValue('51234567');
    await expect(buyBox(page).getByRole('button', { name: /^حسابي/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

// RTL screenshots of every new screen in both themes, at phone width and desktop.
for (const theme of ['dark', 'light'] as const) {
  test(`S10 screenshots, ${theme} theme`, async ({ page, api }, testInfo) => {
    if (theme === 'light') await page.addInitScript(lightTheme);
    const total = (p60.priceUsdUnits as number) + (p325.priceUsdUnits as number);
    const checkoutOrders = [
      summary(p60, { checkoutId: CHECKOUT_ID, stage: 'delivered' }),
      summary(p325, {
        id: GIFT_ORDER_ID,
        number: 'VO-GIFT23',
        checkoutId: CHECKOUT_ID,
        isGift: true,
        stage: 'processing',
        repeatable: false,
      }),
    ];
    signedIn(api)
      .on('GET /api/saved-players', 200, { items: [MINE, BROTHER, OLD] })
      .on('POST /api/player-checks', 200, { result: 'valid', playerName: 'Omar_7' })
      .on('GET /api/catalog/search-index', 200, searchIndex())
      .on('GET /api/orders', 200, {
        items: checkoutOrders,
        nextCursor: null,
        checkout: { id: CHECKOUT_ID, totalUsdUnits: total, orderCount: 2, finishedAt: null },
      })
      .on(`GET /api/orders/${GIFT_ORDER_ID}`, 200, {
        ...order(p325, {
          id: GIFT_ORDER_ID,
          number: 'VO-GIFT23',
          stage: 'processing',
          repeatable: false,
          isGift: true,
          checkoutId: CHECKOUT_ID,
          gift: { senderName: 'أحمد', message: 'كل عام وأنت بخير' },
          timeline: [{ step: 'paid', at: '2026-10-09T10:00:00.000Z' }],
        }),
        shareLinks: [
          {
            id: '0199e000-0000-7000-8000-0000000000e1',
            kind: 'gift',
            url: 'http://127.0.0.1:4001/g/G1ftT0kenAAAAAAAAAAAAA',
            showPrice: false,
            playerDisplay: 'masked',
            createdAt: '2026-10-09T10:00:00.000Z',
          },
        ],
      })
      .on(`GET /api/orders/${ORDER_ID}`, 200, order(p60))
      .image('GET /api/shares/G1ftT0kenAAAAAAAAAAAAA/image')
      .on('GET /api/wallet/entries', 200, {
        items: [
          {
            occurredAt: '2026-10-09T10:00:00.000Z',
            kind: 'purchase',
            amountUnits: -total,
            balanceAfterUnits: 50 * USD - total,
            adjustment: null,
            deposit: null,
            order: null,
            checkout: {
              id: CHECKOUT_ID,
              orderCount: 2,
              orders: [
                { id: ORDER_ID, number: 'VO-NEW234', productNameAr: '60 UC' },
                { id: GIFT_ORDER_ID, number: 'VO-GIFT23', productNameAr: '325 UC' },
              ],
            },
          },
        ],
        nextCursor: null,
      });

    await page.goto(`/games/pubg-mobile?pack=${p325.id}`);
    await expect(buyBox(page).getByRole('button', { name: /^حسابي/ })).toBeVisible();
    // An ID not saved yet: the save box shows (rule SP1).
    await idField(page).fill('51234569');
    await expect(buyBox(page).getByText('Omar_7')).toBeVisible();
    await buyBox(page).getByText(p.save.toggle, { exact: true }).click();
    await buyBox(page).getByText(p.gift.toggle, { exact: true }).click();
    await buyBox(page).getByLabel(p.gift.sender).fill('أحمد');
    await buyBox(page).getByLabel(p.gift.message).fill('تواصل معي 0933123456');
    await buyBox(page).getByRole('button', { name: p.continue }).click();
    await expect(buyBox(page).getByText(p.gift.refused)).toBeVisible();
    await screenshot(page, testInfo, `s10-buy-box-${theme}`);

    await page.goto(`/games/pubg-mobile?pack=${p60.id}`);
    await buyBox(page).getByRole('button', { name: /أخي/ }).click();
    await expect(buyBox(page).getByText(p.saved.rejected)).toBeVisible();
    await screenshot(page, testInfo, `s10-buy-box-rejected-${theme}`);
    await buyBox(page)
      .getByRole('button', { name: /^حسابي/ })
      .click();
    await expect(buyBox(page).getByRole('slider')).toBeVisible();
    await screenshot(page, testInfo, `s10-buy-box-one-tap-${theme}`);

    await page.evaluate(
      (lines) => localStorage.setItem('vd-cart', JSON.stringify({ v: 1, lines })),
      [
        line(p60, { expectedUnitPriceUsdUnits: 900_000 }),
        line(p325, {
          gift: { senderName: 'أحمد', message: 'كل عام وأنت بخير' },
          fields: { player_id: '51234568' },
          display: {
            ...line(p325).display,
            fields: [{ key: 'player_id', labelAr: 'معرّف اللاعب (ID)', value: '51234568' }],
          },
          playerCheck: null,
          confirmPlayer: true,
        }),
        line(p1800, { expectedUnitPriceUsdUnits: 19_990_000 }),
      ],
    );
    await page.goto('/cart');
    await expect(page.getByText(c.unavailable)).toBeVisible();
    await screenshot(page, testInfo, `s10-cart-${theme}`);
    await page.evaluate(() => localStorage.removeItem('vd-cart'));
    await page.goto('/cart');
    await expect(page.getByText(c.emptyTitle)).toBeVisible();
    await screenshot(page, testInfo, `s10-cart-empty-${theme}`);

    await page.goto(`/orders?checkout=${CHECKOUT_ID}`);
    await expect(page.getByText(fill(ar.orders.checkout.title, { count: 2 }))).toBeVisible();
    await screenshot(page, testInfo, `s10-checkout-orders-${theme}`);

    await page.goto(`/orders/${GIFT_ORDER_ID}`);
    await expect(page.getByText(ar.orders.gift.linkHint)).toBeVisible();
    await screenshot(page, testInfo, `s10-order-gift-${theme}`);
    await page.goto(`/orders/${ORDER_ID}`);
    await page.getByRole('button', { name: ar.orders.receipt.open }).click();
    await expect(page.getByRole('dialog').getByText(ar.orders.receipt.preview)).toBeVisible();
    await screenshot(page, testInfo, `s10-receipt-sheet-${theme}`);
    await page.keyboard.press('Escape');

    await page.goto('/account/players');
    await expect(page.getByText('القديم')).toBeVisible();
    await screenshot(page, testInfo, `s10-players-${theme}`);
    api.on('GET /api/saved-players', 200, { items: [] });
    await page.goto('/account/players');
    await expect(page.getByText(ar.players.emptyTitle)).toBeVisible();
    await screenshot(page, testInfo, `s10-players-empty-${theme}`);

    await page.goto('/wallet');
    await page.getByRole('button', { name: ar.wallet.checkoutOrders }).click();
    await expect(page.getByText('VO-GIFT23')).toBeVisible();
    await screenshot(page, testInfo, `s10-wallet-checkout-${theme}`);

    await page.goto('/g/G1ftT0kenAAAAAAAAAAAAA');
    await expect(page.getByRole('heading', { name: ar.share.gift.title })).toBeVisible();
    await screenshot(page, testInfo, `s10-gift-page-${theme}`);
    await page.goto('/r/R3ceiptT0kenAAAAAAAAAA');
    await expect(page.getByText('VO-RCPT23')).toBeVisible();
    await screenshot(page, testInfo, `s10-receipt-page-${theme}`);
    await page.goto('/r/unknownTokenAAAAAAAAAA');
    await expect(page.getByText(ar.share.unavailableTitle)).toBeVisible();
    await screenshot(page, testInfo, `s10-share-missing-${theme}`);
  });
}
