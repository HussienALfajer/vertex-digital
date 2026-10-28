import type { Page } from '@playwright/test';
import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import { type AdminApi, expect, screenshot, test } from './test';

/*
 * The catalog (S06, F08): categories, a game from creation to activation (rules CT3, CT6), its
 * input fields and products (CT4, CT5, CT8, CT9), archive and restore (CT1, CT2), against the
 * mocked API.
 */

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const field = (page: Page, label: string) =>
  page.getByLabel(label, { exact: true }).filter({ visible: true });

const fill = (text: string, values: Record<string, string>) =>
  Object.entries(values).reduce(
    (result, [key, value]) => result.replace(`{{${key}}}`, value),
    text,
  );

async function open(page: Page, admin: AdminApi, path: string) {
  admin.signedIn = true;
  await page.goto(path);
}

async function upload(page: Page, index: number) {
  await page
    .locator('input[type=file]')
    .nth(index)
    .setInputFiles({ name: 'image.png', mimeType: 'image/png', buffer: PNG });
}

/** A dialog's form: fills the labelled fields and submits. */
async function submitDialog(page: Page, values: Record<string, string>, submit: string) {
  const dialog = page.getByRole('dialog');
  for (const [label, value] of Object.entries(values)) {
    await dialog.getByLabel(label, { exact: true }).fill(value);
  }
  await dialog.getByRole('button', { name: submit }).click();
  await expect(dialog).toBeHidden();
}

const activeSwitch = (page: Page) =>
  page.getByRole('switch', { name: ar.catalog.game.active, exact: true });

const productRow = (page: Page, name: string) =>
  page.getByRole('row').filter({ has: page.getByRole('cell', { name, exact: true }) });

test.describe('catalog', () => {
  test('creates a game, refuses to activate it until it is complete, then activates it', async ({
    page,
    admin,
  }) => {
    await open(page, admin, '/catalog');
    for (const name of ['ألعاب', 'تطبيقات', 'بطاقات هدايا']) {
      await expect(page.getByRole('tab', { name })).toBeVisible();
    }
    await expect(page.getByText(ar.catalog.games.empty)).toBeVisible();

    // Step 1: a new game in ألعاب starts paused.
    await page.getByRole('link', { name: ar.catalog.games.add }).first().click();
    await field(page, ar.catalog.fields.nameAr).fill('ببجي موبايل');
    await field(page, ar.catalog.fields.nameEn).fill('PUBG Mobile');
    await field(page, ar.catalog.fields.slug).fill('Not A Slug');
    await page.getByRole('button', { name: ar.catalog.game.create }).click();
    await expect(page.getByText(ar.catalog.game.errors.slug)).toBeVisible();
    await field(page, ar.catalog.fields.slug).fill('pubg-mobile');
    await page.getByRole('button', { name: ar.catalog.game.create }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('ببجي موبايل');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(ar.catalog.statuses.paused);
    expect(admin.lastBody('POST /api/admin/catalog/games')).toMatchObject({
      slug: 'pubg-mobile',
      nameEn: 'PUBG Mobile',
      categoryId: admin.catalog.categories[0]?.id,
    });

    // Step 2: refused without a cover; then the images and the accent (rule CT6).
    await activeSwitch(page).click();
    await expect(
      page.getByText(fill(ar.catalog.game.missing, { items: ar.catalog.game.missingItems.cover })),
    ).toBeVisible();
    await expect(activeSwitch(page)).not.toBeChecked();
    await upload(page, 0);
    await upload(page, 1);
    await expect(page.getByRole('img', { name: ar.catalog.fields.cover })).toBeVisible();
    await expect(page.getByRole('img', { name: ar.catalog.fields.idGuide })).toBeVisible();
    await field(page, ar.catalog.fields.accent).fill('#102020');
    await expect(page.getByText('أقل من 3:1 ولن يُقبل')).toBeVisible();
    await page.getByRole('button', { name: ar.catalog.game.save }).click();
    await expect(page.getByText('والحد الأدنى 3:1')).toBeVisible();
    await field(page, ar.catalog.fields.accent).fill('#F2A900');
    await expect(page.getByText('مقبول')).toBeVisible();
    await page.getByRole('button', { name: ar.catalog.game.save }).click();
    await expect(page.getByText(ar.catalog.game.saved)).toBeVisible();
    expect(
      admin.lastBody(`PATCH /api/admin/catalog/games/${admin.catalog.games[0]?.id}`),
    ).toMatchObject({
      accentColor: '#F2A900',
      coverFileId: expect.any(String),
      idGuideFileId: expect.any(String),
    });

    // Step 3: a direct product needs a required field before activation.
    await page.getByRole('tab', { name: ar.catalog.game.tabs.products }).click();
    await page.getByRole('button', { name: ar.catalog.products.add }).click();
    await submitDialog(
      page,
      {
        [ar.catalog.products.name]: '60 UC',
        [ar.catalog.products.amount]: '60',
        [ar.catalog.products.official]: '0.99',
      },
      ar.catalog.products.addSubmit,
    );
    await expect(productRow(page, '60 UC')).toContainText(ar.catalog.availability.paused);
    await page.getByRole('tab', { name: ar.catalog.game.tabs.data }).click();
    await activeSwitch(page).click();
    await expect(
      page.getByText(
        fill(ar.catalog.game.missing, { items: ar.catalog.game.missingItems.input_fields }),
      ),
    ).toBeVisible();

    await page.getByRole('tab', { name: ar.catalog.game.tabs.fields }).click();
    await expect(page.getByText(ar.catalog.inputFields.empty)).toBeVisible();
    await page.getByRole('button', { name: ar.catalog.inputFields.add }).click();
    await submitDialog(
      page,
      {
        [ar.catalog.inputFields.key]: 'player_id',
        [ar.catalog.inputFields.label]: 'معرّف اللاعب',
        [ar.catalog.inputFields.minLength]: '5',
        [ar.catalog.inputFields.maxLength]: '15',
      },
      ar.catalog.inputFields.addSubmit,
    );
    await expect(page.getByRole('cell', { name: 'player_id' })).toBeVisible();
    expect(
      admin.lastBody(`POST /api/admin/catalog/games/${admin.catalog.games[0]?.id}/fields`),
    ).toEqual({
      key: 'player_id',
      type: 'digits',
      labelAr: 'معرّف اللاعب',
      helpAr: null,
      required: true,
      minLength: 5,
      maxLength: 15,
      options: null,
    });
    await page.getByRole('tab', { name: ar.catalog.game.tabs.data }).click();
    await activeSwitch(page).click();
    await expect(activeSwitch(page)).toBeChecked();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(ar.catalog.statuses.active);
  });

  test('adds, orders, pauses, archives and restores products', async ({ page, admin }) => {
    const game = admin.catalog.addGame({
      categorySlug: 'games',
      slug: 'pubg-mobile',
      nameAr: 'ببجي موبايل',
      nameEn: 'PUBG Mobile',
      status: 'active',
      cover: true,
    });
    admin.catalog.addField(game.id, { key: 'player_id', labelAr: 'معرّف اللاعب' });
    admin.catalog.addProduct(game.id, { nameAr: '60 UC', gameAmount: 60 });
    await open(page, admin, `/catalog/games/${game.id}?tab=products`);

    // Step 4.
    for (const [name, amount] of [
      ['325 UC', '325'],
      ['660 UC', '660'],
    ]) {
      await page.getByRole('button', { name: ar.catalog.products.add }).click();
      await submitDialog(
        page,
        {
          [ar.catalog.products.name]: name as string,
          [ar.catalog.products.amount]: amount as string,
        },
        ar.catalog.products.addSubmit,
      );
    }
    const rows = page.getByRole('table').getByRole('row');
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(1)).toContainText(ar.catalog.availability.out_of_stock);

    await page.getByRole('button', { name: fill(ar.catalog.order.up, { name: '660 UC' }) }).click();
    await expect(rows.nth(2)).toContainText('660 UC');
    expect(
      (
        admin.lastBody(`PUT /api/admin/catalog/games/${game.id}/products/order`) as {
          ids: string[];
        }
      ).ids,
    ).toHaveLength(3);

    await productRow(page, '325 UC')
      .getByRole('button', { name: ar.catalog.actions.pause })
      .click();
    await expect(productRow(page, '325 UC')).toContainText(ar.catalog.availability.paused);
    await productRow(page, '660 UC')
      .getByRole('button', { name: ar.catalog.actions.archive })
      .click();
    // Audit A7: an archive asks first, naming the pack.
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText(fill(ar.catalog.products.archiveBody, { name: '660 UC' }));
    await confirm.getByRole('button', { name: ar.catalog.actions.archive }).click();
    await expect(confirm).toBeHidden();
    await expect(rows).toHaveCount(3);
    await page.getByRole('tab', { name: ar.catalog.filters.archived, exact: true }).click();
    await expect(productRow(page, '660 UC')).toBeVisible();
    await productRow(page, '660 UC')
      .getByRole('button', { name: ar.catalog.actions.restore })
      .click();
    await expect(page.getByText(ar.catalog.products.noneArchived)).toBeVisible();
    await page.getByRole('tab', { name: ar.catalog.filters.live, exact: true }).click();
    await expect(rows).toHaveCount(4);

    // Rule CT3: the last required field of an active game with direct products stays.
    await page.getByRole('tab', { name: ar.catalog.game.tabs.fields }).click();
    await page
      .getByRole('row')
      .filter({ hasText: 'player_id' })
      .getByRole('button', { name: ar.catalog.actions.archive })
      .click();
    await confirm.getByRole('button', { name: ar.catalog.actions.archive }).click();
    await expect(
      confirm.getByText(
        fill(ar.catalog.game.missing, { items: ar.catalog.game.missingItems.input_fields }),
      ),
    ).toBeVisible();
  });

  test('adds a code product with its region and instructions (step 5)', async ({ page, admin }) => {
    const game = admin.catalog.addGame({
      categorySlug: 'gift-cards',
      slug: 'itunes',
      nameAr: 'آيتونز',
      nameEn: 'iTunes',
    });
    await open(page, admin, `/catalog/games/${game.id}?tab=products`);
    await page.getByRole('button', { name: ar.catalog.products.add }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: ar.catalog.products.kinds.code }).click();
    await expect(dialog.getByLabel(ar.catalog.products.maxQuantity)).toHaveValue('10');
    await submitDialog(
      page,
      {
        [ar.catalog.products.name]: 'بطاقة 10$',
        [ar.catalog.products.region]: 'الولايات المتحدة',
        [ar.catalog.products.redemption]: 'افتح متجر التطبيقات واستخدم الكود.',
      },
      ar.catalog.products.addSubmit,
    );
    await expect(productRow(page, 'بطاقة 10$')).toContainText(ar.catalog.products.kinds.code);
    expect(admin.lastBody(`POST /api/admin/catalog/games/${game.id}/products`)).toMatchObject({
      kind: 'code',
      maxQuantity: 10,
      regionAr: 'الولايات المتحدة',
    });
  });

  test('orders games, refuses to archive a category with games, adds a category', async ({
    page,
    admin,
  }) => {
    for (const [slug, nameAr, nameEn] of [
      ['pubg-mobile', 'ببجي موبايل', 'PUBG Mobile'],
      ['free-fire', 'فري فاير', 'Free Fire'],
    ]) {
      admin.catalog.addGame({
        categorySlug: 'games',
        slug: slug as string,
        nameAr: nameAr as string,
        nameEn: nameEn as string,
      });
    }
    await open(page, admin, '/catalog');
    const cards = page.getByRole('listitem');
    await expect(cards.first()).toContainText('ببجي موبايل');
    await page
      .getByRole('button', { name: fill(ar.catalog.order.down, { name: 'ببجي موبايل' }) })
      .click();
    await expect(cards.first()).toContainText('فري فاير');

    // Filters and search live in the URL; the move buttons need the full list.
    await page.getByRole('searchbox').fill('free');
    await page.getByRole('button', { name: ar.catalog.search.submit }).click();
    await expect(page).toHaveURL(/q=free/);
    await expect(cards).toHaveCount(1);
    await expect(
      page.getByRole('button', { name: fill(ar.catalog.order.up, { name: 'فري فاير' }) }),
    ).toBeHidden();

    // Step 9: rule CT2 names the games left.
    await page.getByRole('button', { name: ar.catalog.categories.manage }).click();
    const dialog = page.getByRole('dialog');
    await dialog
      .getByRole('listitem')
      .filter({ has: page.getByText('ألعاب', { exact: true }) })
      .getByRole('button', { name: ar.catalog.actions.archive })
      .click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: ar.catalog.actions.archive })
      .click();
    await expect(page.getByRole('alertdialog')).toContainText('فري فاير');
    await page.getByRole('alertdialog').getByRole('button', { name: ar.common.cancel }).click();

    await dialog.getByLabel(ar.catalog.categories.name).fill('اشتراكات');
    await dialog.getByLabel(ar.catalog.fields.slug).fill('games');
    await dialog.getByRole('button', { name: ar.catalog.categories.addSubmit }).click();
    await expect(dialog.getByText(ar.errors.api.SLUG_TAKEN)).toBeVisible();
    await dialog.getByLabel(ar.catalog.fields.slug).fill('subscriptions');
    await dialog.getByRole('button', { name: ar.catalog.categories.addSubmit }).click();
    await expect(dialog.getByRole('listitem').filter({ hasText: 'اشتراكات' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('tab', { name: 'اشتراكات' })).toBeVisible();
  });

  test('lists and orders a category of more than one page of games (audit A4)', async ({
    page,
    admin,
  }) => {
    for (let index = 1; index <= 101; index += 1) {
      admin.catalog.addGame({
        categorySlug: 'games',
        slug: `game-${index}`,
        nameAr: `لعبة ${index}`,
        nameEn: `Game ${index}`,
      });
    }
    await open(page, admin, '/catalog');
    const cards = page.getByRole('listitem');
    await expect(cards).toHaveCount(101);
    await expect(cards.last()).toContainText('لعبة 101');
    // The reorder sends all 101 ids: a partial list would be refused.
    await page
      .getByRole('button', { name: fill(ar.catalog.order.up, { name: 'لعبة 101' }) })
      .click();
    await expect(cards.nth(99)).toContainText('لعبة 101');
    await expect(cards.last()).toContainText('لعبة 100');
  });
});

test.describe('search terms (S09 rule AD1)', () => {
  test('adds terms as chips, refuses a duplicate after normalization, removes one and saves', async ({
    page,
    admin,
  }) => {
    const game = admin.catalog.addGame({
      categorySlug: 'games',
      slug: 'pubg-mobile',
      nameAr: 'ببجي موبايل',
      nameEn: 'PUBG Mobile',
    });
    await open(page, admin, `/catalog/games/${game.id}`);
    const input = page.getByLabel(ar.catalog.searchTerms.label, { exact: true });
    const terms = page.getByRole('list', { name: ar.catalog.searchTerms.list });
    for (const typed of ['PUBG', 'بَبجي', 'بوبجي']) {
      await input.fill(typed);
      await input.press('Enter');
    }
    await expect(terms.getByRole('listitem')).toHaveText(['pubg', 'ببجي', 'بوبجي']);
    await input.fill('ببجى');
    await input.press('Enter');
    await expect(page.getByText(ar.catalog.searchTerms.refused.duplicate)).toBeVisible();
    await page
      .getByRole('button', { name: fill(ar.catalog.searchTerms.remove, { term: 'بوبجي' }) })
      .click();
    await expect(terms.getByRole('listitem')).toHaveText(['pubg', 'ببجي']);
    await page.getByRole('button', { name: ar.catalog.game.save }).click();
    await expect(page.getByText(ar.catalog.game.saved)).toBeVisible();
    expect(admin.lastBody(`PATCH /api/admin/catalog/games/${game.id}`)).toMatchObject({
      searchTerms: ['pubg', 'ببجي'],
    });
    await page.reload();
    await expect(
      page.getByRole('list', { name: ar.catalog.searchTerms.list }).getByRole('listitem'),
    ).toHaveText(['pubg', 'ببجي']);

    // A term typed without Enter is kept when "حفظ" is pressed (audit A03-25).
    await page.getByLabel(ar.catalog.searchTerms.label, { exact: true }).fill('ببجي موبايل');
    await page.getByRole('button', { name: ar.catalog.game.save }).click();
    await expect(page.getByText(ar.catalog.game.saved)).toBeVisible();
    expect(admin.lastBody(`PATCH /api/admin/catalog/games/${game.id}`)).toMatchObject({
      searchTerms: ['pubg', 'ببجي', 'ببجي موبايل'],
    });
  });
});

test.describe('the game form (audit A03)', () => {
  /** An active, complete game: cover, a required field and a direct pack. */
  function activeGame(admin: AdminApi) {
    const game = admin.catalog.addGame({
      categorySlug: 'games',
      slug: 'pubg-mobile',
      nameAr: 'ببجي موبايل',
      nameEn: 'PUBG Mobile',
      status: 'active',
      cover: true,
    });
    admin.catalog.addField(game.id, { key: 'player_id', labelAr: 'معرّف اللاعب' });
    admin.catalog.addProduct(game.id, { nameAr: '60 UC', gameAmount: 60 });
    return game;
  }

  test('keeps what was typed across the tabs and asks before leaving it (A03-12)', async ({
    page,
    admin,
  }) => {
    const game = activeGame(admin);
    await open(page, admin, `/catalog/games/${game.id}`);
    await field(page, ar.catalog.fields.nameAr).fill('ببجي موبايل الجديدة');
    await page.getByRole('tab', { name: ar.catalog.game.tabs.products }).click();
    await page.getByRole('tab', { name: ar.catalog.game.tabs.data }).click();
    await expect(field(page, ar.catalog.fields.nameAr)).toHaveValue('ببجي موبايل الجديدة');

    await page.getByRole('link', { name: ar.catalog.game.back }).click();
    const leave = page.getByRole('alertdialog');
    await expect(leave).toContainText(ar.catalog.game.leave.body);
    await leave.getByRole('button', { name: ar.common.cancel }).click();
    await expect(page).toHaveURL(`/catalog/games/${game.id}`);
    await page.getByRole('button', { name: ar.catalog.game.save }).click();
    await expect(page.getByText(ar.catalog.game.saved)).toBeVisible();
    // Saved: leaving asks nothing.
    await page.getByRole('link', { name: ar.catalog.game.back }).click();
    await expect(page).toHaveURL('/catalog');
  });

  test('an active game saved without its cover says so under the cover (A03-13)', async ({
    page,
    admin,
  }) => {
    const game = activeGame(admin);
    await open(page, admin, `/catalog/games/${game.id}`);
    await page.getByRole('button', { name: ar.catalog.image.remove }).first().click();
    await page.getByRole('button', { name: ar.catalog.game.save }).click();
    await expect(page.getByText(ar.catalog.game.coverRequired)).toBeVisible();
    await expect(page.getByText(ar.errors.api.CATALOG_INCOMPLETE)).toHaveCount(0);
  });

  test('refuses an image of another type before sending it (A03-27)', async ({ page, admin }) => {
    const game = activeGame(admin);
    await open(page, admin, `/catalog/games/${game.id}`);
    await page
      .locator('input[type=file]')
      .first()
      .setInputFiles({ name: 'cover.gif', mimeType: 'image/gif', buffer: PNG });
    await expect(page.getByText(ar.errors.api.IMAGE_INVALID)).toBeVisible();
    expect(admin.lastBody('POST /api/admin/catalog/images')).toBeUndefined();
  });

  test('a failed categories read offers a retry, in the form and in the dialog (A03-14, A03-15)', async ({
    page,
    admin,
  }) => {
    const game = activeGame(admin);
    admin.signedIn = true;
    // The first read and TanStack's two retries of a server fault.
    await page.route(
      /\/api\/admin\/catalog\/categories(\?|$)/,
      (route) => route.fulfill({ status: 500, json: { code: 'INTERNAL_ERROR' } }),
      { times: 3 },
    );
    await page.goto(`/catalog/games/${game.id}`);
    await expect(page.getByText(ar.catalog.game.archivedCategoryName)).toHaveCount(0);
    await page.getByRole('button', { name: ar.common.retry }).click();
    await expect(page.getByRole('combobox', { name: ar.catalog.fields.category })).toContainText(
      'ألعاب',
    );

    // The dialog's own read: the archived categories.
    await page.goto('/catalog');
    await page.getByRole('button', { name: ar.catalog.categories.manage }).click();
    const dialog = page.getByRole('dialog');
    await page.route(
      /\/api\/admin\/catalog\/categories\?archived=true/,
      (route) => route.fulfill({ status: 500, json: { code: 'INTERNAL_ERROR' } }),
      { times: 3 },
    );
    await dialog.getByRole('tab', { name: ar.catalog.filters.archived, exact: true }).click();
    await dialog.getByRole('button', { name: ar.common.retry }).click();
    await expect(dialog.getByText(ar.catalog.categories.noneArchived)).toBeVisible();
  });

  test('a failed price lists read offers a retry above the packs, never "no price"', async ({
    page,
    admin,
  }) => {
    const game = activeGame(admin);
    admin.signedIn = true;
    // The first read and TanStack's two retries of a server fault.
    await page.route(
      /\/api\/admin\/pricing\/matrix(\?|$)/,
      (route) => route.fulfill({ status: 500, json: { code: 'INTERNAL_ERROR' } }),
      { times: 3 },
    );
    await page.goto(`/catalog/games/${game.id}`);
    await page.getByRole('tab', { name: ar.catalog.game.tabs.products }).click();
    await page.getByRole('button', { name: ar.common.retry }).click();
    await expect(page.getByRole('button', { name: ar.common.retry })).toHaveCount(0);
    await expect(page.getByText('الجملة').first()).toBeVisible();
  });
});

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('the catalog and the game page tabs', async ({ page, admin }, testInfo) => {
      const game = admin.catalog.addGame({
        categorySlug: 'games',
        slug: 'pubg-mobile',
        nameAr: 'ببجي موبايل',
        nameEn: 'PUBG Mobile',
        status: 'active',
        cover: true,
      });
      admin.catalog.addGame({
        categorySlug: 'games',
        slug: 'free-fire',
        nameAr: 'فري فاير',
        nameEn: 'Free Fire',
      });
      admin.catalog.addField(game.id, {
        key: 'player_id',
        labelAr: 'معرّف اللاعب',
        minLength: 5,
        maxLength: 15,
      });
      for (const [name, amount, official] of [
        ['60 UC', 60, 990_000],
        ['325 UC', 325, 4_990_000],
      ] as const) {
        admin.catalog.addProduct(game.id, {
          nameAr: name,
          gameAmount: amount,
          officialPriceUsdUnits: official,
        });
      }
      Object.assign(admin.catalog.games[0] ?? {}, {
        accentColor: '#F2A900',
        searchTerms: ['ببجي', 'pubg', 'بوبجي'],
      });

      await open(page, admin, '/catalog');
      await expect(page.getByRole('listitem').first()).toContainText('ببجي موبايل');
      await screenshot(page, testInfo, `catalog-${colorScheme}`, { fullPage: true });

      await page.getByRole('tab', { name: 'تطبيقات' }).click();
      await expect(page.getByText(ar.catalog.games.empty)).toBeVisible();
      await screenshot(page, testInfo, `catalog-empty-${colorScheme}`);

      await page.getByRole('button', { name: ar.catalog.categories.manage }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await screenshot(page, testInfo, `catalog-categories-${colorScheme}`);
      await page.keyboard.press('Escape');

      await page.goto(`/catalog/games/${game.id}`);
      await expect(page.getByText('مقبول')).toBeVisible();
      await screenshot(page, testInfo, `game-data-${colorScheme}`, { fullPage: true });
      for (const tab of ['fields', 'products', 'pricing'] as const) {
        await page.getByRole('tab', { name: ar.catalog.game.tabs[tab] }).click();
        await expect(page.getByRole('table')).toBeVisible();
        await screenshot(page, testInfo, `game-${tab}-${colorScheme}`, { fullPage: true });
      }
      await page.getByRole('tab', { name: ar.catalog.game.tabs.products }).click();
      // S22 PA8: customers waiting for a pack.
      const waiting = admin.catalog.products.find((item) => item.gameId === game.id);
      if (waiting) admin.catalog.waitingAlerts.set(waiting.id, 3);
      await page.reload();
      await expect(
        page.getByText(fill(ar.catalog.products.waitingAlerts, { count: '3' })).first(),
      ).toBeVisible();
      await screenshot(page, testInfo, `game-products-waiting-${colorScheme}`, { fullPage: true });
      await page.getByRole('button', { name: ar.catalog.products.add }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await screenshot(page, testInfo, `game-product-dialog-${colorScheme}`);
    });

    test('every list’s price per pack, estimated for a pack with no usable route', async ({
      page,
      admin,
    }, testInfo) => {
      const game = admin.catalog.addGame({
        categorySlug: 'games',
        slug: 'pubg-mobile',
        nameAr: 'ببجي موبايل',
        nameEn: 'PUBG Mobile',
      });
      const priced = admin.catalog.addProduct(game.id, { nameAr: '60 UC', gameAmount: 60 });
      const paused = admin.catalog.addProduct(game.id, { nameAr: '325 UC', gameAmount: 325 });
      admin.catalog.pricing = (productId) => ({
        price:
          productId === priced.id ? { priceUsdUnits: 1_100_000, minMarginUsdUnits: 100_000 } : null,
        usableRouteCostsUsdUnits: productId === priced.id ? [1_000_000] : [],
        basisSupplierNameAr: productId === priced.id ? 'WDGZone' : null,
        basisCostUsdUnits: productId === priced.id ? 1_000_000 : null,
        basisStockLevel: null,
        priceHeld: false,
        routed: productId === priced.id,
        reviewOpen: false,
      });
      admin.priceLists.estimates.set(paused.id, {
        costUsdUnits: 4_390_000,
        supplierCode: 'wdgzone',
        reason: 'balance_low',
      });

      await open(page, admin, `/catalog/games/${game.id}`);
      await page.getByRole('tab', { name: ar.catalog.game.tabs.products }).click();
      const row = (name: string) => page.getByRole('row').filter({ hasText: name });
      // A priced pack: retail, then the other lists with their profit, no estimate.
      await expect(row('60 UC')).toContainText('$1.10');
      await expect(row('60 UC').getByText('الجملة')).toBeVisible();
      await expect(row('60 UC').getByText(ar.catalog.products.estimated)).toHaveCount(0);
      // A pack never priced: the cheapest route's cost and every list's price, as estimates.
      const estimated = row('325 UC');
      await expect(estimated).toContainText('$4.39');
      await expect(estimated.getByText(ar.suppliers.routes.unusable.balance_low)).toBeVisible();
      await expect(estimated.getByText(ar.catalog.products.estimatedHint)).toBeVisible();
      await expect(estimated.getByText(ar.catalog.products.estimated)).toHaveCount(4);
      await expect(estimated.getByText(ar.catalog.products.noPrice)).toHaveCount(0);
      await screenshot(page, testInfo, `game-products-lists-${colorScheme}`, { fullPage: true });
    });
  });
}
