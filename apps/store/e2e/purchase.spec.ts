import type { Page } from '@playwright/test';
import { formatUsd, type Order, type StoreProduct } from '@vertex-digital/contracts';
import ar from '../src/messages/ar.json' with { type: 'json' };
import { PUBG, pack } from './catalog';
import { expect, type MockApi, screenshot, test } from './test';

/*
 * The buy box (S09 rules BB1–BB8, PV1–PV8, RS1): signed out and back after signing in with the
 * id kept, the live player check (valid with the in-game name, invalid with the required
 * confirmation, unavailable), the shortfall with a reservation and the deposit link, the slide
 * confirmation and its submission with one Idempotency-Key per body, and a price change.
 */

const p = ar.purchase;
const fill = (text: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce(
    (result, [key, value]) => result.replace(`{${key}}`, `${value}`),
    text,
  );
const lightTheme = () => localStorage.setItem('vertex-theme', 'light');

const USD = 1_000_000;
const ORDER_ID = '0199e000-0000-7000-8000-000000000001';

function signedIn(api: MockApi, balanceUnits = 50 * USD): MockApi {
  return api
    .on('GET /api/auth/get-session', 200, {
      user: { name: 'سارة الأحمد', email: 'sara@example.com', emailVerified: true },
      session: { token: 'this-device' },
    })
    .on('GET /api/wallet', 200, { balanceUnits, syp: null });
}

function order(product: StoreProduct, changes: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    number: 'VO-NEW234',
    stage: 'processing',
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
    deliveredQuantity: 0,
    refundedQuantity: 0,
    unitPriceUsdUnits: product.priceUsdUnits as number,
    totalUsdUnits: product.priceUsdUnits as number,
    totalSypUnits: product.priceSypUnits,
    refundedUsdUnits: 0,
    refundReason: null,
    timeline: [{ step: 'paid', at: new Date().toISOString() }],
    codes: [],
    expiresAt: null,
    cancelReason: null,
    playerName: 'Lina_99',
    deliveryStats: product.deliveryStats,
    checkoutId: null,
    isGift: false,
    gift: null,
    shareLinks: [],
    repeatable: false,
    createdAt: new Date().toISOString(),
    ...changes,
  };
}

const buyBox = (page: Page) =>
  page.getByRole('dialog').or(page.getByRole('complementary', { name: ar.game.buyBox }));

async function choose(page: Page, name: string) {
  await page.getByRole('button', { name: new RegExp(`^${name}`) }).click();
  await expect(buyBox(page).getByRole('heading', { name })).toBeVisible();
}

const idField = (page: Page) => buyBox(page).getByLabel('معرّف اللاعب (ID)');

const p60 = pack(PUBG, '60 UC');
const p660 = pack(PUBG, '660 UC');

test.describe('buy box', () => {
  test('signed out, the id is kept through the sign-in and back to the same pack (step 3)', async ({
    page,
    api,
  }) => {
    await page.goto('/games/pubg-mobile');
    await choose(page, '60 UC');
    await idField(page).fill('51234567');
    await buyBox(page).getByRole('button', { name: p.signIn }).click();
    await expect(page).toHaveURL(
      `/sign-in?next=${encodeURIComponent(`/games/pubg-mobile?pack=${p60.id}`)}`,
    );
    // Signed in: the sign-in page sends the customer back to `next`.
    signedIn(api);
    await page.goto(`/games/pubg-mobile?pack=${p60.id}`);
    await expect(idField(page)).toHaveValue('51234567');
    expect(page.url()).not.toContain('51234567');
  });

  test('checks the id after a pause, shows the in-game name, then pays with the slider (steps 4, 5)', async ({
    page,
    api,
  }) => {
    signedIn(api)
      .on('POST /api/player-checks', 200, { result: 'valid', playerName: 'Lina_99' })
      .on('POST /api/orders', 201, order(p60))
      .on(`GET /api/orders/${ORDER_ID}`, 200, order(p60));
    await page.goto('/games/pubg-mobile');
    await choose(page, '60 UC');
    // Only valid values are checked, never per keystroke.
    await idField(page).pressSequentially('12');
    await idField(page).fill('51234567');
    await expect(buyBox(page).getByText('Lina_99')).toBeVisible();
    expect(api.requests.filter((r) => r.key === 'POST /api/player-checks')).toHaveLength(1);
    // Signed in, the header's six targets still fit the phone width.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);
    expect(api.last('POST /api/player-checks')?.body).toEqual({
      productId: p60.id,
      fields: { player_id: '51234567' },
    });
    await expect(
      buyBox(page).getByText(fill(p.balanceAfterLine, { balance: `⁦${formatUsd(49_010_000)}⁩` })),
    ).toBeVisible();
    await buyBox(page).getByRole('button', { name: p.continue }).click();
    const slider = buyBox(page).getByRole('slider', { name: p.slidePay });
    await expect(buyBox(page).getByText('51234567')).toBeVisible();
    await slider.focus();
    await page.keyboard.press('End');
    await expect(page).toHaveURL(`/orders/${ORDER_ID}`);
    const sent = api.last('POST /api/orders');
    expect(sent?.body).toEqual({
      productId: p60.id,
      quantity: 1,
      fields: { player_id: '51234567' },
      expectedUnitPriceUsdUnits: p60.priceUsdUnits,
      whenBalanceShort: 'refuse',
      confirmPlayer: false,
    });
    expect(sent?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('an id the supplier cannot find needs the confirmation, then goes with confirmPlayer', async ({
    page,
    api,
  }) => {
    signedIn(api)
      .on('POST /api/player-checks', 200, { result: 'invalid' })
      .on('POST /api/orders', 201, order(p60, { playerName: null }))
      .on(`GET /api/orders/${ORDER_ID}`, 200, order(p60, { playerName: null }));
    await page.goto(`/games/pubg-mobile?pack=${p60.id}`);
    await idField(page).fill('99999');
    await expect(buyBox(page).getByText(p.playerInvalid)).toBeVisible();
    await buyBox(page).getByRole('button', { name: p.continue }).click();
    await expect(buyBox(page).getByText(p.confirmPlayerMissing)).toBeVisible();
    await buyBox(page).getByText(p.confirmPlayer, { exact: true }).click();
    await buyBox(page).getByRole('button', { name: p.continue }).click();
    await buyBox(page).getByRole('slider').focus();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(page).toHaveURL(/\/games\/pubg-mobile/);
    await page.keyboard.press('ArrowLeft');
    await expect(page).toHaveURL(`/orders/${ORDER_ID}`);
    expect(api.last('POST /api/orders')?.body).toMatchObject({ confirmPlayer: true });
  });

  test('a check that cannot run (a limit) asks the customer to confirm the id', async ({
    page,
    api,
  }) => {
    signedIn(api).on('POST /api/player-checks', 429, { code: 'RATE_LIMITED' });
    await page.goto(`/games/pubg-mobile?pack=${p60.id}`);
    await idField(page).fill('51234567');
    await idField(page).blur();
    await expect(buyBox(page).getByText(p.playerUnavailable)).toBeVisible();
    await expect(buyBox(page).getByText(p.confirmPlayer, { exact: true })).toBeVisible();
  });

  test('a short balance offers to reserve, with the deposit prefilled (step 6)', async ({
    page,
    api,
  }) => {
    const reserved = order(p660, {
      stage: 'awaiting_balance',
      timeline: [{ step: 'reserved', at: new Date().toISOString() }],
      expiresAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
    });
    signedIn(api, 5 * USD)
      .on('POST /api/player-checks', 200, { result: 'valid', playerName: null })
      .on('POST /api/orders', 201, reserved)
      .on(`GET /api/orders/${ORDER_ID}`, 200, reserved);
    await page.goto(`/games/pubg-mobile?pack=${p660.id}`);
    await idField(page).fill('51234567');
    await expect(buyBox(page).getByText(p.playerValid)).toBeVisible();
    await expect(
      buyBox(page).getByText(
        fill(p.shortfall, { balance: `⁦$5.00⁩`, missing: `⁦${formatUsd(4_990_000)}⁩` }),
      ),
    ).toBeVisible();
    await expect(buyBox(page).getByRole('link', { name: p.deposit })).toHaveAttribute(
      'href',
      '/wallet/deposit?amount=499',
    );
    await buyBox(page).getByRole('button', { name: p.reserve }).click();
    await expect(buyBox(page).getByText(fill(p.reserveNote, { hours: 24 }))).toBeVisible();
    await buyBox(page).getByRole('slider', { name: p.slideReserve }).focus();
    await page.keyboard.press('End');
    await expect(page).toHaveURL(`/orders/${ORDER_ID}`);
    expect(api.last('POST /api/orders')?.body).toMatchObject({ whenBalanceShort: 'reserve' });
  });

  test('a changed price is shown and needs a new slide, with a new key (edge case 1)', async ({
    page,
    api,
  }) => {
    const newPrice = 1_090_000;
    signedIn(api)
      .on('POST /api/player-checks', 200, { result: 'not_supported' })
      .on('POST /api/orders', 409, {
        code: 'PRICE_CHANGED',
        details: { unitPriceUsdUnits: newPrice },
      });
    await page.goto(`/games/pubg-mobile?pack=${p60.id}`);
    await idField(page).fill('51234567');
    await buyBox(page).getByRole('button', { name: p.continue }).click();
    await buyBox(page).getByRole('slider').focus();
    await page.keyboard.press('End');
    await expect(
      buyBox(page).getByText(fill(p.priceChanged, { price: `⁦${formatUsd(newPrice)}⁩` })),
    ).toBeVisible();
    const first = api.last('POST /api/orders');
    api.on('POST /api/orders', 201, order(p60)).on(`GET /api/orders/${ORDER_ID}`, 200, order(p60));
    await buyBox(page).getByRole('slider').focus();
    await page.keyboard.press('End');
    await expect(page).toHaveURL(`/orders/${ORDER_ID}`);
    const second = api.last('POST /api/orders');
    expect(second?.body).toMatchObject({ expectedUnitPriceUsdUnits: newPrice });
    expect(second?.headers['idempotency-key']).not.toBe(first?.headers['idempotency-key']);
  });

  test('PLAYER_NOT_CONFIRMED brings back the fields with the confirmation (rule BB6)', async ({
    page,
    api,
  }) => {
    signedIn(api)
      .on('POST /api/player-checks', 200, { result: 'not_supported' })
      .on('POST /api/orders', 409, { code: 'PLAYER_NOT_CONFIRMED' });
    await page.goto(`/games/pubg-mobile?pack=${p60.id}`);
    await idField(page).fill('51234567');
    await buyBox(page).getByRole('button', { name: p.continue }).click();
    await buyBox(page).getByRole('slider').focus();
    await page.keyboard.press('End');
    await expect(buyBox(page).getByText(p.playerUnavailable)).toBeVisible();
    const first = api.last('POST /api/orders');
    api.on('POST /api/orders', 201, order(p60)).on(`GET /api/orders/${ORDER_ID}`, 200, order(p60));
    await buyBox(page).getByText(p.confirmPlayer, { exact: true }).click();
    await buyBox(page).getByRole('button', { name: p.continue }).click();
    await buyBox(page).getByRole('slider').focus();
    await page.keyboard.press('End');
    await expect(page).toHaveURL(`/orders/${ORDER_ID}`);
    const second = api.last('POST /api/orders');
    expect(second?.body).toMatchObject({ confirmPlayer: true });
    expect(second?.headers['idempotency-key']).not.toBe(first?.headers['idempotency-key']);
  });

  test('a server error keeps the key: the retry replays the same body and key (rule BB6)', async ({
    page,
    api,
  }) => {
    signedIn(api)
      .on('POST /api/player-checks', 200, { result: 'not_supported' })
      .on('POST /api/orders', 500, { statusCode: 500, code: 'INTERNAL_ERROR' });
    await page.goto(`/games/pubg-mobile?pack=${p60.id}`);
    await idField(page).fill('51234567');
    await buyBox(page).getByRole('button', { name: p.continue }).click();
    await buyBox(page).getByRole('slider').focus();
    await page.keyboard.press('End');
    const retry = buyBox(page).getByRole('button', { name: p.retry });
    await expect(retry).toBeVisible();
    const first = api.last('POST /api/orders');
    // Closing and reopening the box keeps the key too.
    await page.reload();
    await idField(page).fill('51234567');
    await buyBox(page).getByRole('button', { name: p.continue }).click();
    api.on('POST /api/orders', 200, order(p60)).on(`GET /api/orders/${ORDER_ID}`, 200, order(p60));
    await buyBox(page).getByRole('slider').focus();
    await page.keyboard.press('End');
    await expect(page).toHaveURL(`/orders/${ORDER_ID}`);
    const second = api.last('POST /api/orders');
    expect(second?.body).toEqual(first?.body);
    expect(second?.headers['idempotency-key']).toBe(first?.headers['idempotency-key']);
  });

  test('a rate limit after a lost answer keeps the key for the next slide (rule BB6)', async ({
    page,
    api,
  }) => {
    signedIn(api)
      .on('POST /api/player-checks', 200, { result: 'not_supported' })
      .on('POST /api/orders', 500, { statusCode: 500, code: 'INTERNAL_ERROR' });
    await page.goto(`/games/pubg-mobile?pack=${p60.id}`);
    await idField(page).fill('51234567');
    await buyBox(page).getByRole('button', { name: p.continue }).click();
    await buyBox(page).getByRole('slider').focus();
    await page.keyboard.press('End');
    // The lost answer first: switching the mock before the request leaves would answer it 429.
    const retry = buyBox(page).getByRole('button', { name: p.retry });
    await expect(retry).toBeVisible();
    const first = api.last('POST /api/orders');
    api.on('POST /api/orders', 429, { statusCode: 429, code: 'RATE_LIMITED' });
    await retry.click();
    await expect(buyBox(page).getByText(ar.errors.RATE_LIMITED)).toBeVisible();
    api.on('POST /api/orders', 200, order(p60)).on(`GET /api/orders/${ORDER_ID}`, 200, order(p60));
    await buyBox(page).getByRole('slider').focus();
    await page.keyboard.press('End');
    await expect(page).toHaveURL(`/orders/${ORDER_ID}`);
    const keys = api.requests
      .filter((request) => request.key === 'POST /api/orders')
      .map((request) => request.headers['idempotency-key']);
    expect(new Set(keys)).toEqual(new Set([first?.headers['idempotency-key']]));
  });

  test('a slide released before the end springs back and sends nothing', async ({ page, api }) => {
    signedIn(api).on('POST /api/player-checks', 200, { result: 'not_supported' });
    await page.goto(`/games/pubg-mobile?pack=${p60.id}`);
    await idField(page).fill('51234567');
    await buyBox(page).getByRole('button', { name: p.continue }).click();
    const slider = buyBox(page).getByRole('slider');
    const box = await slider.boundingBox();
    if (!box) throw new Error('No slider');
    // RTL: the handle starts at the right edge and travels left.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x - 60, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect(slider).toHaveAttribute('aria-valuenow', '0');
    expect(api.requests.some((r) => r.key === 'POST /api/orders')).toBe(false);
  });
});

// RTL screenshots of the buy box in both themes, at phone width and desktop.
for (const theme of ['dark', 'light'] as const) {
  test(`buy box screenshots, ${theme} theme`, async ({ page, api }, testInfo) => {
    if (theme === 'light') await page.addInitScript(lightTheme);
    await page.goto(`/games/pubg-mobile?pack=${p60.id}`);
    await expect(buyBox(page).getByRole('button', { name: p.signIn })).toBeVisible();
    await screenshot(page, testInfo, `buy-box-signed-out-${theme}`);

    for (const [name, check] of [
      ['valid', { result: 'valid', playerName: 'Lina_99' }],
      ['invalid', { result: 'invalid' }],
      ['unavailable', { result: 'unavailable', reason: 'quota' }],
    ] as const) {
      signedIn(api).on('POST /api/player-checks', 200, check);
      await page.goto(`/games/pubg-mobile?pack=${p60.id}`);
      await idField(page).fill(`5123456${name.length}`);
      await expect(buyBox(page).getByText(p.checking)).toBeHidden();
      await expect(
        buyBox(page).getByText(
          name === 'valid' ? 'Lina_99' : name === 'invalid' ? p.playerInvalid : p.playerUnavailable,
        ),
      ).toBeVisible();
      await screenshot(page, testInfo, `buy-box-${name}-${theme}`);
    }

    signedIn(api, 5 * USD).on('POST /api/player-checks', 200, {
      result: 'valid',
      playerName: null,
    });
    await page.goto(`/games/pubg-mobile?pack=${p660.id}`);
    await idField(page).fill('51234567');
    await expect(buyBox(page).getByRole('button', { name: p.reserve })).toBeVisible();
    await screenshot(page, testInfo, `buy-box-short-${theme}`);
    await buyBox(page).getByRole('button', { name: p.reserve }).click();
    await expect(buyBox(page).getByRole('slider')).toBeVisible();
    await screenshot(page, testInfo, `buy-box-slide-${theme}`);
  });
}
