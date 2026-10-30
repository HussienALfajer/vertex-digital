import type { Page } from '@playwright/test';
import {
  type CustomerPrices,
  type StoreGame,
  type StoreProduct,
  TIER_SETTINGS_DEFAULTS,
} from '@vertex-digital/contracts';
import ar from '../src/messages/ar.json' with { type: 'json' };
import { PUBG } from './catalog';
import { expect, type MockApi, screenshot, test } from './test';
import { tierSummary } from './tier-fixtures';

/*
 * S23 PR 3 in the store against the mocked API: the reply promise and the Diamond contact on the
 * support pages and the tier card (OP3, OP4); early access (OP5): a pack the cached page leaves
 * out shown to a Gold merchant with its chip, and a whole game in early access opened from its
 * not-found page. RTL screenshots at phone width and desktop, dark and light.
 */

const lightTheme = () => localStorage.setItem('vertex-theme', 'light');

function merchant(api: MockApi): MockApi {
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
    .on('GET /api/wallet', 200, { balanceUnits: 50_000_000, syp: null, reservedUsdUnits: 0 });
}

const diamond = tierSummary({
  tier: 'diamond',
  progress: { next: null, reachedPermille: 1_000, keep: null },
  privileges: TIER_SETTINGS_DEFAULTS.diamond,
  contact: { whatsappUrl: 'https://wa.me/963933123456', telegramUrl: 'https://t.me/vertex_shop' },
});

const gold = tierSummary({
  tier: 'gold',
  progress: { next: null, reachedPermille: 1_000, keep: null },
  privileges: TIER_SETTINGS_DEFAULTS.gold,
});

/** A pack of PUBG the public page does not list: in early access. */
const EARLY: StoreProduct = {
  ...(PUBG.products[0] as StoreProduct),
  id: '0199e400-0000-7000-8000-0000000000e1',
  nameAr: '8100 UC',
  gameAmount: 8100,
  available: true,
  priceUsdUnits: 98_000_000,
  priceSypUnits: null,
  savings: null,
  perHundredUsdUnits: null,
  bestValue: false,
  earlyAccess: true,
};

const goldPrices = (products: readonly StoreProduct[]): CustomerPrices => ({
  priceKind: 'wholesale',
  products: products.map((product) => ({
    id: product.id,
    available: product.available,
    priceUsdUnits: product.priceUsdUnits,
    priceSypUnits: null,
    savings: null,
    perHundredUsdUnits: null,
    bestValue: false,
    earlyAccess: product.earlyAccess,
  })),
  earlyProducts: [EARLY],
  rateId: PUBG.rateId,
});

const packButton = (page: Page, name: string) =>
  page.getByRole('button', { name: new RegExp(`^${name}`) });

for (const scheme of ['dark', 'light'] as const) {
  test(`the reply promise and the Diamond contact on support and the tier card (OP3, OP4), ${scheme}`, async ({
    page,
    api,
  }, testInfo) => {
    if (scheme === 'light') await page.addInitScript(lightTheme);
    merchant(api).on('GET /api/merchant/tier', 200, diamond);
    await page.goto('/support/new');
    const card = page.getByTestId('merchant-support');
    await expect(card).toContainText(ar.support.promise.hour);
    await expect(card.getByRole('link', { name: /واتساب/ })).toHaveAttribute(
      'href',
      'https://wa.me/963933123456',
    );
    await expect(card.getByRole('link', { name: /تيليغرام/ })).toHaveAttribute(
      'href',
      'https://t.me/vertex_shop',
    );
    await screenshot(page, testInfo, `support-new-diamond-${scheme}`);
    api
      .on('GET /api/merchant/tier/table', 200, { current: 'diamond', packs: [], tiers: [] })
      .on('GET /api/merchant/tier/history', 200, { items: [] })
      .on('GET /api/merchant/certificate', 200, {
        code: 'CertGold0123456789abcd',
        tradeName: 'محل النور للاتصالات',
        city: 'اعزاز',
        governorate: 'aleppo',
        tier: 'diamond',
        since: '2026-10-02T09:00:00.000Z',
        reissuedAt: null,
      });
    await page.goto('/merchant/tier');
    await expect(page.getByTestId('tier-card').getByTestId('direct-contact')).toBeVisible();
    await screenshot(page, testInfo, `merchant-tier-diamond-contact-${scheme}`);
  });
}

test('a Gold merchant sees the promise in hours and no contact (OP3, OP4)', async ({
  page,
  api,
}) => {
  merchant(api).on('GET /api/merchant/tier', 200, gold);
  await page.goto('/support/new');
  await expect(page.getByTestId('merchant-support')).toContainText('3 ساعات');
  await expect(page.getByTestId('direct-contact')).toHaveCount(0);
});

for (const scheme of ['dark', 'light'] as const) {
  test(`an early-access pack for a Gold merchant, with its chip (OP5), ${scheme}`, async ({
    page,
    api,
  }, testInfo) => {
    if (scheme === 'light') await page.addInitScript(lightTheme);
    merchant(api).on('GET /api/catalog/games/pubg-mobile/prices', 200, goldPrices(PUBG.products));
    await page.goto('/games/pubg-mobile');
    const early = packButton(page, ar.catalog.earlyAccess).or(packButton(page, '8100 UC'));
    await expect(early.first()).toContainText(ar.catalog.earlyAccess);
    await expect(early.first()).toContainText('$98.00');
    await screenshot(page, testInfo, `game-early-pack-${scheme}`);
  });
}

for (const scheme of ['dark', 'light'] as const) {
  test(`a game in early access opens for a Gold merchant from its not-found page (OP5), ${scheme}`, async ({
    page,
    api,
  }, testInfo) => {
    if (scheme === 'light') await page.addInitScript(lightTheme);
    const game: StoreGame = {
      ...PUBG,
      game: { ...PUBG.game, slug: 'early-game', nameAr: 'لعبة جديدة', nameEn: 'New Game' },
      products: [EARLY],
    };
    merchant(api)
      .on('GET /api/catalog/games/early-game/early-access', 200, game)
      .on('GET /api/catalog/games/early-game/prices', 200, {
        ...goldPrices([EARLY]),
        earlyProducts: [],
      });
    await page.goto('/games/early-game');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('لعبة جديدة');
    await expect(page).toHaveTitle(/لعبة جديدة/);
    // S24 NH6: outside the storefront, its back link goes home.
    await expect(page.locator('main [data-slot="back-link"]')).toHaveAttribute('href', '/');
    await expect(
      packButton(page, ar.catalog.earlyAccess).or(packButton(page, '8100 UC')).first(),
    ).toContainText('$98.00');
    await screenshot(page, testInfo, `game-early-access-${scheme}`);
  });
}

test('a game in early access stays not found for a customer', async ({ page, api }) => {
  api.on('GET /api/auth/get-session', 200, {
    user: { name: 'Lina', email: 'lina@example.com', emailVerified: true, accountType: 'customer' },
    session: { token: 'this-device' },
  });
  await page.goto('/games/early-game');
  await expect(page.getByRole('heading', { name: ar.notFound.title })).toBeVisible();
  expect(api.last('GET /api/catalog/games/early-game/early-access')).toBeUndefined();
});

test('a Gold merchant pays an early pack from the cart (OP5)', async ({ page, api }) => {
  merchant(api)
    .on('GET /api/catalog/games/pubg-mobile/prices', 200, goldPrices(PUBG.products))
    // The public index leaves the early pack out.
    .on('GET /api/catalog/search-index', 200, { games: [], products: [] });
  await page.addInitScript(
    ([id, name]) =>
      localStorage.setItem(
        'vd-cart',
        JSON.stringify({
          v: 1,
          lines: [
            {
              id: 'early-line',
              productId: id,
              gameSlug: 'pubg-mobile',
              quantity: 1,
              maxQuantity: 10,
              fields: { player_id: '51234567' },
              expectedUnitPriceUsdUnits: 98_000_000,
              confirmPlayer: false,
              playerCheck: { result: 'valid', playerName: 'Lina_99' },
              display: {
                gameNameAr: 'ببجي موبايل',
                productNameAr: name,
                cover: null,
                fields: [],
              },
            },
          ],
        }),
      ),
    [EARLY.id, EARLY.nameAr],
  );
  await page.goto('/cart');
  await expect(page.getByText(ar.cart.removeUnavailable)).toHaveCount(0);
  await expect(page.getByText('$98.00').first()).toBeVisible();
});

test('the point of sale opens a game in early access (OP5)', async ({ page, api }) => {
  const game: StoreGame = {
    ...PUBG,
    game: { ...PUBG.game, slug: 'early-game', nameAr: 'لعبة جديدة', nameEn: 'New Game' },
    products: [EARLY],
  };
  merchant(api)
    .on('GET /api/merchant/games', 200, {
      items: [{ id: PUBG.game.id, slug: 'early-game', nameAr: 'لعبة جديدة' }],
    })
    .on('GET /api/merchant/watches', 200, {
      games: [],
      products: [],
      suggestions: { games: [], products: [] },
    })
    .on('GET /api/catalog/games/early-game', 404, { statusCode: 404, code: 'NOT_FOUND' })
    .on('GET /api/catalog/games/early-game/early-access', 200, game)
    .on('GET /api/catalog/games/early-game/prices', 200, {
      ...goldPrices([EARLY]),
      earlyProducts: [EARLY],
    })
    .on('GET /api/merchant/selling-prices', 200, {
      settings: { markupBp: 1000, sypStepUnits: 50_000 },
      storeStepUnits: 500,
      products: [
        {
          productId: EARLY.id,
          nameAr: EARLY.nameAr,
          available: true,
          purchaseUsdUnits: 98_000_000,
          ownPrice: null,
          sellingUsdUnits: 105_000_000,
          sellingSypUnits: 136_500_000,
          source: 'markup',
          belowCost: false,
        },
      ],
    })
    .on('GET /api/merchant/recent-players', 200, { items: [] })
    .on('GET /api/orders', 200, { items: [], nextCursor: null, checkout: null });
  await page.goto('/merchant/pos');
  await expect(page.getByRole('button', { name: /8100 UC/ })).toBeVisible();
});
