import type { Page } from '@playwright/test';
import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import { CUSTOMER_IDS } from './customers-mock';
import { type AdminApi, expect, PASSWORD, screenshot, TOTP_CODE, test } from './test';

/*
 * Purchases from the panel (S16 AP1–AP14): "/orders/new" in each mode against the mocked API,
 * with the re-authentication, the player check, the owner cap refusal, the order page's origin
 * and the list's mode chips; RTL screenshots in both themes.
 */

const o = ar.orders;
const b = ar.orders.buy;

const fill = (text: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce(
    (result, [key, value]) => result.replace(`{{${key}}}`, String(value)),
    text,
  );

/** ببجي موبايل with its player id field, "60 UC" routed to the fake, "325 UC" paused. */
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
  const uc60 = admin.catalog.addProduct(game.id, { nameAr: '60 UC', gameAmount: 60 });
  const uc325 = admin.catalog.addProduct(game.id, {
    nameAr: '325 UC',
    gameAmount: 325,
    status: 'paused',
  });
  const card = admin.catalog.addProduct(game.id, { nameAr: 'بطاقة 10$', kind: 'code' });
  admin.suppliers.connectFake();
  admin.suppliers.map(uc60.id, 'fake', 'fake-uc-60', { playerId: 'player_id' });
  admin.suppliers.map(uc325.id, 'fake', 'fake-uc-60', { playerId: 'player_id' });
  admin.suppliers.map(card.id, 'fake', 'fake-gift-10');
  admin.signedIn = true;
  return { game, uc60, uc325, card };
}

async function reauthenticate(page: Page) {
  await expect(page.getByRole('heading', { name: ar.reauth.title })).toBeVisible();
  await page.getByLabel(ar.reauth.password, { exact: true }).fill(PASSWORD);
  await page.getByRole('textbox').filter({ visible: true }).nth(1).pressSequentially(TOTP_CODE);
  await page.getByRole('button', { name: ar.reauth.submit }).click();
}

/** The pack step: the game, then the pack by name. */
async function pickPack(page: Page, pack: string) {
  await page.getByRole('combobox', { name: b.game }).click();
  await page.getByRole('option', { name: 'ببجي موبايل' }).click();
  await page.getByRole('radio', { name: pack }).check();
}

async function pickCustomer(page: Page, name: string) {
  await page.getByRole('searchbox').fill('سارة');
  await page.getByRole('button', { name: b.search }).click();
  await page.getByRole('button', { name: new RegExp(name) }).click();
}

test('a walk-in order: the player check, re-authentication, then the order page (AP1, AP8, AP12)', async ({
  page,
  admin,
}) => {
  seed(admin);
  admin.reauthenticationRequired = true;
  await page.goto('/orders');
  await page.getByRole('link', { name: b.open }).click();
  await expect(page).toHaveURL('/orders/new');
  await page.getByRole('radio', { name: o.purposes.walk_in }).check();
  await expect(page.getByText(b.steps.customer)).toHaveCount(0);
  await pickPack(page, '60 UC');
  await page.getByRole('textbox', { name: 'معرّف اللاعب' }).fill('5123456789');
  await page.getByRole('button', { name: b.check }).click();
  await expect(page.getByText(fill(b.checkValid, { name: 'Player 6789' }))).toBeVisible();
  await page.getByRole('textbox', { name: b.reason }).fill('Bought at the counter');
  await expect(page.getByText(b.payerOf.owner).last()).toBeVisible();
  await page.getByRole('button', { name: b.confirm }).click();
  await reauthenticate(page);
  await expect(page).toHaveURL(/\/orders\/0199b000-/);
  await expect(page.getByText(o.walkInCustomer).first()).toBeVisible();
  await expect(page.getByText('Bought at the counter')).toBeVisible();
  await expect(page.getByText(o.payers.owner, { exact: true }).first()).toBeVisible();
  // The list shows the mode chip and filters by it.
  await page.goto('/orders?purpose=walk_in');
  await expect(page.getByText(o.purposes.walk_in).last()).toBeVisible();
  expect(admin.calls).toContain('POST /api/admin/orders');
});

test("a code pack still takes the game's fields, without the player check (S08 O5, AP8)", async ({
  page,
  admin,
}) => {
  seed(admin);
  await page.goto('/orders/new?purpose=walk_in');
  await pickPack(page, 'بطاقة 10$');
  await page.getByRole('textbox', { name: 'معرّف اللاعب' }).fill('5123456789');
  await expect(page.getByRole('button', { name: b.check })).toHaveCount(0);
  await page.getByRole('textbox', { name: b.reason }).fill('Card sold at the counter');
  await page.getByRole('button', { name: b.confirm }).click();
  await expect(page).toHaveURL(/\/orders\/0199b000-/);
  expect(admin.lastBody('POST /api/admin/orders')).toMatchObject({
    fields: { player_id: '5123456789' },
  });
});

test('on behalf of a customer: the wallet and the balance after (AP4, AM1)', async ({
  page,
  admin,
}) => {
  seed(admin);
  await page.goto(`/orders/new?purpose=on_behalf&customerId=${CUSTOMER_IDS.sara}`);
  await expect(page.getByText(fill(b.balance, { balance: '⁦$25.00⁩' }))).toBeVisible();
  await pickPack(page, '60 UC');
  await page.getByRole('textbox', { name: 'معرّف اللاعب' }).fill('5123456789');
  await page.getByRole('textbox', { name: b.reason }).fill('Asked on WhatsApp');
  await expect(page.getByText(b.balanceAfter)).toBeVisible();
  // The paused pack is not offered to a customer's wallet.
  await expect(page.getByRole('radio', { name: '325 UC' })).toBeDisabled();
  await page.getByRole('button', { name: b.confirm }).click();
  await expect(page).toHaveURL(/\/orders\/0199b000-/);
  await expect(page.getByText(o.purposes.on_behalf).first()).toBeVisible();
});

test('a gift from owner funds, a paused pack for a trial, and the owner cap (AP5, AP7)', async ({
  page,
  admin,
}) => {
  seed(admin);
  admin.orders.policy = { ...admin.orders.policy, ownerDailyCapUsdUnits: 500_000 };
  await page.goto('/orders/new');
  await page.getByRole('radio', { name: o.purposes.gift }).check();
  await pickCustomer(page, 'سارة');
  await pickPack(page, '325 UC');
  await expect(page.getByText(b.trial)).toBeVisible();
  await page.getByRole('textbox', { name: 'معرّف اللاعب' }).fill('5123456789');
  await page.getByRole('textbox', { name: b.reason }).fill('Loyal customer gift');
  await page.getByRole('textbox', { name: b.note }).fill('عيد سعيد');
  await page.getByRole('button', { name: b.confirm }).click();
  await expect(page.getByText(/سقف مال المالك اليوم/)).toBeVisible();
  await expect(page.getByRole('link', { name: o.policy.link })).toBeVisible();
  // Room again: the same page buys it.
  admin.orders.policy = { ...admin.orders.policy, ownerDailyCapUsdUnits: 100_000_000 };
  await page.getByRole('button', { name: b.confirm }).click();
  await expect(page).toHaveURL(/\/orders\/0199b000-/);
  await expect(page.getByText('عيد سعيد')).toBeVisible();
});

test('a frozen customer cannot be picked; the policy sets the owner cap (AP4, AP7)', async ({
  page,
  admin,
}) => {
  seed(admin);
  await page.goto(`/orders/new?purpose=compensation&customerId=${CUSTOMER_IDS.rami}`);
  await expect(page.getByText(b.frozenHelp)).toBeVisible();
  await page.goto('/orders/policy');
  const cap = page.getByRole('textbox', { name: o.policy.fields.ownerDailyCapUsdUnits.label });
  await expect(cap).toHaveValue('100');
  await cap.fill('1');
  await page.getByRole('button', { name: o.policy.save }).click();
  await expect(page.getByText(o.policy.saved)).toBeVisible();
  expect(admin.orders.policy.ownerDailyCapUsdUnits).toBe(1_000_000);
});

// RTL screenshots of the S16 purchase screens in both themes (ADR 0011).
for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('S16 admin purchase screenshots', async ({ page, admin }, testInfo) => {
      seed(admin);
      await page.goto(`/orders/new?purpose=gift&customerId=${CUSTOMER_IDS.sara}`);
      await pickPack(page, '60 UC');
      await page.getByRole('textbox', { name: 'معرّف اللاعب' }).fill('5123456789');
      await page.getByRole('button', { name: b.check }).click();
      await expect(page.getByText(fill(b.checkValid, { name: 'Player 6789' }))).toBeVisible();
      await page.getByRole('textbox', { name: b.reason }).fill('Loyal customer gift');
      await page.getByRole('textbox', { name: b.note }).fill('عيد سعيد');
      await screenshot(page, testInfo, `orders-new-${colorScheme}`, { fullPage: true });
      await page.getByRole('button', { name: b.confirm }).click();
      await expect(page).toHaveURL(/\/orders\/0199b000-/);
      await screenshot(page, testInfo, `orders-admin-order-${colorScheme}`, { fullPage: true });
    });
  });
}
