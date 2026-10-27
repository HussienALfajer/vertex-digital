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
    // S15: the devices with push on.
    await expect(page.getByText(c.summary.push, { exact: true })).toBeVisible();
    await expect(page.getByText(c.summary.pushOn_one)).toBeVisible();

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
    // S22 PK6: the passkeys, read only.
    await expect(page.getByText(c.devices.passkeys)).toBeVisible();
    await expect(page.getByText('حاسوب العمل')).toBeVisible();
    await expect(page.getByText(c.devices.passkeyNeverUsed)).toBeVisible();
    await expect(page.getByText(c.devices.passkeySynced)).toBeVisible();

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
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: c.notes.archiveConfirm })
      .click();
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
    // The focus goes to the first refused field a frame after the errors show: typing in the
    // next field before then would land in this one.
    await expect(limits.getByLabel(c.limits.dailyDeposit)).toBeFocused();
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
  if (!order?.customer) throw new Error('No held order');
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

test.describe('audit A07', () => {
  const failing = { statusCode: 500, code: 'INTERNAL_ERROR', message: 'x' };
  const customer = (admin: AdminApi, id: string) => {
    const row = admin.customers.find(id);
    if (!row) throw new Error(`No customer ${id}`);
    return row;
  };

  test('a failed read of the list, the profile and a tab offers a retry (A07-18)', async ({
    page,
    admin,
  }) => {
    let fail = true;
    await page.route(/\/api\/admin\/customers\?/, (route) =>
      fail ? route.fulfill({ status: 500, json: failing }) : route.fallback(),
    );
    await page.route(`**/api/admin/customers/${CUSTOMER_IDS.sara}`, (route) =>
      fail ? route.fulfill({ status: 500, json: failing }) : route.fallback(),
    );
    await page.route(/\/api\/admin\/orders\?.*customerId=/, (route) =>
      fail ? route.fulfill({ status: 500, json: failing }) : route.fallback(),
    );
    await open(page, admin, '/customers');
    await expect(page.getByText(ar.errors.generic)).toBeVisible({ timeout: 10_000 });
    fail = false;
    await page.getByRole('button', { name: ar.common.retry }).click();
    await expect(rows(page)).toHaveCount(5);

    fail = true;
    await page.goto(`/customers/${CUSTOMER_IDS.sara}`);
    await expect(page.getByText(ar.errors.generic)).toBeVisible({ timeout: 10_000 });
    fail = false;
    await page.getByRole('button', { name: ar.common.retry }).click();
    await expect(page.getByRole('heading', { name: 'سارة الأحمد', level: 1 })).toBeVisible();

    fail = true;
    await page.getByRole('tab', { name: c.sections.orders }).click();
    await expect(page.getByText(ar.errors.generic)).toBeVisible({ timeout: 10_000 });
    fail = false;
    await page.getByRole('button', { name: ar.common.retry }).click();
    await expect(rows(page).first()).toContainText('VO-');
  });

  test('an unknown customer shows the way back, not a retry (A07-47)', async ({ page, admin }) => {
    await open(page, admin, '/customers/0199c000-0000-7000-8000-00000000ffff');
    await expect(page.getByText(c.notFound)).toBeVisible();
    await expect(page.getByRole('button', { name: ar.common.retry })).toHaveCount(0);
  });

  test('loads more customers, dims the rows while a tab loads, and is empty per tab (A07-15, A07-18)', async ({
    page,
    admin,
  }) => {
    admin.customers.listPageSize = 2;
    await open(page, admin, '/customers');
    await expect(rows(page)).toHaveCount(2);
    await page.getByRole('button', { name: ar.common.loadMore }).click();
    await expect(rows(page)).toHaveCount(4);
    await page.getByRole('button', { name: ar.common.loadMore }).click();
    await expect(rows(page)).toHaveCount(5);
    await expect(page.getByRole('button', { name: ar.common.loadMore })).toHaveCount(0);

    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/api\/admin\/customers\?.*status=archived/, async (route) => {
      await held;
      await route.fallback();
    });
    await page.getByRole('tab', { name: c.statusTabs.archived }).click();
    await expect(page.getByRole('table')).toHaveAttribute('aria-busy', 'true');
    release();
    await expect(page.getByRole('table')).toHaveAttribute('aria-busy', 'false');
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('عمر الخطيب');

    customer(admin, CUSTOMER_IDS.rami).frozenAt = null;
    await page.getByRole('tab', { name: c.statusTabs.frozen }).click();
    await expect(page.getByText(c.empty)).toBeVisible();
  });

  test('archives with re-authentication, then unarchives (A07-18)', async ({ page, admin }) => {
    admin.reauthenticationRequired = true;
    await open(page, admin, `/customers/${CUSTOMER_IDS.layla}`);
    await action(page, c.actions.archive);
    await page.getByRole('dialog').getByLabel(c.dialogs.reason).fill('طلبت العميلة إغلاق حسابها');
    await page.getByRole('button', { name: c.dialogs.archive.submit }).click();
    await reauthenticate(page);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText(c.chips.archived).first()).toBeVisible();
    await expect(page.getByText('طلبت العميلة إغلاق حسابها')).toBeVisible();

    await action(page, c.actions.unarchive);
    await page.getByRole('dialog').getByLabel(c.dialogs.reason).fill('عادت العميلة وطلبت فتحه');
    await page.getByRole('button', { name: c.dialogs.unarchive.submit }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText(c.chips.archived)).toHaveCount(0);
    expect(customer(admin, CUSTOMER_IDS.layla).archivedAt).toBeNull();
  });

  test('signs out everywhere with re-authentication (A07-18)', async ({ page, admin }) => {
    admin.reauthenticationRequired = true;
    await open(page, admin, `/customers/${CUSTOMER_IDS.sara}?tab=devices`);
    await expect(
      page.getByText(fill(c.devices.device, { browser: 'Chrome', system: 'Windows' })).first(),
    ).toBeVisible();
    await action(page, c.actions.revoke);
    await page.getByRole('dialog').getByLabel(c.dialogs.reason).fill('هاتف العميلة مفقود');
    await page.getByRole('button', { name: c.dialogs.revoke.submit }).click();
    await reauthenticate(page);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText(c.devices.noSessions)).toBeVisible();
    expect(customer(admin, CUSTOMER_IDS.sara).sessions).toEqual([]);
  });

  test('unfreezes with re-authentication; a state changed meanwhile is refused in place (A07-18)', async ({
    page,
    admin,
  }) => {
    admin.reauthenticationRequired = true;
    await open(page, admin, `/customers/${CUSTOMER_IDS.rami}`);
    await action(page, c.actions.unfreeze);
    await page.getByRole('dialog').getByLabel(c.dialogs.reason).fill('انتهى التحقق من الإيصالات');
    await page.getByRole('button', { name: c.dialogs.unfreeze.submit }).click();
    await reauthenticate(page);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText(c.chips.frozen)).toHaveCount(0);

    // Archived elsewhere while this page still shows an active customer.
    customer(admin, CUSTOMER_IDS.rami).archivedAt = new Date().toISOString();
    await action(page, c.actions.freeze);
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(c.dialogs.reason).fill('إيصالات مكررة مرة أخرى');
    await dialog.getByRole('button', { name: c.dialogs.freeze.submit }).click();
    await expect(dialog.getByText(ar.errors.api.CUSTOMER_STATE_INVALID)).toBeVisible();
    await expect(dialog.getByLabel(c.dialogs.reason)).toHaveValue('إيصالات مكررة مرة أخرى');
  });

  test('archiving a note asks first, quoting it; pinning over the pinned one says so (A07-13)', async ({
    page,
    admin,
  }) => {
    admin.customers.notes.push({
      id: '0199c000-0000-7000-8000-0000000005f2',
      customerId: CUSTOMER_IDS.sara,
      body: 'لا توافق على إيداعاتها قبل الاتصال بها.',
      pinned: true,
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      archivedAt: null,
    });
    await open(page, admin, `/customers/${CUSTOMER_IDS.sara}?tab=notes`);
    const older = page.getByRole('listitem').filter({ hasText: 'عميلة قديمة' });
    const pinned = page.getByRole('listitem').filter({ hasText: 'لا توافق على إيداعاتها' });

    await older.getByRole('button', { name: c.notes.pin }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(
      dialog.getByText(
        fill(c.notes.pinBody, { excerpt: 'لا توافق على إيداعاتها قبل الاتصال بها.' }),
      ),
    ).toBeVisible();
    await dialog.getByRole('button', { name: c.notes.pinConfirm }).click();
    await expect(older.getByText(c.notes.pinned)).toBeVisible();
    await expect(pinned.getByText(c.notes.pinned)).toHaveCount(0);

    // The pinned note's archive says it leaves the deposit, order and ticket panels.
    await older.getByRole('button', { name: c.notes.archive }).click();
    await expect(
      dialog.getByText(
        fill(c.notes.archiveBodyPinned, { excerpt: 'عميلة قديمة وموثوقة. تشحن عادة ببجي.' }),
      ),
    ).toBeVisible();
    await dialog.getByRole('button', { name: ar.common.cancel }).click();
    await expect(older).toHaveCount(1);

    // Unpinning asks nothing (A07-18).
    await older.getByRole('button', { name: c.notes.unpin }).click();
    await expect(older.getByText(c.notes.pinned)).toHaveCount(0);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);

    await pinned.getByRole('button', { name: c.notes.archive }).click();
    await expect(
      dialog.getByText(
        fill(c.notes.archiveBody, { excerpt: 'لا توافق على إيداعاتها قبل الاتصال بها.' }),
      ),
    ).toBeVisible();
    await dialog.getByRole('button', { name: c.notes.archiveConfirm }).click();
    await expect(pinned).toHaveCount(0);
  });

  test('the price list dialog waits for the lists, with a retry, and focuses an empty reason (A07-11, A07-46)', async ({
    page,
    admin,
  }) => {
    let fail = true;
    await page.route('**/api/admin/pricing/lists', (route) =>
      fail ? route.fulfill({ status: 500, json: failing }) : route.fallback(),
    );
    await open(page, admin, `/customers/${CUSTOMER_IDS.sara}`);
    await page.getByRole('button', { name: c.pricing.change }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(ar.errors.generic)).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByRole('button', { name: c.pricing.save })).toBeDisabled();
    fail = false;
    await dialog.getByRole('button', { name: ar.common.retry }).click();
    await expect(dialog.getByRole('combobox', { name: c.pricing.list })).toBeVisible();
    await dialog.getByRole('button', { name: c.pricing.save }).click();
    await expect(dialog.getByText(c.dialogs.reasonError)).toBeVisible();
    await expect(dialog.getByLabel(c.dialogs.reason)).toBeFocused();
  });

  test('warns that a per-deposit limit above the daily one still leaves deposits refused (A07-22)', async ({
    page,
    admin,
  }) => {
    await open(page, admin, `/customers/${CUSTOMER_IDS.layla}`);
    await action(page, c.actions.limits);
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(c.limits.perDeposit).fill('80');
    await expect(dialog.getByText(c.limits.aboveDaily)).toHaveCount(0);
    // A new account: $100 a day by default.
    await dialog.getByLabel(c.limits.perDeposit).fill('500');
    await expect(dialog.getByText(c.limits.aboveDaily)).toBeVisible();
    await expect(
      dialog.getByText(fill(c.limits.aboveDailyBody, { daily: '⁦$100.00⁩' })),
    ).toBeVisible();
    await dialog.getByLabel(c.limits.dailyDeposit).fill('600');
    await expect(dialog.getByText(c.limits.aboveDaily)).toHaveCount(0);
  });

  test('the tickets tab leads to all the customer’s tickets in the queue (A07-44)', async ({
    page,
    admin,
  }) => {
    await open(page, admin, `/customers/${CUSTOMER_IDS.sara}?tab=tickets`);
    await page.getByRole('link', { name: c.lists.allTickets }).click();
    await expect(page).toHaveURL(new RegExp(`/support\\?.*customerId=${CUSTOMER_IDS.sara}`));
    await expect(page).toHaveURL(/status=all/);
    await expect(rows(page)).toHaveCount(2);
    await expect(
      page.getByText(fill(ar.support.filters.customerChip, { name: 'سارة الأحمد' })),
    ).toBeVisible();
  });
});

// RTL screenshots of the S12 customer screens in both themes: the design review evidence.
for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('the list, the summary and the frozen profile', async ({ page, admin }, testInfo) => {
      await open(page, admin, '/customers');
      await expect(rows(page)).toHaveCount(5);
      await screenshot(page, testInfo, `customers-${colorScheme}`);

      await page.goto(`/customers/${CUSTOMER_IDS.sara}`);
      await expect(page.getByText(c.signals.natHint)).toBeVisible();
      await screenshot(page, testInfo, `customer-summary-${colorScheme}`, { fullPage: true });

      await page.goto(`/customers/${CUSTOMER_IDS.rami}`);
      await expect(page.getByText('إيصالات مكررة قيد التحقق')).toBeVisible();
      await screenshot(page, testInfo, `customer-frozen-${colorScheme}`);
    });

    test('the devices and notes tabs', async ({ page, admin }, testInfo) => {
      await open(page, admin, `/customers/${CUSTOMER_IDS.sara}?tab=devices`);
      await expect(page.getByText(c.devices.signIns)).toBeVisible();
      await expect(page.getByText(c.devices.passkeys)).toBeVisible();
      await screenshot(page, testInfo, `customer-devices-${colorScheme}`, { fullPage: true });

      await page.goto(`/customers/${CUSTOMER_IDS.sara}?tab=notes`);
      await expect(page.getByText('عميلة قديمة وموثوقة')).toBeVisible();
      await screenshot(page, testInfo, `customer-notes-${colorScheme}`);
    });

    test('the freeze dialog', async ({ page, admin }, testInfo) => {
      await open(page, admin, `/customers/${CUSTOMER_IDS.sara}`);
      await action(page, c.actions.freeze);
      await expect(page.getByRole('dialog')).toBeVisible();
      await screenshot(page, testInfo, `customer-freeze-${colorScheme}`);
    });

    test('the limits dialog', async ({ page, admin }, testInfo) => {
      await open(page, admin, `/customers/${CUSTOMER_IDS.sara}`);
      await action(page, c.actions.limits);
      await expect(page.getByRole('dialog')).toBeVisible();
      await screenshot(page, testInfo, `customer-limits-${colorScheme}`);
    });

    test('an archive refused', async ({ page, admin }, testInfo) => {
      await open(page, admin, `/customers/${CUSTOMER_IDS.sara}`);
      await action(page, c.actions.archive);
      await page.getByRole('dialog').getByLabel(c.dialogs.reason).fill('طلبت العميلة إغلاق الحساب');
      await page.getByRole('button', { name: c.dialogs.archive.submit }).click();
      await expect(page.getByText(c.dialogs.archive.blockers)).toBeVisible();
      await screenshot(page, testInfo, `customer-archive-refused-${colorScheme}`);
    });
  });
}
