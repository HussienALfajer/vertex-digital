import type { Page } from '@playwright/test';
import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import { type AdminApi, expect, screenshot, test } from './test';

/*
 * S16 PR 4 (MF1–MF3): the fake's Mobile Legends (player id and zone) and Genshin Impact (a region
 * select) imported, linked with an option map, and a route's option map edited in the drawer,
 * against the mocked API (`supplier-catalog-mock.ts`, `suppliers-mock.ts`). Acceptance steps
 * 12–13.
 */

const s = ar.suppliers;
const c = s.catalog;

const fill = (text: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{{${key}}}`, String(value)),
    text,
  );

function synced(admin: AdminApi) {
  admin.signedIn = true;
  admin.suppliers.connectFake();
}

/** An existing Genshin game whose region select has the given options. */
function genshin(admin: AdminApi, slug: string, options: [string, string][]) {
  const game = admin.catalog.addGame({
    categorySlug: 'games',
    slug,
    nameAr: `جنشن ${slug}`,
    nameEn: 'Genshin',
    status: 'active',
    cover: true,
  });
  admin.catalog.addField(game.id, { key: 'player_id', labelAr: 'معرّف اللاعب' });
  admin.catalog.addField(game.id, {
    key: 'region',
    labelAr: 'المنطقة',
    type: 'select',
    options: options.map(([value, labelAr]) => ({ value, labelAr })),
  });
  return game;
}

async function nodeAction(page: Page, name: string, action: string) {
  await page.getByRole('button', { name: fill(c.actions, { name }) }).click();
  await page.getByRole('menuitem', { name: action }).click();
}

async function linkTo(page: Page, gameName: string) {
  await nodeAction(page, 'Genshin Impact', c.link);
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('combobox', { name: s.linkCategory.game }).click();
  await page.getByRole('option', { name: gameName, exact: true }).click();
  return sheet;
}

test.describe('two fields and select fields', () => {
  test('imports Mobile Legends with two fields, and Genshin with its region select (MF1–MF3)', async ({
    page,
    admin,
  }) => {
    synced(admin);
    // The second pack lists one option fewer: refused until that option is removed.
    const short = admin.suppliers.offers.find((offer) => offer.offerId === 'fake-gi-330');
    const region = short?.fieldSpecs?.[1];
    if (!short || !region?.options) throw new Error('No region select');
    short.fieldSpecs = [
      short.fieldSpecs?.[0] as NonNullable<typeof region>,
      { ...region, options: region.options.slice(0, 3) },
    ];
    await page.goto('/suppliers/fake?tab=catalog');

    await nodeAction(page, 'Mobile Legends', c.import);
    let sheet = page.getByRole('dialog');
    await expect(sheet.getByText('playerId', { exact: true })).toBeVisible();
    await expect(sheet.getByText('zoneId', { exact: true })).toBeVisible();
    await sheet.getByRole('button', { name: fill(s.importCategory.submit, { count: 2 }) }).click();
    await expect(sheet.getByText(s.importCategory.done)).toBeVisible();
    const ml = admin.catalog.games.find((game) => game.slug === 'mobile-legends');
    const mlRoute = admin.suppliers.routes.find((route) =>
      admin.catalog.products.some((item) => item.id === route.productId && item.gameId === ml?.id),
    );
    expect(mlRoute?.fieldMap).toEqual({ playerId: 'playerid', zoneId: 'zoneid' });
    await page.keyboard.press('Escape');

    await nodeAction(page, 'Genshin Impact', c.import);
    sheet = page.getByRole('dialog');
    // The supplier's options as ours, labels kept, each with the value it is sent as.
    for (const [value, label] of [
      ['os_usa', 'America'],
      ['os_euro', 'Europe'],
      ['os_asia', 'Asia'],
      ['os_cht', 'TW, HK, MO'],
    ]) {
      await expect(
        sheet.getByRole('textbox', {
          name: fill(s.importCategory.optionLabel, { value: value as string }),
        }),
      ).toHaveValue(label as string);
    }
    await expect(sheet.getByText('os_cht', { exact: true })).toBeVisible();
    const pick = sheet.getByRole('checkbox', {
      name: fill(s.importCategory.selectPack, { name: 'Fake Genesis Crystals 330' }),
    });
    await expect(pick).toBeDisabled();
    await expect(sheet.getByText(s.importCategory.refusals.FIELD_OPTIONS_DIFFER)).toBeVisible();
    await sheet
      .getByRole('textbox', { name: fill(s.importCategory.optionLabel, { value: 'os_usa' }) })
      .fill('أمريكا');
    await sheet
      .getByRole('button', { name: fill(s.importCategory.removeOption, { name: 'TW, HK, MO' }) })
      .click();
    await expect(pick).toBeEnabled();
    await pick.check();
    await sheet.getByRole('button', { name: fill(s.importCategory.submit, { count: 2 }) }).click();
    await expect(sheet.getByText(s.importCategory.done)).toBeVisible();
    const gi = admin.catalog.games.find((game) => game.slug === 'genshin-impact');
    const field = admin.catalog.fields.find(
      (item) => item.gameId === gi?.id && item.key === 'region',
    );
    expect(field?.options).toEqual([
      { value: 'os_usa', labelAr: 'أمريكا' },
      { value: 'os_euro', labelAr: 'Europe' },
      { value: 'os_asia', labelAr: 'Asia' },
    ]);
    const routes = admin.suppliers.routes.filter((route) =>
      admin.catalog.products.some((item) => item.id === route.productId && item.gameId === gi?.id),
    );
    expect(routes.map((route) => route.optionMap)).toEqual([
      { region: { os_usa: 'os_usa', os_euro: 'os_euro', os_asia: 'os_asia' } },
      { region: { os_usa: 'os_usa', os_euro: 'os_euro', os_asia: 'os_asia' } },
    ]);
  });

  test('links Genshin to a game whose region has fewer options, mapping each (MF3)', async ({
    page,
    admin,
  }) => {
    synced(admin);
    genshin(admin, 'gi-two', [
      ['us', 'America'],
      ['eu', 'أوروبا'],
    ]);
    await page.goto('/suppliers/fake?tab=catalog');
    const sheet = await linkTo(page, 'جنشن gi-two');
    await expect(sheet.getByText(s.optionMap.title)).toBeVisible();
    // America proposed by its label; أوروبا left for the admin.
    await expect(sheet.getByText(s.optionMap.missing)).toBeVisible();
    await sheet
      .getByRole('combobox', { name: fill(s.optionMap.target, { option: 'أوروبا' }) })
      .click();
    await page.getByRole('option', { name: 'Europe (os_euro)' }).click();
    await expect(sheet.getByText(s.optionMap.missing)).toHaveCount(0);
    await sheet.getByRole('button', { name: fill(s.linkCategory.submit, { count: 2 }) }).click();
    await expect(sheet.getByText(s.linkCategory.done)).toBeVisible();
    expect(admin.suppliers.routes.map((route) => route.optionMap).at(-1)).toEqual({
      region: { us: 'os_usa', eu: 'os_euro' },
    });
  });

  test('refuses the packs when the game has an option the supplier lacks (FIELD_OPTIONS_DIFFER)', async ({
    page,
    admin,
  }) => {
    synced(admin);
    genshin(admin, 'gi-mars', [
      ['us', 'America'],
      ['mars', 'المريخ'],
    ]);
    await page.goto('/suppliers/fake?tab=catalog');
    const sheet = await linkTo(page, 'جنشن gi-mars');
    await expect(
      sheet.getByText(s.importCategory.refusals.FIELD_OPTIONS_DIFFER).first(),
    ).toBeVisible();
    await expect(
      sheet.getByRole('combobox', {
        name: fill(s.linkCategory.mode, { name: 'Fake Genesis Crystals 60' }),
      }),
    ).toBeDisabled();
  });

  test('edits a route’s option map in the drawer (MF2)', async ({ page, admin }) => {
    synced(admin);
    const game = genshin(admin, 'gi-route', [
      ['us', 'America'],
      ['eu', 'Europe'],
    ]);
    const product = admin.catalog.addProduct(game.id, { nameAr: '60 كريستالة' });
    admin.suppliers.map(
      product.id,
      'fake',
      'fake-gi-60',
      { playerId: 'player_id', region: 'region' },
      { region: { us: 'os_usa', eu: 'os_euro' } },
    );
    await page.goto(`/catalog/games/${game.id}?tab=products`);
    await page
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: '60 كريستالة', exact: true }) })
      .getByRole('button', { name: ar.catalog.products.routes })
      .click();
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByText('eu → os_euro')).toBeVisible();
    await drawer.getByRole('button', { name: s.routes.editFields }).click();
    const dialog = page.getByRole('dialog', { name: s.routes.fieldsTitle });
    await dialog
      .getByRole('combobox', { name: fill(s.optionMap.target, { option: 'Europe' }) })
      .click();
    await page.getByRole('option', { name: 'Asia (os_asia)' }).click();
    await dialog.getByRole('button', { name: ar.catalog.actions.save }).click();
    await expect(dialog).toHaveCount(0);
    await expect(drawer.getByText('eu → os_asia')).toBeVisible();
  });
});

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('S16 PR 4 screenshots', async ({ page, admin }, testInfo) => {
      synced(admin);
      const game = genshin(admin, 'gi-shot', [
        ['us', 'America'],
        ['eu', 'أوروبا'],
      ]);
      await page.goto('/suppliers/fake?tab=catalog');
      await nodeAction(page, 'Genshin Impact', c.import);
      const options = page.getByRole('dialog').getByText('os_cht', { exact: true });
      await options.scrollIntoViewIfNeeded();
      await expect(options).toBeVisible();
      await screenshot(page, testInfo, `supplier-import-select-${colorScheme}`);
      await page.keyboard.press('Escape');

      const sheet = await linkTo(page, 'جنشن gi-shot');
      await expect(sheet.getByText(s.optionMap.title)).toBeVisible();
      await screenshot(page, testInfo, `supplier-link-options-${colorScheme}`);
      await page.keyboard.press('Escape');

      const product = admin.catalog.addProduct(game.id, { nameAr: '60 كريستالة' });
      admin.suppliers.map(
        product.id,
        'fake',
        'fake-gi-60',
        { playerId: 'player_id', region: 'region' },
        { region: { us: 'os_usa', eu: 'os_euro' } },
      );
      await page.goto(`/catalog/games/${game.id}?tab=products`);
      await page
        .getByRole('row')
        .filter({ has: page.getByRole('cell', { name: '60 كريستالة', exact: true }) })
        .getByRole('button', { name: ar.catalog.products.routes })
        .click();
      await page.getByRole('dialog').getByRole('button', { name: s.routes.editFields }).click();
      await expect(page.getByRole('dialog', { name: s.routes.fieldsTitle })).toBeVisible();
      await screenshot(page, testInfo, `route-option-map-${colorScheme}`);
    });
  });
}
