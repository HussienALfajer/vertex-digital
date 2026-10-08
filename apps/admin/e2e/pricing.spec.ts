import type { Page } from '@playwright/test';
import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import { type AdminApi, expect, PASSWORD, screenshot, TOTP_CODE, test } from './test';

/*
 * Pricing (S06, F10): the global rule, the calculator (PR3, PR8, PR10), a category and a product
 * rule after re-authentication (PR2, PR7, PR9), archiving them (PR2), against the mocked API.
 */

const field = (page: Page, label: string) =>
  page.getByLabel(label, { exact: true }).filter({ visible: true });

/** Re-authenticates in the dialog the API's refusal opened (S01 rule D5). */
async function reauthenticate(page: Page) {
  await expect(page.getByRole('heading', { name: ar.reauth.title })).toBeVisible();
  await field(page, ar.reauth.password).fill(PASSWORD);
  await page.getByRole('textbox').filter({ visible: true }).nth(1).pressSequentially(TOTP_CODE);
  await page.getByRole('button', { name: ar.reauth.submit }).click();
}

/** A game in ألعاب with "60 UC" at an official $0.99 (acceptance steps 1–3). */
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
  admin.catalog.addProduct(game.id, {
    nameAr: '60 UC',
    gameAmount: 60,
    officialPriceUsdUnits: 990_000,
  });
  admin.signedIn = true;
  return game;
}

const preview = (page: Page) => page.getByTestId('price-preview').filter({ visible: true });

async function choose(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label }).filter({ visible: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

/** Fills the rule form and saves it. */
async function saveRule(page: Page, percent: string, minimum: string) {
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(ar.pricing.form.percent, { exact: true }).fill(percent);
  await dialog.getByLabel(ar.pricing.form.minimum, { exact: true }).fill(minimum);
  await dialog.getByRole('button', { name: ar.pricing.form.save }).click();
}

test.describe('pricing', () => {
  test('shows the global rule and prices a cost with the calculator (step 6)', async ({
    page,
    admin,
  }) => {
    seed(admin);
    await page.goto('/pricing');
    await expect(page.getByRole('heading', { name: ar.pricing.title, level: 1 })).toBeVisible();
    await expect(page.getByText('10%', { exact: true })).toBeVisible();
    await expect(page.getByText('$0.10', { exact: true }).first()).toBeVisible();

    await field(page, ar.pricing.calculator.cost).fill('0.89');
    await expect(preview(page)).toContainText('$0.99');
    await expect(preview(page)).toContainText('$0.10');
    // $0.99 at 118 SYP per USD, rounded up to the 5 SYP step.
    await expect(preview(page)).toContainText('120 ل.س');
    await field(page, ar.pricing.calculator.cost).fill('8.50');
    await expect(preview(page)).toContainText('$9.35');
    await expect(preview(page)).toContainText('1,105 ل.س');

    // A new cost reads the preview again (a cached one keeps its rate).
    admin.rates = [];
    await field(page, ar.pricing.calculator.cost).fill('8.51');
    await expect(preview(page)).toContainText(ar.pricing.preview.noRate);
  });

  test('sets a category and a product rule after re-authentication, then archives them (steps 7–8)', async ({
    page,
    admin,
  }) => {
    const game = seed(admin);
    admin.reauthenticationRequired = true;
    await page.goto('/pricing');

    await page
      .getByRole('row')
      .filter({ hasText: 'ألعاب' })
      .getByRole('button', { name: ar.pricing.actions.customize })
      .click();
    await saveRule(page, '12', '0.15');
    await reauthenticate(page);
    await expect(page.getByRole('dialog')).toBeHidden();
    expect(admin.lastBody('PUT /api/admin/pricing/rules')).toEqual({
      scope: 'category',
      targetId: admin.catalog.categories[0]?.id,
      percentBp: 1200,
      fixedUsdUnits: 0,
      minMarginUsdUnits: 150_000,
    });

    // "60 UC" at $0.89 under the category rule: $1.04, no savings against $0.99.
    await choose(page, ar.pricing.calculator.scope, ar.pricing.scopes.product);
    await choose(page, ar.pricing.scopes.game, 'ببجي موبايل');
    await choose(page, ar.pricing.scopes.product, '60 UC');
    await field(page, ar.pricing.calculator.cost).fill('0.89');
    await expect(preview(page)).toContainText('$1.04');
    await expect(preview(page)).toContainText(ar.pricing.sources.category);
    await expect(preview(page)).toContainText('لا توفير');

    // The product rule, from the game's pricing tab: $0.94, savings 5%.
    await page.goto(`/catalog/games/${game.id}?tab=pricing`);
    await expect(page.getByText(ar.pricing.sources.category).first()).toBeVisible();
    await page
      .getByRole('row')
      .filter({ hasText: '60 UC' })
      .getByRole('button', { name: ar.pricing.actions.customize })
      .click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(ar.pricing.form.sampleCost).fill('0.89');
    await dialog.getByLabel(ar.pricing.form.percent, { exact: true }).fill('5');
    await dialog.getByLabel(ar.pricing.form.minimum, { exact: true }).fill('0.05');
    await expect(dialog.getByTestId('price-preview')).toContainText('$0.94');
    await expect(dialog.getByTestId('price-preview')).toContainText('(⁦5%⁩)');
    await dialog.getByRole('button', { name: ar.pricing.form.save }).click();
    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole('row').filter({ hasText: '60 UC' }).getByText(ar.pricing.sources.product),
    ).toBeVisible();

    // Step 8: archiving the product rule brings the category rule back; the global one stays.
    await page
      .getByRole('row')
      .filter({ hasText: '60 UC' })
      .getByRole('button', { name: ar.pricing.actions.archive })
      .click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: ar.pricing.archive.action })
      .click();
    await expect(
      page.getByRole('row').filter({ hasText: '60 UC' }).getByText(ar.pricing.sources.category),
    ).toBeVisible();
    await page.goto('/pricing');
    await expect(page.getByText(ar.pricing.overrides.empty)).toBeVisible();
    // The global rule has no archive action at all (rule PR2).
    await expect(
      page
        .getByRole('heading', { name: ar.pricing.global.title })
        .locator('..')
        .locator('..')
        .getByRole('button', { name: ar.pricing.actions.archive }),
    ).toHaveCount(0);
  });

  test('keeps the form values on a refused rule', async ({ page, admin }) => {
    seed(admin);
    await page.goto('/pricing');
    await page.getByRole('button', { name: ar.pricing.actions.edit }).first().click();
    await saveRule(page, '150', '0');
    await expect(page.getByText(ar.pricing.form.errors.percent)).toBeVisible();
    await expect(page.getByText(ar.pricing.form.errors.minimum)).toBeVisible();
    await expect(
      page.getByRole('dialog').getByLabel(ar.pricing.form.percent, { exact: true }),
    ).toHaveValue('150');
    expect(admin.calls).not.toContain('PUT /api/admin/pricing/rules');
  });
});

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('the pricing page, the rule form and re-authentication', async ({
      page,
      admin,
    }, testInfo) => {
      seed(admin);
      admin.reauthenticationRequired = true;
      await page.goto('/pricing');
      await expect(preview(page)).toContainText('$1.10');
      await screenshot(page, testInfo, `pricing-${colorScheme}`, { fullPage: true });

      await page.getByRole('button', { name: ar.pricing.actions.edit }).first().click();
      await expect(page.getByRole('dialog').getByTestId('price-preview')).toContainText('$1.10');
      await screenshot(page, testInfo, `pricing-rule-${colorScheme}`);
      await page.getByRole('dialog').getByRole('button', { name: ar.pricing.form.save }).click();
      await expect(page.getByRole('heading', { name: ar.reauth.title })).toBeVisible();
      await screenshot(page, testInfo, `pricing-reauth-${colorScheme}`);
    });
  });
}
