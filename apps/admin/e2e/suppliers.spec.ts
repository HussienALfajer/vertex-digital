import { randomUUID } from 'node:crypto';
import type { Locator, Page } from '@playwright/test';
import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import { STORE_WEBHOOK_URL } from './suppliers-mock';
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

/** Accepts a review from its row, through the confirmation that states its price (A05-31). */
async function acceptReview(page: Page, row: Locator) {
  await row.getByRole('button', { name: ar.pricing.reviews.accept, exact: true }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: ar.pricing.reviews.acceptOne.action })
    .click();
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

/**
 * S17: a second fake route on "Fake UC 325", pre-set not to count for the price (WR7), expecting
 * delivery within 30 minutes and held at 45; an expected time at the policy's limit is refused.
 */
async function addWebRoute(page: Page, drawer: Locator) {
  await drawer.getByRole('button', { name: s.routes.add, exact: true }).click();
  const add = page.getByRole('dialog', { name: s.routes.addTitle });
  await choose(page, add, s.routes.supplier, 'مورد تجريبي');
  // S18: the search starts with the pack's amount (60); another pack is searched for.
  await expect(add.getByRole('textbox', { name: s.routes.offerSearch })).toHaveValue('60');
  await add.getByRole('textbox', { name: s.routes.offerSearch }).fill('325');
  await add.getByRole('button', { name: s.offers.searchSubmit }).click();
  await add
    .getByRole('button', { name: /Fake UC 325/ })
    .first()
    .click();
  await expect(add.getByRole('switch', { name: s.routes.settings.priceBasis })).not.toBeChecked();
  await choose(page, add, fill(s.fieldMap.target, { field: 'playerId' }), 'معرّف اللاعب');
  await add.getByLabel(s.routes.settings.expected).fill('30');
  await add.getByRole('button', { name: s.routes.addSubmit }).click();
  await expect(add.getByText(s.routes.settings.expectedError)).toBeVisible();
  // The dialog moves the focus to the refused field a frame after the error shows: typing into
  // the limit before then lands in the expected time ("3045", seen in CI).
  await expect(add.getByLabel(s.routes.settings.expected)).toBeFocused();
  await add.getByLabel(fill(s.routes.settings.limit, { policy: 30 })).fill('45');
  await add.getByRole('button', { name: s.routes.addSubmit }).click();
  await expect(add).toBeHidden();
  await expect(drawer.getByText(s.routes.notPriceBasis)).toBeVisible();
  await expect(drawer.getByText(fill(s.routes.expectedMark, { minutes: 30 }))).toBeVisible();
  await expect(drawer.getByText(fill(s.routes.limitMark, { minutes: 45 }))).toBeVisible();
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

/** S19 FC9: the plan the worker would have read, ending in so many hours. */
function fazercardsPlan(admin: AdminApi, plan: { active: boolean; endsInHours?: number }) {
  admin.suppliers.supplier('fazercards').subscription = {
    plan: plan.active ? 'bronze' : 'trial',
    expiresAt:
      plan.endsInHours === undefined
        ? null
        : new Date(Date.now() + plan.endsInHours * 3_600_000).toISOString(),
    active: plan.active,
    autoRenew: false,
    checkedAt: new Date(Date.now() - 120_000).toISOString(),
  };
}

test.describe('suppliers', () => {
  test('lists the suppliers, then sets the fake keys and the connection test finds its offers (step 1)', async ({
    page,
    admin,
  }) => {
    seed(admin);
    await page.goto('/suppliers');
    for (const name of ['WDGZone', 'يدوي', 'مورد تجريبي']) {
      await expect(card(page, name)).toBeVisible();
    }
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
    await expect(page.getByText(fill(s.offers.total, { total: 14 }))).toBeVisible();
  });

  test('FazerCards takes its keys, shows its plan, and points its webhook at the store (S19 FC8, FC9)', async ({
    page,
    admin,
  }) => {
    admin.signedIn = true;
    fazercardsPlan(admin, { active: true, endsInHours: 30 });
    await page.goto('/suppliers');
    await expect(card(page, 'FazerCards')).toContainText(s.chips.available);
    await expect(card(page, 'FazerCards')).toContainText(s.subscription.endsSoon);
    await card(page, 'FazerCards').getByRole('link', { name: s.open }).click();
    await expect(page).toHaveURL(/\/suppliers\/fazercards$/);
    await expect(page.getByText(s.descriptions.fazercards)).toBeVisible();
    admin.reauthenticationRequired = true;
    await page.getByRole('button', { name: s.credentials.set }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(s.credentials.fields.apiKey).fill('fazercards-api-key-e5f6');
    await dialog.getByLabel(s.credentials.fields.webhookSecret).fill('fazercards-whsec-g7h8');
    await dialog.getByRole('button', { name: s.credentials.save }).click();
    await reauthenticate(page);
    await expect(page.getByText('…e5f6')).toBeVisible();
    await expect(page.getByText('…g7h8')).toBeVisible();

    const webhook = page.locator('[data-slot="card"]').filter({ hasText: s.webhook.title });
    await expect(webhook).toContainText(s.webhook.off);
    await expect(webhook).toContainText(s.webhook.noDeliveries);
    admin.reauthenticationRequired = true;
    await webhook.getByRole('button', { name: s.webhook.set }).click();
    await reauthenticate(page);
    await expect(webhook).toContainText(s.webhook.pointed);
    await expect(webhook).toContainText(STORE_WEBHOOK_URL);
    await expect(webhook).toContainText('webhook.test');
    await webhook.getByRole('button', { name: s.webhook.test }).click();
    await expect(webhook).toContainText(s.webhook.testSent);
    await expect(webhook.getByText(s.webhook.delivered)).toHaveCount(2);

    // FC9: an inactive plan says what it stops.
    fazercardsPlan(admin, { active: false });
    await page.reload();
    await expect(page.getByText(s.subscription.inactiveMeaning)).toBeVisible();
  });

  test('imports three PUBG offers into paused products, refusing a taken name in place (step 2)', async ({
    page,
    admin,
  }) => {
    const { game } = seed(admin);
    admin.suppliers.connectFake();
    await page.goto('/suppliers/fake?tab=offers');
    await page.getByRole('button', { name: 'PUBG Mobile', exact: true }).first().click();
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
    // S18: the offer's one field is proposed onto the game's one field.
    await expect(
      add.getByRole('combobox', { name: fill(s.fieldMap.target, { field: 'playerId' }) }),
    ).toHaveText(/معرّف اللاعب/);
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

  test('adds a second route of the supplier that does not count for the price, with its timing (S17)', async ({
    page,
    admin,
  }) => {
    const { game } = mapped(admin);
    const drawer = await openRoutes(page, game.id, '60 UC');
    await addWebRoute(page, drawer);
    // The price stays on the route that counts (WR3).
    await expect(drawer.getByText('$0.98').first()).toBeVisible();
    await expect(drawer.getByRole('listitem').first()).toContainText(s.routes.basisMark);

    // WR4: the counting route disabled, the price is kept.
    await drawer
      .getByRole('listitem')
      .first()
      .getByRole('switch', { name: s.routes.enabled })
      .click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: s.routes.stop.disable })
      .click();
    await expect(drawer.getByText(s.routes.priceHeld)).toBeVisible();
    await expect(drawer.getByText('$0.98').first()).toBeVisible();

    // WR6: counting the second route reprices at once; a limit below the expected time is refused.
    const web = drawer.getByRole('listitem').filter({ hasText: 'Fake UC 325' });
    await web.getByRole('button', { name: s.routes.settings.edit }).click();
    const settings = page.getByRole('dialog', { name: s.routes.settings.title });
    await settings.getByLabel(fill(s.routes.settings.limit, { policy: 30 })).fill('20');
    await settings.getByRole('button', { name: ar.catalog.actions.save }).click();
    await expect(settings.getByText(s.routes.settings.expectedError)).toBeVisible();
    // As in addWebRoute: the focus goes to the refused field a frame after the error shows.
    await expect(settings.getByLabel(s.routes.settings.expected)).toBeFocused();
    await settings.getByLabel(fill(s.routes.settings.limit, { policy: 30 })).fill('45');
    await settings.getByRole('switch', { name: s.routes.settings.priceBasis }).click();
    await settings.getByRole('button', { name: ar.catalog.actions.save }).click();
    await expect(settings).toBeHidden();
    await expect(drawer.getByText(s.routes.notPriceBasis)).toBeHidden();
    await expect(drawer.getByText(s.routes.priceHeld)).toBeHidden();
    await expect(web).toContainText(s.routes.basisMark);
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
    await acceptReview(page, row);
    await expect(row).toContainText(fill(ar.pricing.reviews.stale, { price: '⁦$1.32⁩' }));
    await expect(row).toContainText('$1.02 → $1.32');
    await acceptReview(page, row);
    await expect(page.getByText(ar.pricing.reviews.empty)).toBeVisible();
    await page.goto(`/catalog/games/${game.id}?tab=products`);
    const product = page.getByRole('row').filter({ hasText: '60 UC' });
    await expect(product).toContainText('$1.32');
    await expect(product).toContainText(ar.catalog.availability.available);
  });

  test('a review decided in another tab keeps its refusal on screen by name (F8-6)', async ({
    page,
    admin,
  }) => {
    mapped(admin);
    admin.suppliers.script('fake-uc-60', { costUsdUnits: 1_100_000 });
    admin.suppliers.runSync('fake');
    await page.goto('/pricing/reviews');
    const row = page.getByRole('row').filter({ hasText: '60 UC' });
    await expect(row).toBeVisible();
    // Accepted in another tab meanwhile.
    (admin.suppliers.reviews[0] as { status: string }).status = 'accepted';
    await acceptReview(page, row);
    await expect(row).toBeHidden();
    await expect(page.getByRole('listitem').filter({ hasText: '60 UC' })).toContainText(
      ar.errors.api.REVIEW_CLOSED,
    );
  });

  test('deciding the only row of the last page shows the page before it (F8-5)', async ({
    page,
    admin,
  }) => {
    mapped(admin);
    admin.suppliers.script('fake-uc-60', { costUsdUnits: 1_100_000 });
    admin.suppliers.runSync('fake');
    const [first] = admin.suppliers.reviews;
    for (let index = 0; index < 50; index += 1) {
      admin.suppliers.reviews.push({
        ...(first as (typeof admin.suppliers.reviews)[number]),
        id: randomUUID(),
      });
    }
    await page.goto('/pricing/reviews?page=2');
    const rows = page.getByRole('row').filter({ hasText: '60 UC' });
    await expect(rows).toHaveCount(1);
    await acceptReview(page, rows);
    await expect(page).not.toHaveURL(/page=2/);
    await expect(rows).toHaveCount(50);
    await expect(page.getByText(ar.pricing.reviews.empty)).toBeHidden();
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

test.describe('suppliers and reviews: audit A05', () => {
  test('archiving or switching off the basis route asks first and states the price (A05-4)', async ({
    page,
    admin,
  }) => {
    const { game } = mapped(admin);
    const drawer = await openRoutes(page, game.id, '60 UC');
    const route = drawer.getByRole('listitem').first();
    await route.getByRole('button', { name: ar.catalog.actions.archive }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText(fill(s.routes.stop.basis, { price: '⁦$0.98⁩' }));
    await dialog.getByRole('button', { name: ar.common.cancel }).click();
    await expect(route.getByRole('button', { name: ar.catalog.actions.restore })).toBeHidden();
    await route.getByRole('switch', { name: s.routes.enabled }).click();
    await expect(dialog).toContainText(s.routes.stop.disableTitle.split('{{')[0] as string);
    await dialog.getByRole('button', { name: s.routes.stop.disable }).click();
    await expect(route.getByRole('switch', { name: s.routes.enabled })).not.toBeChecked();
    await route.getByRole('button', { name: ar.catalog.actions.archive }).click();
    await dialog.getByRole('button', { name: s.routes.stop.archive }).click();
    await expect(route.getByRole('button', { name: ar.catalog.actions.restore })).toBeVisible();
  });

  test('saves the low-balance threshold and says so (A05-24)', async ({ page, admin }) => {
    seed(admin);
    await page.goto('/suppliers/fake?tab=connection');
    await expect(page.getByText(fill(s.threshold.current, { amount: '⁦$50.00⁩' }))).toBeVisible();
    await page.getByLabel(s.threshold.label).fill('60');
    await page.getByRole('button', { name: s.threshold.save }).click();
    await expect(page.getByText(fill(s.threshold.current, { amount: '⁦$60.00⁩' }))).toBeVisible();
    await expect(page.getByText(s.threshold.saved)).toBeVisible();
    await expect(page.getByLabel(s.threshold.label)).toHaveValue('60');
  });

  test('a bulk accept states each price and accepts only on confirm (A05-6)', async ({
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
    await page.getByRole('checkbox', { name: ar.pricing.reviews.selectAll }).click();
    await page.getByRole('button', { name: ar.pricing.reviews.acceptSelected }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText(fill(ar.pricing.reviews.acceptMany.title, { count: 2 }));
    await expect(dialog).toContainText('$0.98 → $1.21');
    await dialog.getByRole('button', { name: ar.common.cancel }).click();
    await expect(page.getByRole('row').filter({ hasText: '60 UC' })).toBeVisible();
    await page.getByRole('button', { name: ar.pricing.reviews.acceptSelected }).click();
    await dialog
      .getByRole('button', { name: fill(ar.pricing.reviews.acceptMany.action, { count: 2 }) })
      .click();
    await expect(page.getByText(ar.pricing.reviews.empty)).toBeVisible();
  });

  test('a failed margin preview shows inside the dialog with a retry (A05-7)', async ({
    page,
    admin,
  }) => {
    mapped(admin);
    admin.suppliers.script('fake-uc-60', { costUsdUnits: 1_100_000 });
    admin.suppliers.runSync('fake');
    let fail = true;
    await page.route('**/api/admin/pricing/preview', (route) =>
      fail
        ? route.fulfill({
            status: 500,
            json: { statusCode: 500, code: 'INTERNAL_ERROR', message: 'x' },
          })
        : route.fallback(),
    );
    await page.goto('/pricing/reviews');
    await page
      .getByRole('row')
      .filter({ hasText: '60 UC' })
      .getByRole('button', { name: ar.pricing.reviews.adjust })
      .click();
    const dialog = page.getByRole('dialog', { name: ar.pricing.reviews.adjust });
    await expect(dialog.getByText(ar.errors.generic)).toBeVisible();
    fail = false;
    await dialog.getByRole('button', { name: ar.common.retry }).click();
    await expect(page.getByLabel(ar.pricing.form.percent, { exact: true })).toBeVisible();
  });
});

test.describe('suppliers: failed reads and pages (audit A05)', () => {
  test("the add-route dialog's failed offer read offers a retry (A05-27)", async ({
    page,
    admin,
  }) => {
    const { game } = mapped(admin);
    let fail = true;
    await page.route('**/api/admin/suppliers/fake/offers?**', (route) =>
      fail
        ? route.fulfill({
            status: 500,
            json: { statusCode: 500, code: 'INTERNAL_ERROR', message: 'x' },
          })
        : route.fallback(),
    );
    const drawer = await openRoutes(page, game.id, '60 UC');
    await drawer.getByRole('button', { name: s.routes.add, exact: true }).click();
    const add = page.getByRole('dialog', { name: s.routes.addTitle });
    await choose(page, add, s.routes.supplier, 'مورد تجريبي');
    await expect(add.getByText(ar.errors.generic)).toBeVisible();
    fail = false;
    await add.getByRole('button', { name: ar.common.retry }).click();
    await expect(add.getByText(ar.errors.generic)).toBeHidden();
    await expect(add.getByRole('textbox', { name: s.routes.offerSearch })).toBeVisible();
  });

  test('a page of offers past the end shows the last page (A05-26)', async ({ page, admin }) => {
    mapped(admin);
    await page.goto('/suppliers/fake?tab=offers&page=9');
    await expect(page).not.toHaveURL(/page=9/);
    await expect(page.getByText('Fake UC 60').first()).toBeVisible();
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
      // S19 FC8, FC9: FazerCards with its keys, its plan and its webhook pointed at the store.
      fazercardsPlan(admin, { active: true, endsInHours: 30 });
      admin.suppliers.supplier('fazercards').credentials = {
        hints: { apiKey: 'e5f6', webhookSecret: 'g7h8' },
        setAt: new Date().toISOString(),
      };
      admin.suppliers.supplier('fazercards').webhook = {
        url: STORE_WEBHOOK_URL,
        enabled: true,
        expectedUrl: STORE_WEBHOOK_URL,
        consecutiveFailures: 0,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastFailureReason: null,
        deliveries: [
          {
            id: 'd2',
            event: 'order.status_changed',
            attempt: 1,
            status: 'delivered',
            responseStatus: 200,
            durationMs: 140,
            createdAt: '2026-10-20T09:00:02.000Z',
          },
          {
            id: 'd1',
            event: 'webhook.test',
            attempt: 1,
            status: 'failed',
            responseStatus: 404,
            durationMs: 355,
            createdAt: '2026-10-19T21:34:34.806Z',
          },
        ],
      };
      await page.goto('/suppliers/fazercards');
      await expect(page.getByText(s.webhook.pointed)).toBeVisible();
      await screenshot(page, testInfo, `supplier-fazercards-${colorScheme}`, { fullPage: true });
      await page.goto('/suppliers/fake');
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
      // S17: a second route of the supplier, its settings and the settings dialog.
      await addWebRoute(page, drawer);
      await screenshot(page, testInfo, `routes-drawer-s17-${colorScheme}`);
      await drawer
        .getByRole('listitem')
        .filter({ hasText: 'Fake UC 325' })
        .getByRole('button', { name: s.routes.settings.edit })
        .click();
      await expect(page.getByRole('dialog', { name: s.routes.settings.title })).toBeVisible();
      await screenshot(page, testInfo, `route-settings-${colorScheme}`);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');

      await page.goto('/pricing/reviews');
      await expect(page.getByRole('row').filter({ hasText: '60 UC' })).toBeVisible();
      await screenshot(page, testInfo, `price-reviews-${colorScheme}`, { fullPage: true });
      await acceptReview(page, page.getByRole('row').filter({ hasText: '60 UC' }));
      await expect(page.getByText(ar.pricing.reviews.empty)).toBeVisible();
      await screenshot(page, testInfo, `price-reviews-empty-${colorScheme}`);

      await page.goto('/suppliers/policy');
      await expect(page.getByLabel(s.policy.fields.costStaleMinutes.label)).toHaveValue('120');
      await screenshot(page, testInfo, `supplier-policy-${colorScheme}`, { fullPage: true });
    });
  });
}
