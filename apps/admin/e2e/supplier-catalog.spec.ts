import type { Page } from '@playwright/test';
import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import { type AdminApi, expect, screenshot, test } from './test';

/*
 * The supplier catalog panel (S16 SC4–SC11, IM3, SF1–SF5): the fake's tree with its states, the
 * import of a category as a new paused game, "تفعيل الكل", new packs and their badge, the link to
 * an existing game, the statement matched to our orders, nearby supplier orders and the game page
 * additions, against the mocked API (`supplier-catalog-mock.ts`). Acceptance steps 7–11.
 */

const s = ar.suppliers;
const c = s.catalog;

const fill = (text: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{{${key}}}`, String(value)),
    text,
  );

/** The fake supplier synced, as after its keys were set. */
function synced(admin: AdminApi) {
  admin.signedIn = true;
  admin.suppliers.connectFake();
}

/** An existing Free Fire game with its player id field and "100 ماسة" (the link's target). */
function freeFire(admin: AdminApi) {
  const game = admin.catalog.addGame({
    categorySlug: 'games',
    slug: 'free-fire',
    nameAr: 'فري فاير',
    nameEn: 'Free Fire',
    status: 'active',
    cover: true,
  });
  admin.catalog.addField(game.id, { key: 'player_id', labelAr: 'معرّف اللاعب' });
  const product = admin.catalog.addProduct(game.id, { nameAr: '100 ماسة', gameAmount: 100 });
  return { game, product };
}

const node = (page: Page, name: string) =>
  page.getByRole('listitem').filter({ has: page.getByRole('link', { name, exact: true }) });

async function nodeAction(page: Page, name: string, action: string) {
  await page.getByRole('button', { name: fill(c.actions, { name }) }).click();
  await page.getByRole('menuitem', { name: action }).click();
}

test.describe('supplier catalog', () => {
  test('shows the tree with thumbnails, states and children on expand (SC4, SC5, IM1)', async ({
    page,
    admin,
  }) => {
    synced(admin);
    await page.goto('/suppliers/fake?tab=catalog');
    for (const name of ['PUBG Mobile', 'Free Fire', 'Gift cards']) {
      await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
    }
    await expect(
      node(page, 'PUBG Mobile').first().getByText(c.states.not_imported, { exact: true }),
    ).toBeVisible();
    await expect(node(page, 'PUBG Mobile').first().locator('img')).toBeVisible();
    await page.getByRole('button', { name: fill(c.expand, { name: 'PUBG Mobile' }) }).click();
    await expect(page.getByRole('link', { name: 'Global', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'MENA', exact: true })).toBeVisible();
    // S19: the supplier's note on a category is shown under it, as text.
    await page.getByRole('button', { name: fill(c.expand, { name: 'Free Fire' }) }).click();
    await expect(page.getByText(/^Region: MENA/)).toBeVisible();

    // A search lists nodes at any depth with their path.
    await page.getByLabel(c.search).fill('mena');
    await page.getByRole('button', { name: c.searchSubmit }).click();
    await expect(page).toHaveURL(/cq=mena/);
    await expect(page.getByText('PUBG Mobile', { exact: true })).toBeVisible();
  });

  test('imports PUBG Mobile as a paused game with two subcategories, then activates all (SC7, SC10)', async ({
    page,
    admin,
  }) => {
    synced(admin);
    await page.goto('/suppliers/fake?tab=catalog');
    await nodeAction(page, 'PUBG Mobile', c.import);
    const sheet = page.getByRole('dialog');
    await expect(
      sheet.getByText(fill(s.importCategory.title, { name: 'PUBG Mobile' })),
    ).toBeVisible();
    // The suggested field from the supplier's "playerId", with its key beside it.
    await expect(sheet.getByText('playerId', { exact: true })).toBeVisible();
    await sheet.getByLabel(s.importCategory.nameAr).fill('ببجي موبايل');
    // Packs of both subcategories, the names suggested with the leaf (SC13).
    await expect(sheet.getByText('Global', { exact: true })).toBeVisible();
    await expect(sheet.getByText('MENA', { exact: true })).toBeVisible();
    const uc60 = sheet.getByRole('textbox', { name: 'Fake UC 60', exact: true });
    await expect(uc60).toHaveValue('Fake UC 60 · Global');
    await uc60.fill('60 UC');
    // The original price and its discount (SF1).
    await expect(
      sheet.getByText(fill(s.offers.discount, { percent: '\u206611%\u2069' })).first(),
    ).toBeVisible();

    // Ignored meanwhile: nothing is created and the row shows why.
    const ignored = admin.suppliers.offers.find((offer) => offer.offerId === 'fake-uc-325');
    if (!ignored) throw new Error('No fake-uc-325');
    ignored.ignoredAt = new Date().toISOString();
    await sheet.getByRole('button', { name: fill(s.importCategory.submit, { count: 4 }) }).click();
    await expect(sheet.getByText(s.importCategory.refused)).toBeVisible();
    await expect(sheet.getByText(ar.errors.api.OFFER_IGNORED)).toBeVisible();
    expect(admin.catalog.games.some((game) => game.slug === 'pubg-mobile')).toBe(false);
    // The draft is read again: the ignored pack is no longer selected and cannot be.
    const uc325 = sheet.getByRole('checkbox', {
      name: fill(s.importCategory.selectPack, { name: 'Fake UC 325' }),
    });
    await expect(uc325).not.toBeChecked();
    await expect(uc325).toBeDisabled();
    await sheet.getByRole('button', { name: fill(s.importCategory.submit, { count: 3 }) }).click();
    await expect(sheet.getByText(s.importCategory.done)).toBeVisible();
    const game = admin.catalog.games.find((item) => item.slug === 'pubg-mobile');
    expect(game?.status).toBe('paused');
    const products = admin.catalog.products.filter((item) => item.gameId === game?.id);
    expect(products.map((item) => [item.nameAr, item.status])).toEqual([
      ['60 UC', 'paused'],
      ['Fake UC 660 · MENA', 'paused'],
      ['Fake UC 1800 · MENA', 'paused'],
    ]);

    await sheet.getByRole('button', { name: s.activateAll.button }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(
      confirm.getByText(fill(s.activateAll.body, { count: 3, game: s.activateAll.andGame })),
    ).toBeVisible();
    await confirm.getByRole('button', { name: s.activateAll.confirm }).click();
    const result = page.getByRole('dialog', { name: s.activateAll.doneTitle });
    await expect(result.getByText(fill(s.activateAll.activated, { count: 3 }))).toBeVisible();
    expect(game?.status).toBe('active');
    expect(products.every((item) => item.status === 'active')).toBe(true);
  });

  test('a new pack in an imported category raises the badge until it is ignored (SC6, SC11)', async ({
    page,
    admin,
  }) => {
    synced(admin);
    const { game } = freeFire(admin);
    admin.supplierCatalog.link('fake-ff', game.id);
    for (const offer of admin.suppliers.offers.filter(
      (item) => item.categoryId === 'fake-ff-auto',
    )) {
      offer.ignoredAt = new Date().toISOString();
    }
    admin.supplierCatalog.addOffer('fake-ff-auto', 'Fake Free Fire 2180', 19);
    await page.goto('/suppliers/fake?tab=catalog');
    const nav = page.getByRole('link', { name: ar.nav.suppliers });
    await expect(nav.getByText('1', { exact: true })).toBeVisible();
    await expect(
      node(page, 'Free Fire')
        .first()
        .getByText(fill(c.newPacks, { count: 1 })),
    ).toBeVisible();

    // S18: the category opens on a page of its own, with its packs.
    await page.getByRole('link', { name: 'Free Fire', exact: true }).click();
    await expect(page).toHaveURL(/\/suppliers\/fake\/categories\/fake-ff$/);
    await expect(page.getByRole('heading', { name: 'Free Fire' })).toBeVisible();
    await page
      .getByRole('button', { name: fill(s.offers.ignore, { name: 'Fake Free Fire 2180' }) })
      .click();
    await expect(nav.getByText('1', { exact: true })).toBeHidden();
    await page.getByRole('link', { name: s.category.back }).click();
    await expect(page).toHaveURL(/tab=catalog/);
    await expect(
      node(page, 'Free Fire').first().getByText(c.states.linked, { exact: true }),
    ).toBeVisible();
  });

  test('links Free Fire to an existing game: one existing pack, one new, the rest left out (SC8)', async ({
    page,
    admin,
  }, testInfo) => {
    synced(admin);
    const { game, product } = freeFire(admin);
    // S17 WR1, WR7: the pack has a fake route already, so its new one is pre-set not to count.
    const before = admin.suppliers.map(product.id, 'fake', 'fake-uc-60');
    await page.goto('/suppliers/fake?tab=catalog');
    await nodeAction(page, 'Free Fire', c.link);
    const sheet = page.getByRole('dialog');
    await sheet.getByRole('combobox', { name: s.linkCategory.game }).click();
    await page.getByRole('option', { name: 'فري فاير', exact: true }).click();
    // The proposed match: the pack with the same game amount.
    await expect(sheet.getByText(s.linkCategory.proposed)).toBeVisible();
    const counts = sheet.getByRole('checkbox', { name: s.routes.settings.priceBasis });
    await expect(counts).toHaveCount(1);
    await expect(counts).not.toBeChecked();
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await screenshot(page, testInfo, `supplier-link-price-basis-${colorScheme}`);
    }
    for (const name of ['Fake Free Fire 520', 'Fake Free Fire 1060']) {
      await sheet.getByRole('combobox', { name: fill(s.linkCategory.mode, { name }) }).click();
      await page.getByRole('option', { name: s.linkCategory.modes.skip, exact: true }).click();
      await expect(page.getByRole('listbox')).toHaveCount(0);
    }
    await sheet
      .getByRole('textbox', {
        name: fill(s.importCategory.packName, { name: 'Fake Free Fire 310' }),
      })
      .fill('310 ماسة');
    await sheet.getByRole('button', { name: fill(s.linkCategory.submit, { count: 2 }) }).click();
    await expect(sheet.getByText(s.linkCategory.done)).toBeVisible();
    await expect(
      sheet.getByText(fill(s.linkCategory.doneHint, { routed: 1, created: 1 })),
    ).toBeVisible();
    const routes = admin.suppliers.routes.filter((route) => route.productId === product.id);
    expect(routes.map((route) => [route.id === before.id, route.priceBasis])).toEqual([
      [true, true],
      [false, false],
    ]);
    expect(
      admin.catalog.products.find((item) => item.gameId === game.id && item.nameAr === '310 ماسة')
        ?.status,
    ).toBe('paused');
  });

  test('the statement links matched orders and marks the unmatched one (SF3)', async ({
    page,
    admin,
  }) => {
    synced(admin);
    const delivered = admin.orders.orders.find((order) => order.number === 'VO-DONE67');
    if (!delivered) throw new Error('No VO-DONE67');
    admin.supplierCatalog.statementOrders = [
      {
        supplierOrderId: 'S-3',
        offerId: 'fake-uc-60',
        offerName: 'Fake UC 60',
        quantity: 1,
        status: 'completed',
        totalUsdUnits: 880_000,
        createdAt: new Date().toISOString(),
        completedAt: null,
        match: {
          orderId: delivered.id,
          orderNumber: 'VO-DONE67',
          orderStatus: 'delivered',
          attemptId: delivered.attempts[0]?.id as string,
          attemptStatus: 'delivered',
        },
      },
      {
        supplierOrderId: 'S-900',
        offerId: 'fake-uc-325',
        offerName: 'Fake UC 325',
        quantity: 1,
        status: 'completed',
        totalUsdUnits: 4_400_000,
        createdAt: new Date().toISOString(),
        completedAt: null,
        match: null,
      },
    ];
    admin.supplierCatalog.transactions = [
      {
        id: 'T-1',
        type: 'order',
        amountUsdUnits: -880_000,
        balanceAfterUsdUnits: 120_000_000,
        reference: 'Order S-3',
        supplierOrderId: 'S-3',
        createdAt: new Date().toISOString(),
        match: null,
      },
    ];
    await page.goto('/suppliers/fake?tab=statement');
    await expect(page.getByRole('link', { name: 'VO-DONE67' })).toBeVisible();
    await expect(page.getByText(s.statement.unmatched)).toBeVisible();
    await page.getByRole('tab', { name: s.statement.transactions }).click();
    await expect(page).toHaveURL(/list=transactions/);
    await expect(page.getByText('Order S-3')).toBeVisible();
  });

  test('reads the nearby supplier orders of a held attempt, saying when the read is incomplete (SF4)', async ({
    page,
    admin,
  }) => {
    admin.signedIn = true;
    const held = admin.orders.orders.find((order) => order.number === 'VO-HELD23');
    if (!held) throw new Error('No VO-HELD23');
    admin.supplierCatalog.nearby = {
      complete: false,
      items: [
        {
          supplierOrderId: 'W-77',
          offerId: 'wdgzone-offer',
          offerName: 'UC 60',
          quantity: 1,
          status: 'completed',
          totalUsdUnits: 880_000,
          createdAt: new Date().toISOString(),
          completedAt: null,
          match: null,
        },
      ],
    };
    await page.goto(`/orders/${held.id}`);
    await page.getByRole('button', { name: ar.orders.nearby.read }).click();
    await expect(page.getByText('W-77')).toBeVisible();
    await expect(page.getByText(ar.orders.nearby.free)).toBeVisible();
    await expect(page.getByText(ar.orders.nearby.incomplete)).toBeVisible();

    // Back on the order later: the old read is gone until the admin reads again.
    await page.getByRole('main').getByRole('link', { name: ar.orders.back }).click();
    await expect(page).toHaveURL(/\/orders$/);
    await expect(page.getByRole('heading', { name: ar.orders.title, level: 1 })).toBeVisible();
    await expect(page.getByText(ar.orders.nearby.title)).toBeHidden();
    await page.goBack();
    await expect(page.getByRole('button', { name: ar.orders.nearby.read })).toBeVisible();
    await expect(page.getByText('W-77')).toBeHidden();
  });

  test('the game page lists its supplier categories, unlinks one and takes the supplier cover (SC9, IM3, SF2)', async ({
    page,
    admin,
  }) => {
    synced(admin);
    const { game, product } = freeFire(admin);
    admin.supplierCatalog.link('fake-ff', game.id);
    admin.suppliers.map(product.id, 'fake', 'fake-ff-100', { playerId: 'player_id' });
    admin.suppliers.script('fake-ff-100', { stock: 4 });
    admin.suppliers.runSync('fake');
    await page.goto(`/catalog/games/${game.id}?tab=products`);
    await expect(page.getByRole('link', { name: 'Free Fire', exact: true })).toBeVisible();
    await expect(page.getByText(s.stock.low, { exact: true }).first()).toBeVisible();

    await page.goto(`/catalog/games/${game.id}`);
    const before = game.coverFileId;
    await page
      .getByRole('button', { name: s.gameLinks.cover.replace('{{supplier}}', s.names.fake) })
      .click();
    await expect.poll(() => game.coverFileId).not.toBe(before);

    await page.goto(`/catalog/games/${game.id}?tab=products`);
    await page.getByRole('button', { name: c.unlink }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: c.unlink }).click();
    await expect(page.getByText(s.gameLinks.none)).toBeVisible();
    expect(
      admin.supplierCatalog.categories.find((row) => row.categoryId === 'fake-ff')?.gameId,
    ).toBe(null);
  });

  test('Save waits for the supplier cover; a failed read of the linked categories retries (audit A03-20, A03-16)', async ({
    page,
    admin,
  }) => {
    synced(admin);
    const { game } = freeFire(admin);
    admin.supplierCatalog.link('fake-ff', game.id);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/cover\/from-supplier$/, async (route) => {
      await held;
      await route.fallback();
    });
    await page.goto(`/catalog/games/${game.id}`);
    await page
      .getByRole('button', { name: s.gameLinks.cover.replace('{{supplier}}', s.names.fake) })
      .click();
    const save = page.getByRole('button', { name: ar.catalog.game.save });
    await expect(save).toBeDisabled();
    release();
    await expect(save).toBeEnabled();

    // The first read and TanStack's two retries of a server fault.
    await page.route(
      /\/supplier-categories$/,
      (route) => route.fulfill({ status: 500, json: { code: 'INTERNAL_ERROR' } }),
      { times: 3 },
    );
    await page.goto(`/catalog/games/${game.id}?tab=products`);
    await page.getByRole('button', { name: ar.common.retry }).click();
    await expect(page.getByRole('link', { name: 'Free Fire', exact: true })).toBeVisible();
  });

  test('S18: links an offer to a suggested pack in a few clicks', async ({ page, admin }) => {
    synced(admin);
    const { game, product } = freeFire(admin);
    admin.supplierCatalog.link('fake-ff', game.id);
    await page.goto('/suppliers/fake/categories/fake-ff');
    await page
      .getByRole('button', { name: fill(s.offers.link, { name: 'Fake Free Fire 100' }) })
      .click();
    const dialog = page.getByRole('dialog');
    const suggested = dialog.getByRole('button', { name: /100 ماسة/ });
    await expect(suggested.getByText(s.link.reasons.amount)).toBeVisible();
    await suggested.click();
    // The route form opens with the offer chosen already.
    await expect(dialog.getByText(s.link.offer)).toBeVisible();
    await dialog.getByRole('button', { name: s.routes.addSubmit }).click();
    await expect(dialog).toBeHidden();
    const offer = admin.suppliers.offers.find((item) => item.offerId === 'fake-ff-100');
    expect(
      admin.suppliers.routes.some(
        (route) => route.productId === product.id && route.offerId === offer?.id,
      ),
    ).toBe(true);
  });

  test('S18: tests the connection and lists the failed calls with why', async ({ page, admin }) => {
    synced(admin);
    admin.supplierCatalog.calls = [
      {
        id: '01a10000-0000-7000-8000-000000000001',
        operation: 'list_offers',
        result: 'error',
        latencyMs: 15_000,
        supplierCode: null,
        failureKind: 'timeout',
        httpStatus: null,
        createdAt: new Date().toISOString(),
      },
    ];
    await page.goto('/suppliers/fake');
    await page.getByRole('button', { name: s.credentials.testNow }).click();
    await expect(page.getByText(/الاتصال سليم/)).toBeVisible();
    await page.goto('/suppliers/fake?tab=health');
    await expect(page.getByText(s.failures.timeout, { exact: true })).toBeVisible();
    await expect(page.getByText(s.operations.list_offers)).toBeVisible();
  });

  test('the cards show the platform status, new packs and low stock (SC11, SF2, SF5)', async ({
    page,
    admin,
  }) => {
    synced(admin);
    const { game, product } = freeFire(admin);
    admin.supplierCatalog.link('fake-ff', game.id);
    admin.suppliers.map(product.id, 'fake', 'fake-ff-100', { playerId: 'player_id' });
    admin.suppliers.script('fake-ff-100', { stock: 0 });
    admin.suppliers.runSync('fake');
    await page.goto('/suppliers');
    // S18 PS1: the newest sync's reading, in Arabic.
    await expect(page.getByText(s.platform.states.operational).first()).toBeVisible();
    await page.getByRole('link', { name: s.counts.showLowStock }).click();
    await expect(page).toHaveURL(/lowStock=/);
    await expect(page.getByText('Fake Free Fire 100')).toBeVisible();
    await expect(page.getByText(s.stock.out).first()).toBeVisible();
  });
});

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('S16 catalog screenshots', async ({ page, admin }, testInfo) => {
      synced(admin);
      const { game } = freeFire(admin);
      admin.supplierCatalog.link('fake-ff', game.id);
      admin.supplierCatalog.addOffer('fake-ff-auto', 'Fake Free Fire 2180', 19);
      admin.supplierCatalog.addUnsupported('fake-pubg-global', 'Fake UC 8100', 80);
      const done = admin.orders.orders.find((order) => order.number === 'VO-DONE67');
      admin.supplierCatalog.statementOrders = [
        {
          supplierOrderId: 'S-3',
          offerId: 'fake-uc-60',
          offerName: 'Fake UC 60',
          quantity: 1,
          status: 'completed',
          totalUsdUnits: 880_000,
          createdAt: new Date().toISOString(),
          completedAt: null,
          match: done
            ? {
                orderId: done.id,
                orderNumber: done.number,
                orderStatus: 'delivered',
                attemptId: done.attempts[0]?.id as string,
                attemptStatus: 'delivered',
              }
            : null,
        },
        {
          supplierOrderId: 'S-900',
          offerId: 'fake-uc-325',
          offerName: 'Fake UC 325',
          quantity: 1,
          status: 'completed',
          totalUsdUnits: 4_400_000,
          createdAt: new Date().toISOString(),
          completedAt: null,
          match: null,
        },
      ];

      await page.goto('/suppliers');
      await expect(page.getByText(s.platform.states.operational).first()).toBeVisible();
      await screenshot(page, testInfo, `suppliers-s16-${colorScheme}`, { fullPage: true });

      await page.goto('/suppliers/fake?tab=catalog');
      await page.getByRole('button', { name: fill(c.expand, { name: 'PUBG Mobile' }) }).click();
      await expect(page.getByRole('link', { name: 'Global', exact: true })).toBeVisible();
      await screenshot(page, testInfo, `supplier-catalog-${colorScheme}`, { fullPage: true });

      // S18: a category on a page of its own.
      await page.getByRole('link', { name: 'Free Fire', exact: true }).click();
      await expect(page.getByText('Fake Free Fire 2180').first()).toBeVisible();
      await screenshot(page, testInfo, `supplier-category-page-${colorScheme}`, { fullPage: true });
      await page.goto('/suppliers/fake?tab=catalog');

      await nodeAction(page, 'PUBG Mobile', c.import);
      await expect(page.getByRole('dialog').getByText('Fake UC 8100').first()).toBeVisible();
      await screenshot(page, testInfo, `supplier-import-category-${colorScheme}`);
      await page.keyboard.press('Escape');

      await nodeAction(page, 'Gift cards', c.link);
      const sheet = page.getByRole('dialog');
      // On a slow runner a click on the option while the sheet still opens was lost (CI, PR #84):
      // the game stayed unchosen. Choose again until the field shows it.
      const gamePicker = sheet.getByRole('combobox', { name: s.linkCategory.game });
      await expect(async () => {
        const option = page.getByRole('option', { name: 'فري فاير', exact: true });
        if (!(await option.isVisible())) await gamePicker.click();
        await option.click({ timeout: 2_000 });
        await expect(gamePicker).toHaveText(/فري فاير/, { timeout: 1_000 });
      }).toPass();
      await expect(sheet.getByText('Fake iTunes 25').first()).toBeVisible();
      await screenshot(page, testInfo, `supplier-link-category-${colorScheme}`);
      await page.keyboard.press('Escape');

      await page.goto('/suppliers/fake?tab=offers');
      await expect(page.getByText('Fake UC 8100').first()).toBeVisible();
      await screenshot(page, testInfo, `supplier-offers-s16-${colorScheme}`, { fullPage: true });

      await page.goto('/suppliers/fake?tab=statement');
      await expect(page.getByText(s.statement.unmatched)).toBeVisible();
      await screenshot(page, testInfo, `supplier-statement-${colorScheme}`, { fullPage: true });

      // S18: the link dialog's suggestions, the connection test and the failed calls.
      await page.goto('/suppliers/fake/categories/fake-ff');
      await page
        .getByRole('button', { name: fill(s.offers.link, { name: 'Fake Free Fire 100' }) })
        .click();
      await expect(page.getByRole('dialog').getByText(s.link.reasons.amount)).toBeVisible();
      await screenshot(page, testInfo, `supplier-link-offer-${colorScheme}`);
      await page.keyboard.press('Escape');
      admin.supplierCatalog.calls = [
        {
          id: '01a10000-0000-7000-8000-000000000002',
          operation: 'get_balance',
          result: 'error',
          latencyMs: 10_501,
          supplierCode: null,
          failureKind: 'connect',
          httpStatus: null,
          createdAt: new Date().toISOString(),
        },
        {
          id: '01a10000-0000-7000-8000-000000000003',
          operation: 'list_offers',
          result: 'error',
          latencyMs: 412,
          supplierCode: 'RATE_LIMITED',
          failureKind: 'rate_limited',
          httpStatus: 429,
          createdAt: new Date().toISOString(),
        },
      ];
      await page.goto('/suppliers/fake?tab=health');
      await expect(page.getByText(s.failures.connect, { exact: true })).toBeVisible();
      await screenshot(page, testInfo, `supplier-health-s18-${colorScheme}`, { fullPage: true });
      await page.goto('/suppliers/fake');
      await page.getByRole('button', { name: s.credentials.testNow }).click();
      await expect(page.getByText(/الاتصال سليم/)).toBeVisible();
      await screenshot(page, testInfo, `supplier-connection-s18-${colorScheme}`);

      // A paused pack that can serve, and one without a route (skipped).
      const ready = admin.catalog.addProduct(game.id, {
        nameAr: '310 ماسة',
        gameAmount: 310,
        status: 'paused',
      });
      admin.suppliers.map(ready.id, 'fake', 'fake-ff-310', { playerId: 'player_id' });
      admin.catalog.addProduct(game.id, { nameAr: '520 ماسة', gameAmount: 520, status: 'paused' });
      await page.goto(`/catalog/games/${game.id}?tab=products`);
      await page.getByRole('button', { name: s.activateAll.button }).click();
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: s.activateAll.confirm })
        .click();
      await expect(page.getByRole('dialog', { name: s.activateAll.doneTitle })).toBeVisible();
      await screenshot(page, testInfo, `activate-all-${colorScheme}`);
    });
  });
}
