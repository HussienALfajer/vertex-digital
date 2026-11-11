import type { Page } from '@playwright/test';
import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import { shopId } from './shops-mock';
import { type AdminApi, chooseOption, expect, PASSWORD, screenshot, TOTP_CODE, test } from './test';

/*
 * Merchant shops in the panel (S26 PR 4) against the mocked API: a request approved with its
 * limits (SH3, SH8), a suspension with its category and resume (SH6), the shop page's tabs, a
 * closed shop's customer settled with re-authentication (WL9), and a shop order's compensation on
 * the order page (PR10), with RTL screenshots in both themes.
 */

const s = ar.shops;
const DELIVERED = '0199b000-0000-7000-8000-000000000003';

const field = (page: Page, label: string) =>
  page.getByLabel(label, { exact: true }).filter({ visible: true });

async function reauthenticate(page: Page) {
  await expect(page.getByRole('heading', { name: ar.reauth.title })).toBeVisible();
  await field(page, ar.reauth.password).fill(PASSWORD);
  await page.getByRole('textbox').filter({ visible: true }).nth(1).pressSequentially(TOTP_CODE);
  await page.getByRole('button', { name: ar.reauth.submit }).click();
}

/** The delivered order of the orders mock, made a shop order with its margin released. */
function shopOrder(admin: AdminApi) {
  const order = admin.orders.orders.find((item) => item.id === DELIVERED);
  if (!order) throw new Error('No delivered order in the mock');
  order.shopSale = {
    shop: { id: shopId(2), slug: 'noor', displayName: 'محل النور' },
    shopCustomer: { id: shopId(201), name: 'سامي علي' },
    unitSellUsdUnits: 1_200_000,
    totalSellUsdUnits: 1_200_000,
    marginReleasedUsdUnits: 210_000,
    compensatedQuantity: 0,
  };
  return order;
}

test.describe('shops', () => {
  test('approves a request with its limits, then suspends and resumes the shop', async ({
    page,
    admin,
  }) => {
    admin.signedIn = true;
    await page.goto('/shops');
    await page.getByRole('link', { name: 'محل أبو عمر' }).click();
    await expect(page).toHaveURL(`/shops/${shopId(1)}`);
    await page.getByRole('button', { name: s.actions.approve }).click();
    const dialog = page.getByRole('dialog');
    // A refused limit shows under its field, and nothing is sent.
    await field(page, s.limits.balanceCap).fill('9000');
    await dialog.getByRole('button', { name: s.approve.submit }).click();
    await expect(dialog.getByText(s.limits.balanceCapError)).toBeVisible();
    await field(page, s.limits.balanceCap).fill('150');
    await dialog.getByRole('button', { name: s.approve.submit }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(s.statuses.active).first()).toBeVisible();
    expect(admin.bodies.find((item) => item.key.endsWith('/approve'))?.body).toEqual({
      limits: {
        customerBalanceCapUsdUnits: 150_000_000,
        dailyTransferCapUsdUnits: 1_000_000_000,
        customerLimit: 2_000,
      },
    });

    await page.getByRole('button', { name: s.actions.suspend }).click();
    await chooseOption(
      page,
      page.getByRole('combobox', { name: s.suspend.reason }),
      s.suspendReasons.complaints,
    );
    await field(page, s.suspend.note).fill('شكاوى متكررة من التأخير');
    await page.getByRole('dialog').getByRole('button', { name: s.suspend.submit }).click();
    await expect(
      page.getByText(s.notice.suspended.replace('{{reason}}', s.suspendReasons.complaints)),
    ).toBeVisible();
    await page.getByRole('button', { name: s.actions.resume }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: s.resume.submit }).click();
    await expect(page.getByText(s.statuses.active).first()).toBeVisible();
  });

  test('settles a closed shop customer with re-authentication (WL9)', async ({ page, admin }) => {
    admin.signedIn = true;
    admin.reauthenticationRequired = true;
    await page.goto(`/shops/${shopId(3)}?tab=customers`);
    await page.getByRole('button', { name: s.customers.settle }).click();
    const dialog = page.getByRole('dialog');
    await chooseOption(
      page,
      dialog.getByRole('combobox', { name: s.settle.to }),
      s.settle.targets.merchant,
    );
    await field(page, s.fields.reason).fill('وافق التاجر على الدفع نقداً');
    await dialog
      .getByRole('button', { name: s.settle.submit.replace('{{amount}}', '⁦$12.00⁩') })
      .click();
    await reauthenticate(page);
    await expect(page.getByRole('dialog')).toBeHidden();
    const settle = admin.requests.find((item) => item.key.endsWith('/settle'));
    expect(settle?.headers['idempotency-key']).toBeTruthy();
    await page.getByRole('tab', { name: s.sections.overview }).click();
    await expect(page.getByText(s.notice.settled)).toBeVisible();
  });

  test("compensates a shop order's customer from the order page (PR10)", async ({
    page,
    admin,
  }) => {
    admin.signedIn = true;
    shopOrder(admin);
    await page.goto(`/orders/${DELIVERED}`);
    await expect(page.getByText(s.order.title)).toBeVisible();
    await page.getByRole('button', { name: s.order.compensate }).click();
    const dialog = page.getByRole('dialog');
    await field(page, s.fields.reason).fill('الكود لا يعمل');
    await expect(dialog.getByText('$0.99')).toBeVisible();
    await dialog.getByRole('button', { name: s.compensation.submit }).click();
    await expect(dialog).toBeHidden();
    expect(admin.bodies.find((item) => item.key.endsWith('/shop-compensation'))?.body).toEqual({
      units: 1,
      reason: 'الكود لا يعمل',
      marginFrom: 'merchant',
    });
    // Every delivered unit is compensated: the action is gone.
    await expect(page.getByRole('button', { name: s.order.compensate })).toHaveCount(0);
  });
});

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('the shops pages', async ({ page, admin }, testInfo) => {
      test.setTimeout(90_000);
      admin.signedIn = true;
      shopOrder(admin);
      await page.goto('/shops?tab=all');
      await expect(page.getByRole('link', { name: 'محل النور' })).toBeVisible();
      await screenshot(page, testInfo, `shops-${colorScheme}`);
      await page.goto(`/shops/${shopId(2)}`);
      await expect(page.getByText(s.overview.heldMargin)).toBeVisible();
      await screenshot(page, testInfo, `shop-${colorScheme}`, { fullPage: true });
      await page.getByRole('tab', { name: s.sections.customers }).click();
      await expect(page.getByText('سامي علي')).toBeVisible();
      await screenshot(page, testInfo, `shop-customers-${colorScheme}`);
      await page.getByRole('tab', { name: s.sections.orders }).click();
      await expect(page.getByRole('link', { name: 'VO-DONE67' })).toBeVisible();
      await screenshot(page, testInfo, `shop-orders-${colorScheme}`);
      await page.goto(`/shops/${shopId(1)}`);
      await page.getByRole('button', { name: s.actions.approve }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await screenshot(page, testInfo, `shop-approve-${colorScheme}`);
      await page.goto(`/orders/${DELIVERED}`);
      await page.getByRole('button', { name: s.order.compensate }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await screenshot(page, testInfo, `shop-compensation-${colorScheme}`);
    });
  });
}
