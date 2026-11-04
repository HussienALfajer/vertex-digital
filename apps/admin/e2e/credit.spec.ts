import type { Page } from '@playwright/test';
import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import { ORDER_IDS } from './orders-mock';
import { type AdminApi, chooseOption, expect, PASSWORD, screenshot, TOTP_CODE, test } from './test';

/*
 * S25 (F44) in the panel: an `amount` product (AM1, AM6), a game's service class (CL1), the
 * credit policy, and a cash order's approval hold (CS3, CS4) on the order page and the live room,
 * against the mocked API.
 */

const p = ar.catalog.products;
const sc = ar.catalog.serviceClass;
const hold = ar.orders.cashHold;
const policy = ar.creditPolicy;

const fill = (text: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{{${key}}}`, String(value)),
    text,
  );

async function open(page: Page, admin: AdminApi, path: string) {
  admin.signedIn = true;
  await page.goto(path);
}

async function reauthenticate(page: Page) {
  await expect(page.getByRole('heading', { name: ar.reauth.title })).toBeVisible();
  await page.getByLabel(ar.reauth.password, { exact: true }).fill(PASSWORD);
  await page.getByRole('textbox').filter({ visible: true }).nth(1).pressSequentially(TOTP_CODE);
  await page.getByRole('button', { name: ar.reauth.submit }).click();
}

/** A bill game with its one recipient field, as S25 SC1 sets it up. */
function billGame(admin: AdminApi, fields = 1) {
  const game = admin.catalog.addGame({
    categorySlug: 'games',
    slug: 'syriatel-bill',
    nameAr: 'فاتورة سيريتل',
    nameEn: 'Syriatel bill',
  });
  admin.catalog.addField(game.id, { key: 'number', labelAr: 'رقم الفاتورة', type: 'digits' });
  if (fields > 1) admin.catalog.addField(game.id, { key: 'name', labelAr: 'الاسم', type: 'text' });
  return game;
}

test.describe('credit section', () => {
  test('adds an amount product typed in SYP and shows its range (AM1, AM6)', async ({
    page,
    admin,
  }) => {
    const game = billGame(admin);
    await open(page, admin, `/catalog/games/${game.id}?tab=products`);
    await page.getByRole('button', { name: p.add }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: p.kinds.amount }).click();
    await expect(dialog.getByLabel(p.maxQuantity, { exact: true })).toBeHidden();
    await expect(dialog.getByLabel(p.amountUnit)).toHaveValue('ل.س');
    await dialog.getByLabel(p.name, { exact: true }).fill('فاتورة بمبلغ حر');
    await dialog.getByLabel(p.minAmount).fill('1050');
    await dialog.getByRole('button', { name: p.addSubmit }).click();
    await expect(dialog.getByText(p.errors.amountBounds).first()).toBeVisible();
    await dialog.getByLabel(p.minAmount).fill('1,000');
    await dialog.getByRole('button', { name: p.addSubmit }).click();
    await expect(dialog).toBeHidden();
    expect(admin.lastBody(`POST /api/admin/catalog/games/${game.id}/products`)).toMatchObject({
      kind: 'amount',
      minQuantity: 10,
      maxQuantity: 1_000,
      amountUnitAr: 'ل.س',
    });
    await expect(
      page.getByText(fill(p.amountRange, { min: '1,000', max: '100,000', unit: 'ل.س' })),
    ).toBeVisible();
  });

  test('sets a service class, refused for a game without one recipient field (CL1)', async ({
    page,
    admin,
  }) => {
    const game = billGame(admin);
    const other = admin.catalog.addGame({
      categorySlug: 'games',
      slug: 'mtn-cash',
      nameAr: 'MTN كاش',
      nameEn: 'MTN Cash',
    });
    admin.catalog.addField(other.id, { key: 'number', labelAr: 'الرقم' });
    admin.catalog.addField(other.id, { key: 'name', labelAr: 'الاسم', type: 'text' });

    await open(page, admin, `/catalog/games/${game.id}?tab=fields`);
    const trigger = page.getByRole('combobox', { name: sc.label });
    await chooseOption(page, trigger, sc.classes.credit);
    admin.reauthenticationRequired = true;
    await page.getByRole('button', { name: ar.catalog.actions.save, exact: true }).click();
    await reauthenticate(page);
    await expect(page.getByText(sc.saved)).toBeVisible();
    admin.reauthenticationRequired = false;
    expect(admin.lastBody(`PUT /api/admin/catalog/games/${game.id}/service-class`)).toEqual({
      serviceClass: 'credit',
    });

    await page.goto(`/catalog/games/${other.id}?tab=fields`);
    await chooseOption(page, page.getByRole('combobox', { name: sc.label }), sc.classes.cash);
    await page.getByRole('button', { name: ar.catalog.actions.save, exact: true }).click();
    await expect(page.getByText(sc.needsRecipient)).toBeVisible();
  });

  test('saves the credit policy in dollars, refusing a bad value', async ({ page, admin }) => {
    await open(page, admin, '/settings/credit');
    const retail = page.getByLabel(policy.fields.retailDailyUsdUnits.label);
    await expect(retail).toHaveValue('50');
    await retail.fill('60');
    await page.getByLabel(policy.fields.recipientAlertDays.label).fill('0');
    await page.getByRole('button', { name: policy.save }).click();
    await expect(page.getByText(policy.errors.days)).toBeVisible();
    await page.getByLabel(policy.fields.recipientAlertDays.label).fill('7');
    admin.reauthenticationRequired = true;
    await page.getByRole('button', { name: policy.save }).click();
    await reauthenticate(page);
    await expect(page.getByText(policy.saved)).toBeVisible();
    admin.reauthenticationRequired = false;
    expect(admin.lastBody('PUT /api/admin/credit-policy')).toMatchObject({
      retailDailyUsdUnits: 60_000_000,
      recipientAlertDays: 7,
    });
  });

  test('approves one held cash order and rejects another (CS3, CS4)', async ({ page, admin }) => {
    admin.orders.addCashOrders();
    await open(page, admin, `/orders/${ORDER_IDS.slow}`);
    await expect(page.getByText('15,000 ل.س')).toBeVisible();
    await expect(page.getByText('093 312 3456').first()).toBeVisible();
    await expect(page.getByText(hold.states.held).first()).toBeVisible();

    admin.reauthenticationRequired = true;
    await page.getByRole('button', { name: hold.approve.open, exact: true }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: hold.approve.submit }).click();
    await reauthenticate(page);
    await expect(page.getByRole('heading', { name: hold.approve.title })).toBeHidden();
    admin.reauthenticationRequired = false;
    await expect(page.getByText(hold.states.approved).first()).toBeVisible();
    await expect(page.getByRole('button', { name: hold.approve.open, exact: true })).toBeHidden();
    expect(admin.lastBody(`POST /api/admin/orders/${ORDER_IDS.slow}/cash-approval`)).toEqual({
      decision: 'approve',
    });

    await page.goto(`/orders/${ORDER_IDS.fresh}`);
    await page.getByRole('button', { name: hold.reject.open, exact: true }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('$12.00');
    await dialog.getByLabel(hold.reason).fill('حساب جديد وإيداع حديث');
    await dialog
      .getByRole('button', { name: new RegExp(hold.reject.submit.split(' {{')[0] as string) })
      .click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(hold.states.rejected).first()).toBeVisible();
    await expect(page.getByText(ar.orders.refundReasons.cash_rejected).first()).toBeVisible();
    expect(admin.lastBody(`POST /api/admin/orders/${ORDER_IDS.fresh}/cash-approval`)).toEqual({
      decision: 'reject',
      reason: 'حساب جديد وإيداع حديث',
    });
  });

  test('lists held cash orders in the live room and the orders tab', async ({ page, admin }) => {
    admin.orders.addCashOrders();
    await open(page, admin, '/orders/live');
    const column = page.locator('section[data-column="cash_hold"]');
    await expect(column.getByRole('button', { name: /VO-CASH15/ })).toBeVisible();
    await expect(column.getByRole('button', { name: /VO-CASH12/ })).toBeVisible();
    await page.goto('/orders?tab=cash_hold');
    await expect(page.getByRole('link', { name: 'VO-CASH15' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'VO-HELD23' })).toBeHidden();
  });
});

// RTL screenshots of the S25 admin screens in both themes: the design review evidence (ADR 0011).
for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('S25 screenshots', async ({ page, admin }, testInfo) => {
      const game = billGame(admin);
      admin.catalog.addProduct(game.id, {
        kind: 'amount',
        nameAr: 'فاتورة بمبلغ حر',
        minQuantity: 10,
        maxQuantity: 1_000,
        amountUnitAr: 'ل.س',
        amountStep: 100,
      });
      admin.orders.addCashOrders();
      await open(page, admin, `/catalog/games/${game.id}?tab=products`);
      await expect(page.getByText('فاتورة بمبلغ حر')).toBeVisible();
      await screenshot(page, testInfo, `credit-products-${colorScheme}`, { fullPage: true });
      await page.getByRole('button', { name: p.add }).click();
      await page.getByRole('dialog').getByRole('button', { name: p.kinds.amount }).click();
      await screenshot(page, testInfo, `credit-product-dialog-${colorScheme}`);
      await page.keyboard.press('Escape');
      await page.goto(`/catalog/games/${game.id}?tab=fields`);
      await expect(page.getByRole('combobox', { name: sc.label })).toBeVisible();
      await screenshot(page, testInfo, `credit-service-class-${colorScheme}`, { fullPage: true });
      await page.goto('/settings/credit');
      await expect(page.getByRole('button', { name: policy.save })).toBeVisible();
      await screenshot(page, testInfo, `credit-policy-${colorScheme}`, { fullPage: true });
      await page.goto(`/orders/${ORDER_IDS.slow}`);
      await expect(
        page.getByRole('button', { name: hold.approve.open, exact: true }),
      ).toBeVisible();
      await screenshot(page, testInfo, `credit-order-held-${colorScheme}`, { fullPage: true });
      await page.getByRole('button', { name: hold.reject.open, exact: true }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await screenshot(page, testInfo, `credit-order-reject-${colorScheme}`);
      await page.keyboard.press('Escape');
      await page.goto('/orders/live');
      await expect(
        page.locator('section[data-column="cash_hold"]').getByRole('button', { name: /VO-CASH15/ }),
      ).toBeVisible();
      await screenshot(page, testInfo, `credit-live-${colorScheme}`);
    });
  });
}
