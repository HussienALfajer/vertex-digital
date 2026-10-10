import type { Page } from '@playwright/test';
import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import { CUSTOMER_IDS } from './customers-mock';
import { ORDER_IDS } from './orders-mock';
import { type AdminApi, expect, PASSWORD, screenshot, TOTP_CODE, test } from './test';

/*
 * Customers (S12 F19): the search by email, phone and order number with the status tabs, the
 * profile's tabs (summary with limits and signals, orders, devices, notes, history), the freeze
 * with re-authentication, the limits with their refusals, an archive refused with its blockers,
 * and the customer panel's marks on the order page (CS6), against the mocked API.
 */

const c = ar.customers;

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

async function search(page: Page, text: string) {
  await page.getByRole('searchbox', { name: c.search.label }).fill(text);
  await page.getByRole('button', { name: c.search.submit }).click();
}

async function action(page: Page, name: string) {
  await page.getByRole('button', { name: c.actions.menu }).click();
  await page.getByRole('menuitem', { name }).click();
}

test.describe('the customers list (CS1, CS2)', () => {
  test('finds a customer by email, by phone without +963 and by an order number', async ({
    page,
    admin,
  }) => {
    await open(page, admin, '/customers');
    await expect(rows(page)).toHaveCount(5);
    await expect(
      page.getByRole('main').getByRole('link', { name: c.testCustomersLink }),
    ).toBeVisible();

    await search(page, 'sara@');
    await expect(page).toHaveURL(/q=sara%40/);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('سارة الأحمد');
    await expect(rows(page).first()).toContainText('$25.00');

    // Edge case 21: the local number is normalized; both customers sharing it are found.
    await search(page, '0944123456');
    await expect(rows(page)).toHaveCount(2);

    await search(page, 'vo-back89');
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('sara@example.com');

    await search(page, 'nobody-here');
    await expect(page.getByText(c.empty)).toBeVisible();
    await page.getByRole('button', { name: c.search.clear }).click();
    await expect(rows(page)).toHaveCount(5);

    await page.getByRole('tab', { name: c.statusTabs.frozen }).click();
    await expect(page).toHaveURL(/status=frozen/);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText(c.chips.frozen);
    await page.getByRole('tab', { name: c.statusTabs.test }).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText(c.chips.test);
  });
});

test.describe('the profile (CS3–CS5)', () => {
  test('shows the summary, then each tab from the URL', async ({ page, admin }) => {
    await open(page, admin, '/customers');
    await page.getByRole('link', { name: 'سارة الأحمد' }).click();
    await expect(page.getByRole('heading', { name: 'سارة الأحمد', level: 1 })).toBeVisible();
    await expect(page.getByText(c.chips.established).first()).toBeVisible();
    await expect(page.getByText(c.limits.sources.default_established).first()).toBeVisible();
    await expect(page.getByText(c.limits.sources.none)).toBeVisible();
    await expect(page.getByText(fill(c.signals.sharedPhone, { count: 1 }))).toBeVisible();
    await expect(page.getByText(fill(c.signals.sharedIp, { count: 1 }))).toBeVisible();
    await expect(page.getByText(c.signals.natHint)).toBeVisible();
    await expect(page.getByRole('link', { name: 'ليلى حداد' }).first()).toBeVisible();

    await page.getByRole('tab', { name: c.sections.orders }).click();
    await expect(page).toHaveURL(/tab=orders/);
    await expect(rows(page).first()).toContainText('VO-');

    await page.getByRole('tab', { name: c.sections.wallet }).click();
    await expect(page.getByRole('link', { name: c.wallet.open })).toHaveAttribute(
      'href',
      `/wallets/${CUSTOMER_IDS.sara}`,
    );

    await page.getByRole('tab', { name: c.sections.devices }).click();
    await expect(page.getByText(c.devices.sessions)).toBeVisible();
    await expect(
      page.getByText(fill(c.devices.device, { browser: 'Chrome', system: 'Windows' })).first(),
    ).toBeVisible();

    await page.getByRole('tab', { name: c.sections.tickets }).click();
    await expect(rows(page)).toHaveCount(2);
    await expect(rows(page).first()).toContainText('VT-7KQ2MX');

    await page.getByRole('tab', { name: c.sections.notes }).click();
    await page.getByLabel(c.notes.body).fill('راجع إيصالات هذا الأسبوع قبل الموافقة.');
    await page.getByRole('checkbox', { name: c.notes.pinNew }).click();
    await page.getByRole('button', { name: c.notes.submit }).click();
    const note = page.getByRole('listitem').filter({ hasText: 'راجع إيصالات هذا الأسبوع' });
    await expect(note.getByText(c.notes.pinned)).toBeVisible();
    await expect(page.getByLabel(c.notes.body)).toHaveValue('');
    const older = page.getByRole('listitem').filter({ hasText: 'عميلة قديمة' });
    await older.getByRole('button', { name: c.notes.archive }).click();
    await expect(older).toHaveCount(0);
    await page.getByRole('button', { name: c.notes.showArchived }).click();
    await expect(page.getByText('عميلة قديمة وموثوقة')).toBeVisible();

    await page.getByRole('tab', { name: c.sections.history }).click();
    await expect(page.getByText(ar.audit.actions['customer.note_added']).first()).toBeVisible();
    await expect(page.getByText(ar.audit.actions['customer.note_archived'])).toBeVisible();

    await page.getByRole('tab', { name: c.sections.summary }).click();
    await expect(page).not.toHaveURL(/tab=/);
    await expect(page.getByText('راجع إيصالات هذا الأسبوع قبل الموافقة.')).toBeVisible();
  });

  test('freezes with a reason and re-authentication, then sets and refuses limits', async ({
    page,
    admin,
  }) => {
    admin.reauthenticationRequired = true;
    await open(page, admin, `/customers/${CUSTOMER_IDS.sara}`);
    await action(page, c.actions.freeze);
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(fill(c.dialogs.freeze.reservations, { count: 1 }))).toBeVisible();
    await dialog.getByRole('button', { name: c.dialogs.freeze.submit }).click();
    await expect(dialog.getByText(c.dialogs.reasonError)).toBeVisible();
    await dialog.getByLabel(c.dialogs.reason).fill('إيصالات مشبوهة قيد التحقق');
    await dialog.getByRole('button', { name: c.dialogs.freeze.submit }).click();
    await reauthenticate(page);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText(c.chips.frozen).first()).toBeVisible();
    await expect(page.getByText('إيصالات مشبوهة قيد التحقق')).toBeVisible();
    expect(admin.lastBody(`POST /api/admin/customers/${CUSTOMER_IDS.sara}/freeze`)).toEqual({
      reason: 'إيصالات مشبوهة قيد التحقق',
    });

    await action(page, c.actions.limits);
    const limits = page.getByRole('dialog');
    await limits.getByLabel(c.limits.perDeposit).fill('500');
    await limits.getByLabel(c.limits.dailyDeposit).fill('100');
    await limits.getByLabel(c.limits.dailyPurchase).fill('1.005');
    await limits.getByLabel(c.dialogs.reason).fill('عميل موثوق بحجم أكبر');
    await limits.getByRole('button', { name: c.limits.submit }).click();
    await expect(limits.getByText(c.limits.dailyBelow)).toBeVisible();
    await expect(limits.getByText(c.limits.fieldError)).toBeVisible();
    await limits.getByLabel(c.limits.dailyDeposit).fill('1000');
    await limits.getByLabel(c.limits.dailyPurchase).fill('20');
    await limits.getByRole('button', { name: c.limits.submit }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(admin.lastBody(`PUT /api/admin/customers/${CUSTOMER_IDS.sara}/limits`)).toEqual({
      perDepositUsdUnits: 500_000_000,
      dailyDepositUsdUnits: 1_000_000_000,
      dailyPurchaseUsdUnits: 20_000_000,
      reason: 'عميل موثوق بحجم أكبر',
    });
    await expect(page.getByText('$500.00')).toBeVisible();
    await expect(page.getByText(c.limits.sources.custom)).toHaveCount(3);

    await action(page, c.actions.unfreeze);
    await page.getByRole('dialog').getByLabel(c.dialogs.reason).fill('انتهى التحقق بنجاح');
    await page.getByRole('button', { name: c.dialogs.unfreeze.submit }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText(c.chips.frozen)).toHaveCount(0);
  });

  test('refuses an archive with a balance and keeps the reason', async ({ page, admin }) => {
    await open(page, admin, `/customers/${CUSTOMER_IDS.sara}`);
    await action(page, c.actions.archive);
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(c.dialogs.reason).fill('طلبت العميلة إغلاق الحساب');
    await dialog.getByRole('button', { name: c.dialogs.archive.submit }).click();
    await expect(dialog.getByText(c.dialogs.archive.blockers)).toBeVisible();
    await expect(dialog.getByText(/\$25\.00/)).toBeVisible();
    await expect(dialog.getByLabel(c.dialogs.reason)).toHaveValue('طلبت العميلة إغلاق الحساب');
  });

  test('an archived customer offers only unarchive and sign-out', async ({ page, admin }) => {
    await open(page, admin, `/customers/${CUSTOMER_IDS.omar}`);
    await expect(page.getByText('طلب العميل إغلاق حسابه')).toBeVisible();
    await page.getByRole('button', { name: c.actions.menu }).click();
    await expect(page.getByRole('menuitem')).toHaveText([c.actions.revoke, c.actions.unarchive]);
  });
});

test('the order page shows the customer marks (CS6)', async ({ page, admin }) => {
  const order = admin.orders.orders.find((row) => row.id === ORDER_IDS.held);
  if (!order) throw new Error('No held order');
  order.customer = {
    ...order.customer,
    marks: { status: 'frozen', pinnedNote: 'لا توافق على إيداعاتها قبل الاتصال', signalsCount: 2 },
  };
  await open(page, admin, `/orders/${ORDER_IDS.held}`);
  await expect(page.getByText('لا توافق على إيداعاتها قبل الاتصال')).toBeVisible();
  await expect(page.getByText(c.chips.frozen)).toBeVisible();
  await page.getByRole('link', { name: fill(c.marks.signals, { count: 2 }) }).click();
  await expect(page).toHaveURL(`/customers/${order.customer.id}`);
});

// RTL screenshots of the S12 customer screens in both themes: the design review evidence.
for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('customer screens', async ({ page, admin }, testInfo) => {
      await open(page, admin, '/customers');
      await expect(rows(page)).toHaveCount(5);
      await screenshot(page, testInfo, `customers-${colorScheme}`);

      await page.goto(`/customers/${CUSTOMER_IDS.sara}`);
      await expect(page.getByText(c.signals.natHint)).toBeVisible();
      await screenshot(page, testInfo, `customer-summary-${colorScheme}`, { fullPage: true });

      await page.goto(`/customers/${CUSTOMER_IDS.sara}?tab=devices`);
      await expect(page.getByText(c.devices.signIns)).toBeVisible();
      await screenshot(page, testInfo, `customer-devices-${colorScheme}`);

      await page.goto(`/customers/${CUSTOMER_IDS.sara}?tab=notes`);
      await expect(page.getByText('عميلة قديمة وموثوقة')).toBeVisible();
      await screenshot(page, testInfo, `customer-notes-${colorScheme}`);

      await action(page, c.actions.freeze);
      await expect(page.getByRole('dialog')).toBeVisible();
      await screenshot(page, testInfo, `customer-freeze-${colorScheme}`);
      await page.keyboard.press('Escape');

      await action(page, c.actions.limits);
      await expect(page.getByRole('dialog')).toBeVisible();
      await screenshot(page, testInfo, `customer-limits-${colorScheme}`);
      await page.keyboard.press('Escape');

      await action(page, c.actions.archive);
      await page.getByRole('dialog').getByLabel(c.dialogs.reason).fill('طلبت العميلة إغلاق الحساب');
      await page.getByRole('button', { name: c.dialogs.archive.submit }).click();
      await expect(page.getByText(c.dialogs.archive.blockers)).toBeVisible();
      await screenshot(page, testInfo, `customer-archive-refused-${colorScheme}`);
      await page.keyboard.press('Escape');

      await page.goto(`/customers/${CUSTOMER_IDS.rami}`);
      await expect(page.getByText('إيصالات مكررة قيد التحقق')).toBeVisible();
      await screenshot(page, testInfo, `customer-frozen-${colorScheme}`);
    });
  });
}
