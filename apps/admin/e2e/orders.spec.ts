import type { Page } from '@playwright/test';
import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import { ORDER_IDS } from './orders-mock';
import { type AdminApi, expect, PASSWORD, screenshot, TOTP_CODE, test } from './test';

/*
 * Orders (S08): the list with its tabs and the badge, a held order's decisions with
 * re-authentication (poll again, refund), a manual order confirmed delivered with its codes, a
 * code revealed and hidden, and the policy, against the mocked API.
 */

const o = ar.orders;

const fill = (text: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce(
    (result, [key, value]) => result.replace(`{{${key}}}`, String(value)),
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

const rows = (page: Page) => page.getByRole('row').filter({ has: page.getByRole('cell') });

test.describe('orders', () => {
  test('lists every order, then the held and manual tabs; the badge counts both', async ({
    page,
    admin,
  }) => {
    await open(page, admin, '/orders');
    await expect(rows(page)).toHaveCount(4);
    const badge = page.getByLabel(fill(ar.nav.ordersBadge, { needsReview: 1, manualWaiting: 1 }));
    await expect(badge.first()).toHaveText('2');

    await page.getByRole('tab', { name: o.tabs.review }).click();
    await expect(page).toHaveURL(/tab=review/);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('VO-HELD23');

    await page.getByRole('tab', { name: o.tabs.manual }).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText(o.manualWaiting);
    await expect(rows(page).first()).toContainText(ar.wallets.testBadge);

    await page.getByRole('tab', { name: o.tabs.active }).click();
    await page.getByRole('searchbox').fill('nobody@example.com');
    await page.getByRole('button', { name: o.filters.apply }).click();
    await expect(page.getByText(o.empty.active)).toBeVisible();
  });

  test('polls a held order again, then refunds it with re-authentication (rules D4, D5)', async ({
    page,
    admin,
  }) => {
    await open(page, admin, `/orders/${ORDER_IDS.held}`);
    await expect(page.getByText(o.decisions.heldHelp)).toBeVisible();
    await expect(
      page.getByRole('cell', { name: o.skipReasons.supplier_unavailable }),
    ).toBeVisible();

    admin.reauthenticationRequired = true;
    await page.getByRole('button', { name: o.decisions.poll.open }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel(o.decisions.reason).fill('قصير');
    await dialog.getByRole('button', { name: o.decisions.poll.submit }).click();
    await expect(dialog.getByText(o.decisions.reasonError)).toBeVisible();
    await dialog.getByLabel(o.decisions.reason).fill('المورد قال إنه نفّذه');
    await dialog.getByRole('button', { name: o.decisions.poll.submit }).click();
    await reauthenticate(page);
    await expect(page.getByRole('heading', { name: o.decisions.poll.title })).toBeHidden();
    admin.reauthenticationRequired = false;

    await page.getByRole('button', { name: o.decisions.refund.open }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByText(o.decisions.refund.warning)).toBeVisible();
    await dialog.getByLabel(o.decisions.reason).fill('لا جواب من المورد منذ ساعة');
    await dialog.getByRole('button', { name: o.decisions.refund.submit }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(o.statuses.refunded, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(o.decisions.heldHelp)).toBeHidden();
    expect(admin.orders.counts().needsReview).toBe(0);
  });

  test('confirms a manual code order delivered, asking one code per unit (rule D2)', async ({
    page,
    admin,
  }) => {
    await open(page, admin, `/orders/${ORDER_IDS.manual}`);
    await page.getByRole('button', { name: o.decisions.delivered.open }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel(o.decisions.delivered.quantity)).toHaveValue('2');
    await dialog.getByLabel(o.decisions.delivered.codes).fill('CODE-AAAA-1111');
    await dialog.getByLabel(o.decisions.reason).fill('سلّمني المورد الكودين يدوياً');
    await dialog.getByRole('button', { name: o.decisions.delivered.submit }).click();
    await expect(dialog.getByText(o.decisions.delivered.codesError)).toBeVisible();
    await dialog.getByLabel(o.decisions.delivered.codes).fill('CODE-AAAA-1111\nCODE-BBBB-2222');
    await dialog.getByRole('button', { name: o.decisions.delivered.submit }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(o.statuses.delivered, { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: o.codes.title })).toBeVisible();
  });

  test('reveals a code with re-authentication, logs it and hides it again (rule C3)', async ({
    page,
    admin,
  }) => {
    await open(page, admin, `/orders/${ORDER_IDS.delivered}`);
    await expect(page.getByText('•••• 7Q2M')).toBeVisible();
    await expect(page.getByText('203.0.113.7')).toBeVisible();
    admin.reauthenticationRequired = true;
    await page.getByRole('button', { name: o.codes.reveal }).click();
    await reauthenticate(page);
    await expect(page.getByText('ITUNES-7K2M-9Q4X-7Q2M')).toBeVisible();
    await expect(page.getByText(o.codes.revealedBy.admin.split('{{')[0] as string)).toBeVisible();
    await page.getByRole('button', { name: o.codes.hide }).click();
    await expect(page.getByText('ITUNES-7K2M-9Q4X-7Q2M')).toBeHidden();
  });

  test('saves the policy with re-authentication, refusing a value out of bounds', async ({
    page,
    admin,
  }) => {
    await open(page, admin, '/orders/policy');
    const hardLimit = page.getByLabel(o.policy.fields.hardLimitMinutes.label, { exact: true });
    await hardLimit.fill('2');
    await page.getByRole('button', { name: o.policy.save }).click();
    await expect(page.getByText(o.policy.fields.hardLimitMinutes.error)).toBeVisible();
    await hardLimit.fill('5');
    admin.reauthenticationRequired = true;
    await page.getByRole('button', { name: o.policy.save }).click();
    await reauthenticate(page);
    await expect(page.getByText(o.policy.saved)).toBeVisible();
    expect(admin.orders.policy.hardLimitMinutes).toBe(5);
  });
});

// RTL screenshots of the S08 admin screens in both themes: the design review evidence (ADR 0011).
for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('S08 screenshots', async ({ page, admin }, testInfo) => {
      await open(page, admin, '/orders');
      await expect(rows(page)).toHaveCount(4);
      await screenshot(page, testInfo, `orders-${colorScheme}`);
      await page.goto(`/orders/${ORDER_IDS.held}`);
      await expect(page.getByText(o.decisions.heldHelp)).toBeVisible();
      await screenshot(page, testInfo, `order-held-${colorScheme}`, { fullPage: true });
      await page.getByRole('button', { name: o.decisions.refund.open }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await screenshot(page, testInfo, `order-refund-${colorScheme}`);
      await page.keyboard.press('Escape');
      await page.goto(`/orders/${ORDER_IDS.manual}`);
      await page.getByRole('button', { name: o.decisions.delivered.open }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await screenshot(page, testInfo, `order-manual-${colorScheme}`);
      await page.keyboard.press('Escape');
      await page.goto('/orders/policy');
      await expect(page.getByRole('button', { name: o.policy.save })).toBeVisible();
      await screenshot(page, testInfo, `order-policy-${colorScheme}`, { fullPage: true });
    });
  });
}
