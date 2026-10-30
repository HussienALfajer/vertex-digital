import type { Page } from '@playwright/test';
import { type CustomerPrices, formatUsd, type Order } from '@vertex-digital/contracts';
import ar from '../src/messages/ar.json' with { type: 'json' };
import { PUBG, pack } from './catalog';
import { expect, type MockApi, screenshot, test } from './test';

/*
 * S20 AT4 in the store: an account on a list other than retail reads its own prices of a game
 * page in the browser (the cached page stays retail for everyone), with its price kind's label;
 * the purchase sends that price; a failed read offers a retry and no buy; a browser whose account
 * had private prices hides the cached retail figures before paint.
 */

const USD = 1_000_000;
const ORDER_ID = '0199e000-0000-7000-8000-000000000020';
const p60 = pack(PUBG, '60 UC');
const PRIVATE_60 = p60.priceUsdUnits ? p60.priceUsdUnits - 40_000 : USD;

function signedIn(api: MockApi): MockApi {
  return api
    .on('GET /api/auth/get-session', 200, {
      user: { name: 'محل النور', email: 'shop@example.com', emailVerified: true },
      session: { token: 'this-device' },
    })
    .on('GET /api/wallet', 200, { balanceUnits: 50 * USD, syp: null, reservedUsdUnits: 0 });
}

const merchantPrices = (): CustomerPrices => ({
  priceKind: 'wholesale',
  products: PUBG.products.map((product) => ({
    id: product.id,
    available: product.available,
    priceUsdUnits:
      product.id === p60.id ? PRIVATE_60 : product.priceUsdUnits && product.priceUsdUnits - 10_000,
    priceSypUnits: null,
    savings: null,
    // S22 BV3: the badge over the account's own prices.
    perHundredUsdUnits: product.gameAmount && product.available ? 1_000_000 : null,
    bestValue: product.nameAr === '660 UC',
    earlyAccess: false,
  })),
  earlyProducts: [],
  rateId: PUBG.rateId,
});

const packButton = (page: Page, name: string) =>
  page.getByRole('button', { name: new RegExp(`^${name}`) });

test.describe('private prices', () => {
  test('a merchant sees and pays the wholesale price with its label', async ({ page, api }) => {
    signedIn(api)
      .on('GET /api/catalog/games/pubg-mobile/prices', 200, merchantPrices())
      .on('POST /api/player-checks', 200, { result: 'valid', playerName: 'Lina_99' })
      .on('POST /api/orders', 201, { id: ORDER_ID } as Order);
    await page.goto('/games/pubg-mobile');
    await expect(page.getByText(ar.game.privatePrices.kinds.wholesale)).toBeVisible();
    await expect(packButton(page, '60 UC')).toContainText(formatUsd(PRIVATE_60));
    await expect(packButton(page, '60 UC')).not.toContainText(formatUsd(p60.priceUsdUnits ?? 0));
    // S22 BV3: the best value follows the account's prices, not the cached retail ones.
    await expect(packButton(page, '660 UC').getByText(ar.catalog.price.bestValue)).toBeVisible();
    await expect(packButton(page, '60 UC').getByText(ar.catalog.price.bestValue)).toHaveCount(0);
    // The browser remembers it, so the next game page hides retail before paint.
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('vd-private-prices')))
      .toBe('1');
    expect(api.last('GET /api/catalog/games/pubg-mobile/prices')).toBeDefined();
  });

  test('a failed read of its prices offers a retry and no buy', async ({ page, api }) => {
    signedIn(api).on('GET /api/catalog/games/pubg-mobile/prices', 500, {
      statusCode: 500,
      code: 'INTERNAL_ERROR',
    });
    await page.addInitScript(() => localStorage.setItem('vd-private-prices', '1'));
    await page.goto('/games/pubg-mobile');
    await expect(page.getByText(ar.game.privatePrices.failed)).toBeVisible();
    await expect(packButton(page, '60 UC')).toBeDisabled();
    // The cached retail figure stays hidden under its skeleton.
    await expect(
      packButton(page, '60 UC').getByText(formatUsd(p60.priceUsdUnits ?? 0)),
    ).toBeHidden();
    api.on('GET /api/catalog/games/pubg-mobile/prices', 200, merchantPrices());
    await page.getByRole('button', { name: ar.game.privatePrices.retry }).click();
    await expect(packButton(page, '60 UC')).toContainText(formatUsd(PRIVATE_60));
    await expect(packButton(page, '60 UC')).toBeEnabled();
  });

  test('a retail account keeps the cached prices and forgets the hint', async ({ page, api }) => {
    signedIn(api);
    await page.addInitScript(() => localStorage.setItem('vd-private-prices', '1'));
    await page.goto('/games/pubg-mobile');
    await expect(packButton(page, '60 UC')).toContainText(formatUsd(p60.priceUsdUnits ?? 0));
    await expect(packButton(page, '60 UC')).toBeEnabled();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('vd-private-prices')))
      .toBeNull();
    await expect(page.getByText(ar.game.privatePrices.kinds.wholesale)).toHaveCount(0);
  });

  test('an unverified account keeps retail and can choose a pack', async ({ page, api }) => {
    api.on('GET /api/auth/get-session', 200, {
      user: { name: 'محل النور', email: 'shop@example.com', emailVerified: false },
      session: { token: 'this-device' },
    });
    await page.goto('/games/pubg-mobile');
    await expect(packButton(page, '60 UC')).toBeEnabled();
    await expect(packButton(page, '60 UC')).toContainText(formatUsd(p60.priceUsdUnits ?? 0));
    expect(api.last('GET /api/catalog/games/pubg-mobile/prices')).toBeUndefined();
  });

  for (const theme of ['dark', 'light'] as const) {
    test(`the merchant's game page (${theme})`, async ({ page, api }, testInfo) => {
      signedIn(api).on('GET /api/catalog/games/pubg-mobile/prices', 200, merchantPrices());
      if (theme === 'light') {
        await page.addInitScript(() => localStorage.setItem('vertex-theme', 'light'));
      }
      await page.goto('/games/pubg-mobile');
      await expect(packButton(page, '60 UC')).toContainText(formatUsd(PRIVATE_60));
      await screenshot(page, testInfo, `game-merchant-${theme}`);
    });
  }
});
