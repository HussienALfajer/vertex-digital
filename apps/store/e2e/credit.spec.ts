import type { Page, TestInfo } from '@playwright/test';
import type { Order, StoreGame, StoreProduct } from '@vertex-digital/contracts';
import credit from '../src/features/credit/messages.ar.json' with { type: 'json' };
import tools from '../src/features/merchant-tools/messages.ar.json' with { type: 'json' };
import qb from '../src/features/quick-buy/messages.ar.json' with { type: 'json' };
import ar from '../src/messages/ar.json' with { type: 'json' };
import { CATALOG, searchIndex } from './catalog';
import { expect, type MockApi, screenshot, test } from './test';

/*
 * The credit section in the store (S25, PR 1 acceptance with a mocked API): SYP-first packs and
 * totals (SC2), the free amount (AM1, AM6), the recipient typed twice with paste blocked and
 * "متابعة" off until both are one number, then shown large with the no-refund line (RN2, D8), the
 * section's limit refusals with what remains (CL2, CL3, CS1, CS2), the held cash order (CS5) and
 * the amount on the order. Screenshots in RTL, dark and light, at both project widths.
 */

const p = ar.purchase;
const USD = 1_000_000;
const ORDER_ID = '0199e000-0000-7000-8000-000000002501';
const BILL = CATALOG.games['mtn-bill'] as StoreGame;
const CREDIT = CATALOG.games['mtn-credit'] as StoreGame;
const CASH = CATALOG.games['syriatel-cash'] as StoreGame;
const billPack = BILL.products[0] as StoreProduct;
const creditPack = CREDIT.products[0] as StoreProduct;
const cashPack = CASH.products[0] as StoreProduct;

const fill = (text: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{${key}}`, `${value}`),
    text,
  );

function signedIn(api: MockApi, balanceUnits = 50 * USD): MockApi {
  return api
    .on('GET /api/auth/get-session', 200, {
      user: { name: 'سارة الأحمد', email: 'sara@example.com', emailVerified: true },
      session: { token: 'this-device' },
    })
    .on('GET /api/wallet', 200, { balanceUnits, syp: null, reservedUsdUnits: 0 })
    .on('GET /api/credit-limits', 200, {
      sectionRemainingUsdUnits: 42 * USD,
      cashRemainingUsdUnits: 20 * USD,
      cashEligibleUsdUnits: 15 * USD,
      cashEligibleMoreAt: null,
    });
}

function order(game: StoreGame, product: StoreProduct, changes: Partial<Order> = {}): Order {
  const quantity = changes.quantity ?? 1;
  return {
    id: ORDER_ID,
    number: 'VO-CRD734',
    stage: 'processing',
    placedByStore: null,
    customerNote: null,
    product: {
      id: product.id,
      nameAr: product.nameAr,
      kind: product.kind,
      regionAr: null,
      redemptionAr: null,
      amountStep: product.amountStep,
      amountUnitAr: product.amountUnitAr,
    },
    game: { id: game.game.id, slug: game.game.slug, nameAr: game.game.nameAr, cover: null },
    fields: [{ key: 'recipient', labelAr: 'رقم MTN', value: '0944123456', valueLabelAr: null }],
    quantity,
    deliveredQuantity: 0,
    refundedQuantity: 0,
    unitPriceUsdUnits: product.priceUsdUnits as number,
    totalUsdUnits: (product.priceUsdUnits as number) * quantity,
    totalSypUnits: (product.priceSypUnits as number) * quantity,
    refundedUsdUnits: 0,
    refundReason: null,
    recipient: '0944123456',
    cashHold: null,
    timeline: [{ step: 'paid', at: new Date().toISOString() }],
    codes: [],
    expiresAt: null,
    cancelReason: null,
    playerName: null,
    playerRegion: null,
    deliveryStats: product.deliveryStats,
    expectedWithinMinutes: null,
    checkoutId: null,
    isGift: false,
    gift: null,
    shareLinks: [],
    privatePrice: false,
    verificationCode: 'VrfyCode0123456789abcd',
    sale: null,
    codeReleases: [],
    help: { status: 'awaiting_balance', paidAt: null, finishedAt: null, openTicketId: null },
    repeatable: false,
    createdAt: new Date().toISOString(),
    ...changes,
  };
}

const buyBox = (page: Page) =>
  page.getByRole('dialog').or(page.getByRole('complementary', { name: ar.game.buyBox }));

/** Picks a pack until its buy box opens (a click before hydration is lost on a slow runner). */
async function choose(page: Page, name: string) {
  await expect(async () => {
    await page.getByRole('button', { name: new RegExp(`^${name}`) }).click();
    await expect(buyBox(page).getByRole('heading', { name })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
}

/** Types the recipient twice, the second by hand. */
async function typeRecipient(page: Page, label: string, first: string, second = first) {
  await buyBox(page).getByLabel(label, { exact: true }).fill(first);
  await buyBox(page).getByLabel(credit.recipient.repeat).pressSequentially(second);
}

/**
 * The buy box alone: the page's full-height screenshot resizes the desktop viewport, which mounts
 * the side panel's box afresh, so the confirmation is captured in place before it is slid.
 */
async function boxShot(page: Page, testInfo: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  const path = testInfo.outputPath(`${name}.png`);
  await buyBox(page).first().screenshot({ path, animations: 'disabled' });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

async function slide(page: Page) {
  await buyBox(page).getByRole('slider', { name: p.slidePay }).focus();
  await page.keyboard.press('End');
}

for (const scheme of ['dark', 'light'] as const) {
  test.describe(`credit section (${scheme})`, () => {
    // The first test tours the game page, the buy box, its confirmation and the order.
    test.setTimeout(90_000);
    test.beforeEach(async ({ page }) => {
      if (scheme === 'light')
        await page.addInitScript(() => localStorage.setItem('vertex-theme', 'light'));
    });

    test('pays 7,300 SYP of a bill: the amount, the number twice, SYP first (AM1, RN2, SC2)', async ({
      page,
      api,
    }, testInfo) => {
      signedIn(api)
        .on('POST /api/orders', 201, order(BILL, billPack, { quantity: 73 }))
        .on(`GET /api/orders/${ORDER_ID}`, 200, order(BILL, billPack, { quantity: 73 }));
      await page.goto('/games/mtn-bill');
      // SC2, AM6, SC3: the pack in SYP first, its free amount, the speed and the prefixes.
      const card = page.getByRole('button', { name: /^دفع فاتورة MTN/ });
      await expect(card).toContainText(fill(credit.price.pay, { amount: '110' }));
      await expect(card).toContainText(
        fill(credit.pack.freeAmount, { min: '1,000', max: '100,000', unit: 'ل.س' }),
      );
      await expect(page.getByText(credit.game.fast)).toBeVisible();
      await expect(
        page.getByText(fill(credit.game.prefixes, { operator: 'MTN', prefixes: '094، 095، 096' })),
      ).toBeVisible();
      await screenshot(page, testInfo, `credit-game-${scheme}`);

      await choose(page, 'دفع فاتورة MTN');
      const go = buyBox(page).getByRole('button', { name: p.continue });
      // RN1: another operator's line is refused by name.
      await buyBox(page).getByLabel('رقم MTN', { exact: true }).fill('0933123456');
      await buyBox(page).getByLabel('رقم MTN', { exact: true }).blur();
      await expect(
        buyBox(page).getByText(fill(p.fieldErrors.wrongOperator, { operator: 'سيريتل' })),
      ).toBeVisible();
      // RN2: one number written two ways; paste is blocked on the second; "متابعة" waits.
      await buyBox(page).getByLabel('رقم MTN', { exact: true }).fill('0944 123 456');
      await expect(go).toBeDisabled();
      const repeat = buyBox(page).getByLabel(credit.recipient.repeat);
      await repeat.focus();
      await page.evaluate(() => {
        const data = new DataTransfer();
        data.setData('text/plain', '0944123456');
        document.activeElement?.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
        );
      });
      await expect(repeat).toHaveValue('');
      await repeat.pressSequentially('+963 944123455');
      await repeat.blur();
      await expect(buyBox(page).getByText(credit.recipient.mismatch)).toBeVisible();
      await expect(go).toBeDisabled();
      await repeat.fill('');
      await repeat.pressSequentially('+963 944123456');
      await expect(go).toBeEnabled();
      // AM1: a free amount in steps of 100 within the bounds, with live SYP and USD totals.
      const amount = buyBox(page).getByLabel(fill(credit.amount.label, { unit: 'ل.س' }));
      await amount.fill('7350');
      await amount.blur();
      await expect(
        buyBox(page).getByText(
          fill(credit.amount.invalid, { min: '1,000', max: '100,000', unit: 'ل.س', step: '100' }),
        ),
      ).toBeVisible();
      await amount.fill('7300');
      await expect(
        buyBox(page).getByText(fill(credit.price.pay, { amount: '8,030' })),
      ).toBeVisible();
      await expect(buyBox(page).getByText('$0.73').first()).toBeVisible();
      await expect(
        buyBox(page).getByText(fill(credit.limits.remaining, { section: '⁦$42.00⁩' })),
      ).toBeVisible();
      await screenshot(page, testInfo, `credit-amount-${scheme}`);
      await go.click();
      // RN2, D8: the number large, grouped, with the operator and the no-refund line.
      await expect(buyBox(page).getByTestId('recipient-confirm')).toHaveText('094 412 3456');
      await expect(buyBox(page).getByText(credit.recipient.warning)).toBeVisible();
      await expect(buyBox(page).getByText('7,300 ل.س')).toBeVisible();
      await boxShot(page, testInfo, `credit-confirm-${scheme}`);
      await slide(page);
      await expect(page).toHaveURL(`/orders/${ORDER_ID}`);
      expect(api.last('POST /api/orders')?.body).toEqual({
        productId: billPack.id,
        quantity: 73,
        fields: { recipient: '0944123456' },
        expectedUnitPriceUsdUnits: billPack.priceUsdUnits,
        whenBalanceShort: 'refuse',
        confirmPlayer: false,
      });
      // AM6, RN3: the order shows the amount and the number, never a quantity.
      await expect(page.getByText('7,300 ل.س')).toBeVisible();
      await expect(page.getByText('094 412 3456')).toBeVisible();
      await screenshot(page, testInfo, `credit-order-${scheme}`);
    });

    test('pays a credit pack to the number typed twice', async ({ page, api }) => {
      signedIn(api)
        .on('POST /api/orders', 201, order(CREDIT, creditPack))
        .on(`GET /api/orders/${ORDER_ID}`, 200, order(CREDIT, creditPack));
      await page.goto('/games/mtn-credit');
      await choose(page, '1,000 ل.س رصيد');
      await typeRecipient(page, 'رقم MTN', '0944123456');
      await buyBox(page).getByRole('button', { name: p.continue }).click();
      await expect(buyBox(page).getByTestId('recipient-confirm')).toHaveText('094 412 3456');
      await slide(page);
      await expect(page).toHaveURL(`/orders/${ORDER_ID}`);
      expect(api.last('POST /api/orders')?.body).toMatchObject({
        productId: creditPack.id,
        quantity: 1,
        fields: { recipient: '0944123456' },
      });
    });
  });
}

test.describe('credit section refusals', () => {
  const refusals = [
    {
      code: 'CREDIT_DAILY_LIMIT',
      details: { remainingUsdUnits: 3_500_000 },
      text: fill(credit.limits.credit, { remaining: '⁦$3.50⁩' }),
    },
    {
      code: 'RECIPIENT_DAILY_LIMIT',
      details: { recipient: '0944123456', limit: 5 },
      text: fill(credit.limits.recipient, { limit: 5 }),
    },
    {
      code: 'CASH_DAILY_LIMIT',
      details: { remainingUsdUnits: 0 },
      text: fill(credit.limits.cash, { remaining: '⁦$0.00⁩' }),
    },
    {
      code: 'CASH_BALANCE_TOO_RECENT',
      details: { eligibleUsdUnits: 2_000_000, eligibleMoreAt: null },
      text: fill(credit.limits.recent, { eligible: '⁦$2.00⁩' }),
    },
  ];
  for (const refusal of refusals) {
    test(`says what remains on ${refusal.code} (CL2, CL3, CS1, CS2)`, async ({
      page,
      api,
    }, testInfo) => {
      const cash = refusal.code.startsWith('CASH');
      signedIn(api).on('POST /api/orders', 409, {
        statusCode: 409,
        code: refusal.code,
        message: 'refused',
        details: refusal.details,
      });
      await page.goto(cash ? '/games/syriatel-cash' : '/games/mtn-bill');
      await choose(page, cash ? 'تحويل سيريتل كاش' : 'دفع فاتورة MTN');
      const label = cash ? 'رقم سيريتل' : 'رقم MTN';
      await typeRecipient(page, label, cash ? '0933123456' : '0944123456');
      await buyBox(page)
        .getByLabel(fill(credit.amount.label, { unit: 'ل.س' }))
        .fill('2000');
      await buyBox(page).getByRole('button', { name: p.continue }).click();
      await slide(page);
      await expect(buyBox(page).getByText(refusal.text)).toBeVisible();
      if (refusal.code === 'CREDIT_DAILY_LIMIT')
        await screenshot(page, testInfo, 'credit-limit-dark');
    });
  }

  test('a cash pack is never reserved: a short balance offers no reservation (CS1)', async ({
    page,
    api,
  }) => {
    signedIn(api, 0);
    await page.goto('/games/syriatel-cash');
    await choose(page, 'تحويل سيريتل كاش');
    await typeRecipient(page, 'رقم سيريتل', '0933123456');
    await buyBox(page)
      .getByLabel(fill(credit.amount.label, { unit: 'ل.س' }))
      .fill('2000');
    await expect(buyBox(page).getByRole('link', { name: qb.gap.deposit })).toBeVisible();
    await expect(buyBox(page).getByRole('button', { name: qb.gap.reserve })).toHaveCount(0);
  });
});

for (const scheme of ['dark', 'light'] as const) {
  test(`a held cash order says "قيد المراجعة" (CS5, ${scheme})`, async ({
    page,
    api,
  }, testInfo) => {
    if (scheme === 'light')
      await page.addInitScript(() => localStorage.setItem('vertex-theme', 'light'));
    const held = order(CASH, cashPack, {
      quantity: 20,
      cashHold: 'held',
      recipient: '0933123456',
      fields: [
        { key: 'recipient', labelAr: 'رقم سيريتل', value: '0933123456', valueLabelAr: null },
      ],
    });
    signedIn(api)
      .on(`GET /api/orders/${ORDER_ID}`, 200, held)
      .on('GET /api/orders', 200, {
        items: [
          {
            id: ORDER_ID,
            number: held.number,
            stage: 'processing',
            productNameAr: cashPack.nameAr,
            productKind: 'amount',
            amountStep: 100,
            amountUnitAr: 'ل.س',
            cashHold: 'held',
            game: { id: CASH.game.id, slug: CASH.game.slug, nameAr: CASH.game.nameAr, cover: null },
            quantity: 20,
            totalUsdUnits: held.totalUsdUnits,
            totalSypUnits: held.totalSypUnits,
            placedByStore: null,
            isGift: false,
            repeatable: false,
            expiresAt: null,
            checkoutId: null,
            customerNote: null,
            createdAt: held.createdAt,
          },
        ],
        nextCursor: null,
        checkout: null,
      });
    await page.goto(`/orders/${ORDER_ID}`);
    await expect(page.getByText(credit.hold.sentence)).toBeVisible();
    await expect(page.getByText('2,000 ل.س')).toBeVisible();
    await expect(page.getByText('093 312 3456')).toBeVisible();
    await screenshot(page, testInfo, `credit-held-${scheme}`);
    await page.goto('/orders');
    await expect(page.getByText(credit.hold.badge)).toBeVisible();
    await expect(page.getByText('2,000 ل.س')).toBeVisible();
  });
}

/** The search index the cart prices its lines from, with the section's packs in it. */
function sectionSearchIndex() {
  const index = searchIndex();
  return {
    games: index.games,
    products: [
      ...index.products,
      ...[BILL, CREDIT, CASH].flatMap((game) =>
        game.products.map((product) => ({
          id: product.id,
          nameAr: product.nameAr,
          gameAmount: product.gameAmount,
          available: product.available,
          priceUsdUnits: product.priceUsdUnits,
          priceSypUnits: product.priceSypUnits,
          gameSlug: game.game.slug,
        })),
      ),
    ],
  };
}

const CHECKOUT_ID = '0199e000-0000-7000-8000-000000002502';

/** A merchant signed in, with the section's limits and the sale mode's reads of the bill game. */
function merchantCounter(api: MockApi): MockApi {
  const unit = billPack.priceUsdUnits as number;
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
      .on('GET /api/wallet', 200, { balanceUnits: 50 * USD, syp: null, reservedUsdUnits: 0 })
      .on('GET /api/credit-limits', 200, {
        sectionRemainingUsdUnits: 400 * USD,
        cashRemainingUsdUnits: 100 * USD,
        cashEligibleUsdUnits: 100 * USD,
        cashEligibleMoreAt: null,
      })
      .on('GET /api/catalog/games/mtn-bill/prices', 200, {
        priceKind: 'wholesale',
        products: BILL.products.map((product) => ({
          id: product.id,
          available: true,
          priceUsdUnits: product.priceUsdUnits,
          priceSypUnits: product.priceSypUnits,
          savings: null,
          perHundredUsdUnits: null,
          bestValue: false,
          earlyAccess: false,
        })),
        earlyProducts: [],
        rateId: BILL.rateId,
      })
      .on('GET /api/merchant/selling-prices', 200, {
        settings: { markupBp: 1000, sypStepUnits: 50_000 },
        storeStepUnits: 500,
        products: [
          {
            productId: billPack.id,
            nameAr: billPack.nameAr,
            available: true,
            purchaseUsdUnits: unit,
            ownPrice: null,
            sellingUsdUnits: unit,
            sellingSypUnits: billPack.priceSypUnits,
            source: 'markup',
            belowCost: false,
          },
        ],
      })
      .on('GET /api/merchant/recent-players', 200, { items: [] })
      .on('GET /api/saved-players', 200, { items: [] })
      // The counter's recent sales, read again once a sale goes through.
      .on('GET /api/orders', 200, { items: [], nextCursor: null, checkout: null })
  );
}

for (const scheme of ['dark', 'light'] as const) {
  test.describe(`credit section beyond the buy box (${scheme})`, () => {
    test.setTimeout(90_000);
    test.beforeEach(async ({ page }) => {
      if (scheme === 'light')
        await page.addInitScript(() => localStorage.setItem('vertex-theme', 'light'));
    });

    test('a bill in the cart shows the number large with the no-refund line, then pays (RN2, AM5)', async ({
      page,
      api,
    }, testInfo) => {
      const total = (billPack.priceUsdUnits as number) * 73;
      signedIn(api)
        .on('GET /api/catalog/search-index', 200, sectionSearchIndex())
        .on('POST /api/checkouts', 201, {
          id: CHECKOUT_ID,
          totalUsdUnits: total,
          totalSypUnits: null,
          orders: [],
        })
        .on('GET /api/orders', 200, {
          items: [],
          nextCursor: null,
          checkout: { id: CHECKOUT_ID, totalUsdUnits: total, orderCount: 1, finishedAt: null },
        });
      await page.goto('/games/mtn-bill');
      await choose(page, 'دفع فاتورة MTN');
      await typeRecipient(page, 'رقم MTN', '0944 123 456', '+963 944123456');
      await buyBox(page)
        .getByLabel(fill(credit.amount.label, { unit: 'ل.س' }))
        .fill('7300');
      await buyBox(page).getByRole('button', { name: p.cart.add }).click();
      await expect(buyBox(page).getByText(p.cart.added)).toBeVisible();

      await page.goto('/cart');
      // AM6, SC2: the amount, never a quantity, and the pounds first.
      await expect(page.getByText('7,300 ل.س')).toBeVisible();
      await expect(
        page.getByText(fill(credit.price.pay, { amount: '8,030' })).first(),
      ).toBeVisible();
      // RN2, D8: the number large, grouped, with the operator and the no-refund line.
      await expect(page.getByTestId('recipient-confirm')).toHaveText('094 412 3456');
      await expect(page.getByText(credit.recipient.warning)).toBeVisible();
      await screenshot(page, testInfo, `credit-cart-${scheme}`);
      await page.getByRole('slider').focus();
      await page.keyboard.press('End');
      await expect(page).toHaveURL(`/orders?checkout=${CHECKOUT_ID}`);
      expect(api.last('POST /api/checkouts')?.body).toMatchObject({
        lines: [
          {
            productId: billPack.id,
            quantity: 73,
            fields: { recipient: '0944123456' },
            expectedUnitPriceUsdUnits: billPack.priceUsdUnits,
          },
        ],
      });
    });

    test('the sale mode takes the amount and the number twice, then confirms it large (RN2, AM5)', async ({
      page,
      api,
    }, testInfo) => {
      merchantCounter(api).on('POST /api/orders', 201, order(BILL, billPack, { quantity: 73 }));
      await page.addInitScript(() => {
        if (sessionStorage.getItem('seeded')) return;
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem('vd-merchant', '1');
        localStorage.setItem('vd-sale-mode', '1');
      });
      await page.goto('/games/mtn-bill');
      await page.locator('input[name="recipient"]').fill('0944 123 456');
      const repeat = page.getByLabel(credit.recipient.repeat);
      await repeat.focus();
      await page.evaluate(() => {
        const data = new DataTransfer();
        data.setData('text/plain', '0944123456');
        document.activeElement?.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
        );
      });
      await expect(repeat).toHaveValue('');
      await repeat.pressSequentially('0944123456');
      await page.getByTestId('sale-packs').getByRole('button').first().click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByTestId('recipient-confirm')).toHaveText('094 412 3456');
      await expect(dialog.getByText(credit.recipient.warning)).toBeVisible();
      await dialog.getByLabel(fill(credit.amount.label, { unit: 'ل.س' })).fill('7300');
      await expect(dialog.getByText('7,300 ل.س')).toBeVisible();
      await screenshot(page, testInfo, `credit-sale-${scheme}`);
      const handle = dialog.getByRole('slider', { name: tools.sale.slide });
      await expect(handle).not.toHaveAttribute('aria-disabled', 'true');
      await handle.press('End');
      await expect
        .poll(() => api.last('POST /api/orders')?.body)
        .toMatchObject({
          productId: billPack.id,
          quantity: 73,
          fields: { recipient: '0944123456' },
          expectedUnitPriceUsdUnits: billPack.priceUsdUnits,
        });
    });

    test('quick buy shows an amount and a section refusal (AM5, CL3)', async ({
      page,
      api,
    }, testInfo) => {
      const player = {
        id: '0199e000-0000-7000-8000-000000002503',
        gameId: BILL.game.id,
        gameSlug: BILL.game.slug,
        gameNameAr: BILL.game.nameAr,
        cover: BILL.game.cover,
        gameShown: true,
        label: 'فاتورة البيت',
        fields: { recipient: '0944123456' },
        fieldLabels: { recipient: 'رقم MTN' },
        playerName: null,
        rejected: false,
        complete: true,
        lastUsedAt: new Date(Date.now() - 3_600_000).toISOString(),
        quickBuyHidden: false,
      };
      signedIn(api)
        .on('GET /api/quick-buy', 200, {
          items: [
            {
              savedPlayer: player,
              game: { slug: BILL.game.slug, nameAr: BILL.game.nameAr, cover: BILL.game.cover },
              product: {
                id: billPack.id,
                nameAr: billPack.nameAr,
                kind: 'amount',
                gameAmount: null,
                amountStep: 100,
                amountUnitAr: 'ل.س',
              },
              quantity: 73,
              unitPriceUsdUnits: billPack.priceUsdUnits,
              unitPriceSypUnits: billPack.priceSypUnits,
              priceKind: 'retail',
              state: 'ready',
            },
          ],
        })
        .on('POST /api/orders', 409, {
          statusCode: 409,
          code: 'RECIPIENT_DAILY_LIMIT',
          message: 'refused',
          details: { recipient: '0944123456', limit: 5 },
        });
      await page.goto('/');
      const row = page.getByRole('region', { name: qb.row.title });
      await expect(row.getByText('7,300 ل.س')).toBeVisible();
      await row
        .getByRole('button', { name: /^اشحن / })
        .first()
        .click();
      const sheet = page.getByRole('dialog');
      await expect(sheet.getByText('7,300 ل.س')).toBeVisible();
      await screenshot(page, testInfo, `credit-quick-buy-${scheme}`);
      await sheet.getByRole('slider', { name: p.slidePay }).focus();
      await page.keyboard.press('End');
      await expect(sheet.getByText(fill(credit.limits.recipient, { limit: 5 }))).toBeVisible();
      expect(api.last('POST /api/orders')?.body).toMatchObject({
        productId: billPack.id,
        quantity: 73,
        fields: { recipient: '0944123456' },
      });
    });
  });
}
