import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import { type AdminApi, expect, screenshot, test } from './test';

/*
 * S19 PC1–PC3 in the panel: the game page's "فحص اللاعب" card (provider, searchable check
 * category, the field map proposed by key, allowed regions, the switch, "تجربة"), the region on
 * an order, and D10's "صورة <المورد>" beside the cover, against the mocked API.
 */

const g = ar.orders.gameCheck;

const fill = (text: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{{${key}}}`, String(value)),
    text,
  );

/** PUBG Mobile with its player id field and a direct pack; the fake supplier connected. */
function pubg(admin: AdminApi) {
  admin.signedIn = true;
  admin.suppliers.connectFake();
  const game = admin.catalog.addGame({
    categorySlug: 'games',
    slug: 'pubg-mobile',
    nameAr: 'ببجي موبايل',
    nameEn: 'PUBG Mobile',
    status: 'active',
    cover: true,
  });
  admin.catalog.addField(game.id, { key: 'player_id', labelAr: 'معرّف اللاعب' });
  admin.catalog.addProduct(game.id, { nameAr: '60 شدة', gameAmount: 60 });
  return game;
}

test.describe('game player check', () => {
  test('sets the provider, its category, the map and the regions, then tries it (PC1–PC3)', async ({
    page,
    admin,
  }) => {
    const game = pubg(admin);
    await page.goto(`/catalog/games/${game.id}?tab=fields`);
    const card = page.locator('[data-slot="card"]').filter({ hasText: g.title });
    await expect(card.getByText(g.hint)).toBeVisible();

    // A save without a category is refused in place.
    await card.getByRole('combobox', { name: g.provider }).click();
    await page.getByRole('option', { name: 'مورد تجريبي' }).click();
    await card.getByRole('button', { name: g.save }).click();
    await expect(card.getByText(g.errors.category)).toBeVisible();
    await expect(card.getByText(ar.common.invalidFields)).toBeVisible();

    // The search narrows the categories; the field map is proposed by key.
    await card.getByPlaceholder(g.search).fill('player');
    await card.getByRole('combobox', { name: g.category }).click();
    await expect(page.getByRole('option')).toHaveCount(1);
    await page.getByRole('option', { name: /Fake player check/ }).click();
    await expect(
      card.getByRole('combobox', {
        name: fill(ar.suppliers.fieldMap.target, { field: 'player_id' }),
      }),
    ).toHaveText('معرّف اللاعب');

    const regions = card.getByPlaceholder(g.regionPlaceholder);
    await regions.fill('me');
    await regions.press('Enter');
    await regions.fill('ME');
    await regions.press('Enter');
    await expect(card.getByText(g.regionRefused.duplicate)).toBeVisible();
    await regions.fill('EU');
    await regions.press('Enter');
    await card.getByRole('button', { name: g.save }).click();
    await expect(card.getByText(g.saved)).toBeVisible();
    expect(admin.orders.gameChecks.get(game.id)).toMatchObject({
      supplierCode: 'fake',
      categoryId: 'player',
      fieldMap: { player_id: 'player_id' },
      allowedRegions: ['ME', 'EU'],
      enabled: true,
    });
    await expect(card.getByText(g.on, { exact: true })).toBeVisible();

    // "تجربة": the saved row checks typed values; a region outside the list is shown as refused.
    admin.orders.nextPlayerCheck = { result: 'region_mismatch', playerName: 'Lina', region: 'NA' };
    await card.getByRole('textbox', { name: 'معرّف اللاعب' }).fill('5123456789');
    await card.getByRole('button', { name: g.trialRun }).click();
    await expect(
      card.getByText(fill(ar.orders.buy.checkRegionMismatch, { region: 'NA' }), { exact: false }),
    ).toBeVisible();
    admin.orders.nextPlayerCheck = { result: 'valid', playerName: 'Lina', region: 'ME' };
    await card.getByRole('button', { name: g.trialRun }).click();
    await expect(
      card.getByText(fill(ar.orders.buy.checkRegion, { region: 'ME' }), { exact: false }),
    ).toBeVisible();
  });

  test('a disabled row keeps the setting and turns the check off', async ({ page, admin }) => {
    const game = pubg(admin);
    admin.orders.gameChecks.set(game.id, {
      gameId: game.id,
      supplierCode: 'fake',
      categoryId: 'player',
      fieldMap: { player_id: 'player_id' },
      optionMap: {},
      allowedRegions: [],
      enabled: true,
      updatedAt: new Date().toISOString(),
    });
    await page.goto(`/catalog/games/${game.id}?tab=fields`);
    const card = page.locator('[data-slot="card"]').filter({ hasText: g.title });
    await card.getByRole('switch').click();
    await card.getByRole('button', { name: g.save }).click();
    await expect(card.getByText(g.saved)).toBeVisible();
    expect(admin.orders.gameChecks.get(game.id)?.enabled).toBe(false);
    await expect(card.getByRole('button', { name: g.trialRun })).toHaveCount(0);
  });
});

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('S19 player check screenshots', async ({ page, admin }, testInfo) => {
      const game = pubg(admin);
      admin.orders.gameChecks.set(game.id, {
        gameId: game.id,
        supplierCode: 'fake',
        categoryId: 'player',
        fieldMap: { player_id: 'player_id' },
        optionMap: {},
        allowedRegions: ['ME', 'EU'],
        enabled: true,
        updatedAt: new Date().toISOString(),
      });
      admin.orders.nextPlayerCheck = { result: 'valid', playerName: 'Lina_99', region: 'ME' };
      await page.goto(`/catalog/games/${game.id}?tab=fields`);
      const card = page.locator('[data-slot="card"]').filter({ hasText: g.title });
      await card.getByRole('textbox', { name: 'معرّف اللاعب' }).fill('5123456789');
      await card.getByRole('button', { name: g.trialRun }).click();
      await expect(card.getByText(/Lina_99/)).toBeVisible();
      await screenshot(page, testInfo, `game-player-check-${colorScheme}`, { fullPage: true });
    });
  });
}
