import type { Page } from '@playwright/test';
import { ROOT_PRICE_LIST_IDS } from '@vertex-digital/contracts';
import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import { CUSTOMER_IDS } from './customers-mock';
import { type AdminApi, expect, PASSWORD, screenshot, TOTP_CODE, test } from './test';

/*
 * Price lists (S20 PR 2) against the mocked API: the lists, a custom list with its fixed price
 * falling back (LP1), the matrix, and an account's list from the profile (AT2), with RTL
 * screenshots in both themes. The fake's 60 UC costs $0.88: retail $0.98, wholesale $0.93, cost
 * $0.89.
 */

const field = (page: Page, label: string) =>
  page.getByLabel(label, { exact: true }).filter({ visible: true });

async function reauthenticate(page: Page) {
  await expect(page.getByRole('heading', { name: ar.reauth.title })).toBeVisible();
  await field(page, ar.reauth.password).fill(PASSWORD);
  await page.getByRole('textbox').filter({ visible: true }).nth(1).pressSequentially(TOTP_CODE);
  await page.getByRole('button', { name: ar.reauth.submit }).click();
}

async function choose(page: Page, label: string, option: string) {
  await page.getByRole('combobox', { name: label }).filter({ visible: true }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

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
  admin.suppliers.connectFake();
  admin.suppliers.map(product.id, 'fake', 'fake-uc-60', { playerId: 'player_id' });
  admin.signedIn = true;
  return { game, product };
}

test.describe('price lists', () => {
  test('creates a custom list under wholesale after re-authentication (LS1)', async ({
    page,
    admin,
  }) => {
    seed(admin);
    admin.reauthenticationRequired = true;
    await page.goto('/pricing/lists');
    await expect(page.getByRole('link', { name: 'الجملة', exact: true })).toBeVisible();
    await page.getByRole('button', { name: ar.pricing.lists.create }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(ar.pricing.lists.columns.name, { exact: true }).fill('VIP');
    await choose(page, ar.pricing.lists.columns.parent, 'الجملة');
    await dialog.getByRole('button', { name: ar.pricing.lists.save }).click();
    await reauthenticate(page);
    await expect(page.getByRole('link', { name: 'VIP', exact: true })).toBeVisible();
    expect(admin.calls).toContain('POST /api/admin/pricing/lists');
  });

  test('sets a fixed price below the margin and shows its fallback (LP1, decision 6)', async ({
    page,
    admin,
  }) => {
    seed(admin);
    const vip = admin.priceLists.addList('VIP', ROOT_PRICE_LIST_IDS.wholesale, 300);
    await page.goto(`/pricing/lists/${vip.id}`);
    await expect(page.getByRole('heading', { name: 'VIP', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: ar.pricing.list.addFixed }).click();
    await choose(page, ar.pricing.scopes.game, 'ببجي موبايل');
    await choose(page, ar.pricing.scopes.product, '60 UC');
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(ar.pricing.fixed.price, { exact: true }).fill('0.89');
    // $0.89 leaves $0.01 over the $0.88 cost, below VIP's $0.02: the rule's $0.91 applies.
    const result = dialog.getByRole('region', { name: ar.pricing.fixed.result });
    await expect(result).toContainText('$0.91');
    await expect(result).toContainText(ar.pricing.priceSources.fixed_fallback);
    await dialog.getByRole('button', { name: ar.pricing.fixed.save }).click();
    const row = page.getByRole('row', { name: /60 UC/ });
    await expect(row).toContainText('$0.89');
    await expect(row).toContainText('$0.91');
    await expect(row).toContainText(ar.pricing.priceSources.fixed_fallback);
  });

  test('reads the matrix of a game on the chosen lists', async ({ page, admin }) => {
    const { game } = seed(admin);
    await page.goto(`/pricing/matrix?gameId=${game.id}`);
    const row = page.getByRole('row', { name: /60 UC/ });
    await expect(row).toContainText('$0.98');
    await expect(row).toContainText('$0.93');
    await expect(row).toContainText('$0.89');
  });

  test('assigns the cost list from the profile (AT2)', async ({ page, admin }) => {
    seed(admin);
    await page.goto(`/customers/${CUSTOMER_IDS.layla}`);
    await page.getByRole('button', { name: ar.customers.pricing.change }).click();
    await choose(page, ar.customers.pricing.list, 'سعر التكلفة');
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(ar.customers.dialogs.reason, { exact: true }).fill('حساب شريك معتمد');
    await dialog.getByRole('button', { name: ar.customers.pricing.save }).click();
    await expect(page.getByRole('link', { name: 'سعر التكلفة' })).toBeVisible();
    await expect(page.getByText(ar.customers.pricing.kinds.special)).toBeVisible();
  });
});

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('the lists, a list page, the matrix and the profile card', async ({
      page,
      admin,
    }, testInfo) => {
      const { game, product } = seed(admin);
      const vip = admin.priceLists.addList('VIP', ROOT_PRICE_LIST_IDS.wholesale, 300);
      admin.priceLists.setFixed(vip.id, product.id, 890_000);
      admin.priceLists.assigned.set(CUSTOMER_IDS.layla, vip.id);

      await page.goto('/pricing/lists');
      await expect(page.getByRole('link', { name: 'VIP', exact: true })).toBeVisible();
      await screenshot(page, testInfo, `price-lists-${colorScheme}`, { fullPage: true });

      await page.goto(`/pricing/lists/${vip.id}`);
      await expect(page.getByRole('row', { name: /60 UC/ })).toContainText('$0.91');
      await screenshot(page, testInfo, `price-list-${colorScheme}`, { fullPage: true });

      await page.goto(
        `/pricing/matrix?gameId=${game.id}&lists=${vip.id},${ROOT_PRICE_LIST_IDS.cost}`,
      );
      await expect(page.getByRole('row', { name: /60 UC/ })).toContainText('$0.91');
      await screenshot(page, testInfo, `price-matrix-${colorScheme}`, { fullPage: true });

      await page.goto(`/customers/${CUSTOMER_IDS.layla}`);
      await expect(page.getByRole('link', { name: 'VIP' })).toBeVisible();
      await screenshot(page, testInfo, `customer-pricing-${colorScheme}`, { fullPage: true });
    });
  });
}
