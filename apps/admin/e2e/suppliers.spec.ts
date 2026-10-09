import type { Locator, Page } from '@playwright/test';
import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import { type AdminApi, expect, PASSWORD, screenshot, TOTP_CODE, test, USD } from './test';

/*
 * Suppliers (S07, F09): the suppliers and their keys with the connection test (SP1–SP3), the
 * offers and the import (RT8), a product's routes (RT1–RT7, P1), the price reviews (P2–P4, P6),
 * the policy and the display step refusal (P9), against the mocked API (`suppliers-mock.ts`).
 */

const s = ar.suppliers;

const fill = (text: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce(
    (result, [key, value]) => result.replace(`{{${key}}}`, String(value)),
    text,
  );

async function reauthenticate(page: Page) {
  await expect(page.getByRole('heading', { name: ar.reauth.title })).toBeVisible();
  await page.getByLabel(ar.reauth.password, { exact: true }).fill(PASSWORD);
  await page.getByRole('textbox').filter({ visible: true }).nth(1).pressSequentially(TOTP_CODE);
  await page.getByRole('button', { name: ar.reauth.submit }).click();
}

async function choose(page: Page, scope: Locator | Page, label: string, option: string) {
  await scope.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

const card = (page: Page, name: string) =>
  page
    .locator('[data-slot=card]')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });

/** ببجي موبايل with its player id field and "60 UC" (acceptance, S06 games present). */
function seed(admin: AdminApi) {
  const game = admin.catalog.addGame({
    categorySlug: 'games',
    slug: 'pubg-mobile',
    nameAr: 'ببجي موبايل',
    nameEn: 'PUBG Mobile',
    status: 'active',
    cover: true,
  });
  admin.catalog.addField(game.id, { key: 'player_id', labelAr: 'معرّف اللاعب' });
  const product = admin.catalog.addProduct(game.id, { nameAr: '60 UC', gameAmount: 60 });
  admin.signedIn = true;
  return { game, product };
}

/** The scene of steps 3–4: the fake supplier synced, "60 UC" routed to `fake-uc-60` at $0.88. */
function mapped(admin: AdminApi) {
  const scene = seed(admin);
  admin.suppliers.connectFake();
  admin.suppliers.map(scene.product.id, 'fake', 'fake-uc-60', { playerId: 'player_id' });
  return scene;
}

async function openRoutes(page: Page, gameId: string, product: string) {
  await page.goto(`/catalog/games/${gameId}?tab=products`);
  await page
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: product, exact: true }) })
    .getByRole('button', { name: ar.catalog.products.routes })
    .click();
  const drawer = page.getByRole('dialog');
  await expect(
    drawer.getByRole('heading', { name: fill(s.routes.title, { name: product }) }),
  ).toBeVisible();
  return drawer;
}

test.describe('suppliers', () => {
  test('lists the suppliers, then sets the fake keys and the connection test finds its offers (step 1)', async ({
    page,
    admin,
  }) => {
    seed(admin);
    await page.goto('/suppliers');
    for (const name of ['SHOP2TOPUP', 'WDGZone', 'يدوي', 'مورد تجريبي']) {
      await expect(card(page, name)).toBeVisible();
    }
    await expect(card(page, 'SHOP2TOPUP')).toContainText(s.chips.unavailable);
    await expect(card(page, 'مورد تجريبي')).toContainText(s.chips.notConfigured);

    await card(page, 'مورد تجريبي').getByRole('button', { name: s.sync.now }).click();
    await expect(card(page, 'مورد تجريبي')).toContainText(ar.errors.api.SUPPLIER_NOT_CONFIGURED);

    await card(page, 'مورد تجريبي').getByRole('link', { name: s.open }).click();
    await expect(page).toHaveURL(/\/suppliers\/fake$/);
    admin.reauthenticationRequired = true;
    await page.getByRole('button', { name: s.credentials.set }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(s.credentials.fields.webhookSecret).fill('fake-webhook-secret-a1b2');
    await dialog.getByRole('button', { name: s.credentials.save }).click();
    await reauthenticate(page);
    await expect(page.getByText('…a1b2')).toBeVisible();
    const test = page
      .getByRole('region', { name: s.credentials.test })
      .or(page.locator('section').filter({ hasText: s.credentials.test }));
    await expect(test).toContainText(s.runs.statuses.succeeded, { timeout: 10_000 });

    await page.getByRole('tab', { name: s.tabs.offers }).click();
    await expect(page.getByText('Fake UC 60', { exact: true })).toBeVisible();
    await expect(page.getByText(fill(s.offers.total, { total: 10 }))).toBeVisible();
  });

  test('imports three PUBG offers into paused products, refusing a taken name in place (step 2)', async ({
    page,
    admin,
  }) => {
    const { game } = seed(admin);
    admin.suppliers.connectFake();
    await page.goto('/suppliers/fake?tab=offers');
    await page.getByRole('button', { name: 'PUBG Mobile' }).first().click();
    await expect(page).toHaveURL(/group=PUBG/);
    await expect(page.getByText('Fake Free Fire 100')).toBeHidden();
    for (const name of ['Fake UC 325', 'Fake UC 660', 'Fake UC 1800']) {
      await page.getByRole('checkbox', { name: fill(s.offers.selectOffer, { name }) }).click();
    }
    await expect(page.getByText(fill(s.offers.selected, { count: 3, max: 100 }))).toBeVisible();
    await page.getByRole('button', { name: s.offers.import }).click();

    const dialog = page.getByRole('dialog');
    await choose(page, dialog, s.import.game, 'ببجي موبايل');
    await choose(page, dialog, fill(s.fieldMap.target, { field: 'playerId' }), 'معرّف اللاعب');
    const names = dialog.getByRole('textbox');
    await names.first().fill('60 UC');
    await dialog.getByRole('button', { name: fill(s.import.submit, { count: 3 }) }).click();
    await expect(dialog.getByText(ar.errors.api.NAME_TAKEN)).toBeVisible();
    await expect(dialog.getByText(s.import.refused)).toBeVisible();
    expect(admin.catalog.products).toHaveLength(1);

    await names.first().fill('325 UC');
    await dialog.getByRole('button', { name: fill(s.import.submit, { count: 3 }) }).click();
    await expect(dialog.getByText(fill(s.import.done, { count: 3 }))).toBeVisible();
    await dialog.getByRole('link', { name: s.import.openGame }).click();
    await expect(page).toHaveURL(new RegExp(`/catalog/games/${game.id}\\?tab=products`));
    const row = page
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: '325 UC', exact: true }) });
    // $4.40 with the global rule (10%, at least $0.10): $4.84, paused for review (rule RT8).
    await expect(row).toContainText('$4.84');
    await expect(row).toContainText(ar.catalog.statuses.paused);
    await page.goto('/suppliers/fake?tab=offers&mapped=true');
    await expect(page.getByRole('link', { name: /325 UC/ })).toBeVisible();
  });

  test('maps "60 UC" to the fake offer and adds a manual route as the last resort (step 3)', async ({
    page,
    admin,
  }) => {
    const { game } = seed(admin);
    admin.suppliers.connectFake();
    const drawer = await openRoutes(page, game.id, '60 UC');
    await expect(drawer.getByText(s.routes.empty)).toBeVisible();

    await drawer.getByRole('button', { name: s.routes.add, exact: true }).click();
    const add = page.getByRole('dialog', { name: s.routes.addTitle });
    await choose(page, add, s.routes.supplier, 'مورد تجريبي');
    await add
      .getByRole('button', { name: /Fake UC 60/ })
      .first()
      .click();
    await add.getByRole('button', { name: s.routes.addSubmit }).click();
    await expect(add.getByText(ar.errors.api.ROUTE_FIELDS_UNMAPPED)).toBeVisible();
    await expect(add.getByText(s.fieldMap.missing)).toBeVisible();
    await choose(page, add, fill(s.fieldMap.target, { field: 'playerId' }), 'معرّف اللاعب');
    await add.getByRole('button', { name: s.routes.addSubmit }).click();
    await expect(add).toBeHidden();
    await expect(drawer.getByText(s.routes.basisMark)).toBeVisible();
    await expect(drawer.getByText('$0.98').first()).toBeVisible();

    admin.reauthenticationRequired = true;
    await drawer.getByRole('button', { name: s.routes.addManual }).click();
    const manual = page.getByRole('dialog', { name: s.routes.manual.addTitle });
    await manual.getByLabel(s.routes.manual.cost).fill('1.2');
    await manual.getByRole('button', { name: ar.catalog.actions.save }).click();
    await reauthenticate(page);
    await expect(manual).toBeHidden();
    await expect(drawer.getByText(s.routes.tiers.manual)).toBeVisible();
    // The basis stays the fake route: the manual one serves only when nothing automatic can.
    await expect(drawer.getByRole('listitem').first()).toContainText(s.routes.basisMark);
    await expect(drawer.getByRole('listitem').first()).toContainText('مورد تجريبي');

    // Rule SP3: pausing the fake supplier makes its route unusable; the manual price follows.
    await page.keyboard.press('Escape');
    await page.goto('/suppliers/fake');
    await page.getByRole('switch').click();
    await page.getByRole('button', { name: ar.switches.confirm.fake_paused.true.action }).click();
    await expect(page.getByText(s.pause.on)).toBeVisible();
    const again = await openRoutes(page, game.id, '60 UC');
    await expect(again.getByText(s.routes.unusable.supplier_paused)).toBeVisible();
    await expect(again.getByText('$1.32').first()).toBeVisible();
  });

  test('a large cost change waits for review behind the margin guard, a stale accept reloads (step 4)', async ({
    page,
    admin,
  }) => {
    const { game } = mapped(admin);
    // Under 10%: the price follows at once.
    admin.suppliers.script('fake-uc-60', { costUsdUnits: 920_000 });
    await page.goto('/suppliers');
    await card(page, 'مورد تجريبي').getByRole('button', { name: s.sync.now }).click();
    await expect(card(page, 'مورد تجريبي')).toContainText(s.runs.statuses.succeeded);
    await page.goto(`/catalog/games/${game.id}?tab=products`);
    await expect(page.getByRole('row').filter({ hasText: '60 UC' })).toContainText('$1.02');

    admin.suppliers.script('fake-uc-60', { costUsdUnits: 1_100_000 });
    admin.suppliers.runSync('fake');
    await page.goto('/pricing/reviews');
    await expect(page.getByRole('link', { name: ar.nav.priceReviews })).toContainText('1');
    const row = page.getByRole('row').filter({ hasText: '60 UC' });
    await expect(row).toContainText('$0.92 → $1.10');
    await expect(row).toContainText('$1.02 → $1.21');
    await expect(row).toContainText(ar.catalog.availability.paused_by_margin_guard);

    // The cost moves again before the admin accepts: the accept is refused with the new figure.
    admin.suppliers.script('fake-uc-60', { costUsdUnits: 1_200_000 });
    admin.suppliers.runSync('fake');
    await row.getByRole('button', { name: ar.pricing.reviews.accept, exact: true }).click();
    await expect(row).toContainText(fill(ar.pricing.reviews.stale, { price: '⁦$1.32⁩' }));
    await expect(row).toContainText('$1.02 → $1.32');
    await row.getByRole('button', { name: ar.pricing.reviews.accept, exact: true }).click();
    await expect(page.getByText(ar.pricing.reviews.empty)).toBeVisible();
    await page.goto(`/catalog/games/${game.id}?tab=products`);
    const product = page.getByRole('row').filter({ hasText: '60 UC' });
    await expect(product).toContainText('$1.32');
    await expect(product).toContainText(ar.catalog.availability.available);
  });

  test('adjusts the margin from a review after re-authentication, and pauses another', async ({
    page,
    admin,
  }) => {
    const { game } = mapped(admin);
    const other = admin.catalog.addProduct(game.id, { nameAr: '325 UC', gameAmount: 325 });
    admin.suppliers.map(other.id, 'fake', 'fake-uc-325', { playerId: 'player_id' });
    admin.suppliers.script('fake-uc-60', { costUsdUnits: 1_100_000 });
    admin.suppliers.script('fake-uc-325', { costUsdUnits: 5_500_000 });
    admin.suppliers.runSync('fake');
    await page.goto('/pricing/reviews');
    admin.reauthenticationRequired = true;
    const row = page.getByRole('row').filter({ hasText: '60 UC' });
    await row.getByRole('button', { name: ar.pricing.reviews.adjust }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(ar.pricing.form.percent, { exact: true }).fill('20');
    await dialog.getByRole('button', { name: ar.pricing.form.save }).click();
    await reauthenticate(page);
    await expect(row).toBeHidden();

    const second = page.getByRole('row').filter({ hasText: '325 UC' });
    await second.getByRole('button', { name: ar.pricing.reviews.pause, exact: true }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: ar.pricing.reviews.pause })
      .click();
    await expect(page.getByText(ar.pricing.reviews.empty)).toBeVisible();
    await choose(page, page, ar.pricing.reviews.status, ar.pricing.reviews.statuses.paused);
    await expect(page.getByRole('row').filter({ hasText: '325 UC' })).toBeVisible();
    await page.goto(`/catalog/games/${game.id}?tab=products`);
    // $1.10 with the product's 20% rule: $1.32.
    await expect(page.getByRole('row').filter({ hasText: '60 UC' })).toContainText('$1.32');
    await expect(page.getByRole('row').filter({ hasText: '325 UC' })).toContainText(
      ar.catalog.statuses.paused,
    );
  });

  test('saves the policy after re-authentication and refuses a down rate above the degraded one', async ({
    page,
    admin,
  }) => {
    seed(admin);
    await page.goto('/suppliers/policy');
    const threshold = page.getByLabel(s.policy.fields.priceReviewThresholdBp.label);
    await expect(threshold).toHaveValue('10');
    await page.getByLabel(s.policy.fields.downSuccessBp.label).fill('95');
    await page.getByRole('button', { name: s.policy.save }).click();
    await expect(page.getByText(s.policy.fields.downSuccessBp.error)).toBeVisible();
    expect(admin.calls).not.toContain('PUT /api/admin/suppliers/policy');

    admin.reauthenticationRequired = true;
    await page.getByLabel(s.policy.fields.downSuccessBp.label).fill('50');
    await threshold.fill('15');
    await page.getByRole('button', { name: s.policy.save }).click();
    await reauthenticate(page);
    await expect(page.getByText(s.policy.saved)).toBeVisible();
    expect(admin.suppliers.policy.priceReviewThresholdBp).toBe(1_500);
  });

  test('refuses a display step above 2% of the cheapest available product (step 9)', async ({
    page,
    admin,
  }) => {
    admin.signedIn = true;
    admin.maxDisplayStepSypUnits = 200;
    await page.goto('/rates');
    await page.getByLabel(ar.rates.form.rate, { exact: true }).fill('119');
    await page.getByLabel(ar.rates.form.step, { exact: true }).fill('5');
    await page.getByRole('button', { name: ar.rates.form.submit }).click();
    await expect(
      page.getByText(fill(ar.rates.form.errors.stepTooLarge, { max: '2' })),
    ).toBeVisible();
    await page.getByLabel(ar.rates.form.step, { exact: true }).fill('2');
    await page.getByRole('button', { name: ar.rates.form.submit }).click();
    await expect(page.getByRole('row').filter({ hasText: '119' })).toBeVisible();
    expect(admin.rates[0]?.displayStepSypUnits).toBe(200);
  });
});

test.describe('validation quota (S09 rule AD2)', () => {
  test("shows today's usage and saves a new quota", async ({ page, admin }) => {
    admin.signedIn = true;
    admin.suppliers.connectFake();
    await page.goto('/suppliers/fake');
    const quota = s.validationQuota;
    await expect(page.getByText(quota.title)).toBeVisible();
    await expect(page.getByText(fill(quota.usage, { used: 312, quota: 1000 }))).toBeVisible();
    const input = page.getByLabel(quota.label, { exact: true });
    await input.fill('-1');
    await page.getByRole('button', { name: quota.save }).click();
    await expect(page.getByText(quota.error)).toBeVisible();
    await input.fill('1');
    await page.getByRole('button', { name: quota.save }).click();
    await expect(page.getByText(quota.saved)).toBeVisible();
    await expect(page.getByText(fill(quota.usage, { used: 312, quota: 1 }))).toBeVisible();
    expect(admin.lastBody('PUT /api/admin/suppliers/fake/validation-quota')).toEqual({ quota: 1 });
  });

  test('a supplier that cannot check player ids has no quota', async ({ page, admin }) => {
    admin.signedIn = true;
    await page.goto('/suppliers/manual');
    await expect(page.getByText(s.tabs.connection).first()).toBeVisible();
    await expect(page.getByText(s.validationQuota.title)).toHaveCount(0);
  });
});

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('S07 screenshots', async ({ page, admin }, testInfo) => {
      const { game } = mapped(admin);
      admin.suppliers.readBalance('fake', 20 * USD);
      admin.suppliers.setHealth('fake', 'degraded', 'success 82% < 90%');
      admin.suppliers.script('fake-uc-60', { costUsdUnits: 1_100_000 });
      admin.suppliers.runSync('fake');
      admin.suppliers.failNextSync = 'CATALOG_SUSPICIOUS';
      admin.suppliers.runSync('fake');

      await page.goto('/suppliers');
      await expect(card(page, 'مورد تجريبي')).toContainText(s.balance.low);
      await screenshot(page, testInfo, `suppliers-${colorScheme}`, { fullPage: true });

      await page.goto('/suppliers/fake');
      await expect(page.getByText('…c3d4')).toBeVisible();
      await screenshot(page, testInfo, `supplier-connection-${colorScheme}`, { fullPage: true });
      await page.getByRole('tab', { name: s.tabs.offers }).click();
      await expect(page.getByText('Fake UC 60', { exact: true })).toBeVisible();
      await screenshot(page, testInfo, `supplier-offers-${colorScheme}`, { fullPage: true });
      await page.getByRole('tab', { name: s.tabs.runs }).click();
      await expect(page.getByText(s.runs.errors.CATALOG_SUSPICIOUS)).toBeVisible();
      await screenshot(page, testInfo, `supplier-runs-${colorScheme}`, { fullPage: true });
      await page.getByRole('tab', { name: s.tabs.health }).click();
      // The worker's English reason is shown in Arabic (rules H1–H3).
      await expect(
        page.getByText(
          fill(s.healthTab.reasons.successBelow, {
            success: '\u206682%\u2069',
            threshold: '\u206690%\u2069',
          }),
        ),
      ).toHaveCount(2);
      await expect(page.getByText('success 82%')).toHaveCount(0);
      await screenshot(page, testInfo, `supplier-health-${colorScheme}`, { fullPage: true });

      await page.getByRole('tab', { name: s.tabs.offers }).click();
      for (const name of ['Fake UC 325', 'Fake UC 660']) {
        await page.getByRole('checkbox', { name: fill(s.offers.selectOffer, { name }) }).click();
      }
      await page.getByRole('button', { name: s.offers.import }).click();
      const dialog = page.getByRole('dialog');
      await choose(page, dialog, s.import.game, 'ببجي موبايل');
      await choose(page, dialog, fill(s.fieldMap.target, { field: 'playerId' }), 'معرّف اللاعب');
      await dialog.getByRole('textbox').first().fill('60 UC');
      await dialog.getByRole('button', { name: fill(s.import.submit, { count: 2 }) }).click();
      await expect(dialog.getByText(ar.errors.api.NAME_TAKEN)).toBeVisible();
      await screenshot(page, testInfo, `supplier-import-error-${colorScheme}`);
      await page.keyboard.press('Escape');

      const drawer = await openRoutes(page, game.id, '60 UC');
      await expect(drawer.getByText(s.routes.basisMark)).toBeVisible();
      await screenshot(page, testInfo, `routes-drawer-${colorScheme}`);
      await page.keyboard.press('Escape');

      await page.goto('/pricing/reviews');
      await expect(page.getByRole('row').filter({ hasText: '60 UC' })).toBeVisible();
      await screenshot(page, testInfo, `price-reviews-${colorScheme}`, { fullPage: true });
      await page
        .getByRole('row')
        .filter({ hasText: '60 UC' })
        .getByRole('button', { name: ar.pricing.reviews.accept, exact: true })
        .click();
      await expect(page.getByText(ar.pricing.reviews.empty)).toBeVisible();
      await screenshot(page, testInfo, `price-reviews-empty-${colorScheme}`);

      await page.goto('/suppliers/policy');
      await expect(page.getByLabel(s.policy.fields.costStaleMinutes.label)).toHaveValue('120');
      await screenshot(page, testInfo, `supplier-policy-${colorScheme}`, { fullPage: true });
    });
  });
}
