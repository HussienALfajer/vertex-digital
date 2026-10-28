import type { Page } from '@playwright/test';
import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import { RESULT_IDS, RUN_IDS } from './reconciliation-mock';
import { type AdminApi, expect, PASSWORD, screenshot, TOTP_CODE, test, USD } from './test';

/*
 * Reconciliation (S13, F20): the empty state and a manual run, open mismatches and their
 * explanation, an opening balance with re-authentication and the typed confirmation, a Sham Cash
 * count, a reversal, the history and a run's page, and the settings, against the mocked API.
 */

const r = ar.reconciliation;

const field = (page: Page, label: string) =>
  page.getByLabel(label, { exact: true }).filter({ visible: true });

async function open(page: Page, admin: AdminApi, path = '/reconciliation') {
  admin.signedIn = true;
  await page.goto(path);
}

async function reauthenticate(page: Page) {
  await expect(page.getByRole('heading', { name: ar.reauth.title })).toBeVisible();
  await field(page, ar.reauth.password).fill(PASSWORD);
  await page.getByRole('textbox').filter({ visible: true }).nth(1).pressSequentially(TOTP_CODE);
  await page.getByRole('button', { name: ar.reauth.submit }).click();
}

const placeRow = (page: Page, name: string) =>
  page.getByRole('row').filter({ has: page.getByText(name, { exact: true }) });

const fakeSupplier = r.places.supplier.replace('{{name}}', ar.suppliers.names.fake);

/** Records the fake supplier's opening of $200 from outside (rule T6). */
async function recordOpening(page: Page) {
  await placeRow(page, fakeSupplier).getByRole('button', { name: r.places.record }).click();
  const dialog = page.getByRole('dialog');
  await expect(field(page, r.movement.sent.replace('{{currency}}', r.currencies.USD))).toHaveValue(
    '200',
  );
  await expect(
    dialog.getByText(r.movement.openingProposed.replace('{{amount}}', '⁦$200.00⁩')),
  ).toBeVisible();
  await expect(dialog.getByRole('switch', { name: r.movement.opening })).toBeChecked();
  await field(page, ar.wallets.adjust.confirm).fill('200');
  await field(page, r.movement.reason).fill('الرصيد الافتتاحي للمورد');
}

test('no run yet: the empty state starts a manual run, shown as running', async ({
  page,
  admin,
}) => {
  await open(page, admin);
  await expect(page.getByText(r.empty.title)).toBeVisible();
  await page.getByRole('button', { name: r.runNow }).click();
  await expect(page.getByRole('status')).toBeVisible();
  expect(admin.calls).toContain('POST /api/admin/reconciliation/runs');
  await expect(page.getByRole('button', { name: r.runNow })).toBeDisabled();
});

test('after a manual run without a nightly one, the status and its warnings show', async ({
  page,
  admin,
}) => {
  admin.reconciliation.seed();
  admin.reconciliation.open = [];
  const [nightly] = admin.reconciliation.runs;
  if (!nightly) throw new Error('seeded');
  admin.reconciliation.runs = [
    { ...nightly, trigger: 'manual', businessDate: null, mismatchCount: 0 },
  ];
  await open(page, admin);
  await expect(page.getByText(r.empty.title)).toBeHidden();
  // No night has checked the books yet: no "clean" badge on a manual run's word (A09-38).
  await expect(page.getByText(r.status.noNightly)).toBeVisible();
  await expect(page.getByText(r.status.clean)).toHaveCount(0);
  await expect(page.getByRole('listitem').filter({ hasText: r.checks.usdt_balance })).toContainText(
    r.skipReasons.opening_missing,
  );
});

test('a movement from an outside row starts there, without an opening', async ({ page, admin }) => {
  await open(page, admin);
  await placeRow(page, r.places.outside_usd).getByRole('button', { name: r.places.record }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('combobox', { name: r.movement.from })).toHaveText(
    r.places.outside_usd,
  );
  await expect(dialog.getByRole('switch', { name: r.movement.opening })).toBeHidden();
});

test('open mismatches: internal first with the ids linked, the badge, explained once', async ({
  page,
  admin,
}) => {
  admin.reconciliation.seed();
  await open(page, admin);
  await expect(page.getByText(r.status.mismatches.replace('{{count}}', '2'))).toBeVisible();
  await expect(page.getByLabel(ar.nav.reconciliationBadge.replace('{{open}}', '2'))).toBeVisible();
  const items = page.getByRole('listitem').filter({ hasText: r.explain.open });
  await expect(items.first()).toContainText(r.internalFault);
  await expect(items.first().getByRole('link', { name: /طلب/ })).toHaveAttribute(
    'href',
    /\/orders\//,
  );
  await expect(page.getByRole('listitem').filter({ hasText: r.checks.usdt_balance })).toContainText(
    r.skipReasons.opening_missing,
  );

  await items.nth(1).getByRole('button', { name: r.explain.open }).click();
  await field(page, r.explain.note).fill('خصم المورد رسوم شهرية');
  await page.getByRole('dialog').getByRole('button', { name: r.explain.submit }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(admin.calls).toContain(
    `POST /api/admin/reconciliation/results/${RESULT_IDS.supplier}/explanation`,
  );
  await expect(page.getByText(r.status.mismatches.replace('{{count}}', '1'))).toBeVisible();
});

test('an opening balance asks for re-authentication and the typed amount, with one key', async ({
  page,
  admin,
}) => {
  admin.reauthenticationRequired = true;
  await open(page, admin);
  await recordOpening(page);
  await page.getByRole('dialog').getByRole('button', { name: r.movement.submit }).click();
  await reauthenticate(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const keys = admin.requests
    .filter((request) => request.key === 'POST /api/admin/treasury/movements')
    .map((request) => request.headers['idempotency-key']);
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(admin.lastBody('POST /api/admin/treasury/movements')).toMatchObject({
    from: 'outside_usd',
    to: 'supplier:fake',
    sentUnits: 200 * USD,
    receivedUnits: 200 * USD,
    outsideCategory: 'owner',
    openingBalance: true,
    amountConfirmationUnits: 200 * USD,
  });
  const row = placeRow(page, fakeSupplier);
  await expect(row.getByText(r.places.noOpening)).toBeHidden();
  await expect(row.getByRole('cell').nth(3)).toHaveText('⁦$0.00⁩');
});

test('a Sham Cash count shows the books only after saving', async ({ page, admin }) => {
  await open(page, admin);
  await placeRow(page, r.places.sham_cash_usd)
    .getByRole('button', { name: r.places.count })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(r.columns.books)).toBeHidden();
  await field(page, r.count.amount).fill('250.40');
  await dialog.getByRole('button', { name: r.count.submit }).click();
  await expect(dialog.getByText(r.count.savedTitle)).toBeVisible();
  await expect(dialog.getByText(r.columns.books)).toBeVisible();
  await expect(dialog.getByText(r.skipReasons.opening_missing)).toBeVisible();
  expect(admin.lastBody('POST /api/admin/reconciliation/sham-cash-counts')).toEqual({
    currency: 'USD',
    countedUnits: 250_400_000,
  });
});

test('a movement by mistake is reversed once; both rows show', async ({ page, admin }) => {
  await open(page, admin);
  await page.getByRole('button', { name: r.places.record }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: r.movement.from }).click();
  await page.getByRole('option', { name: r.places.usdt_trc20 }).click();
  // Both lists hold every place: the first closes before the second opens.
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await dialog.getByRole('combobox', { name: r.movement.to }).click();
  await page.getByRole('option', { name: r.places.outside_usd }).click();
  await field(page, r.movement.sent.replace('{{currency}}', r.currencies.USD)).fill('5');
  await dialog.getByRole('combobox', { name: r.movement.category }).click();
  await page.getByRole('option', { name: r.categories.owner }).click();
  await field(page, r.movement.reason).fill('سحب للمالك');
  await dialog.getByRole('button', { name: r.movement.submit }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole('tab', { name: r.tabs.movements }).click();
  await expect(page).toHaveURL(/tab=movements/);
  await page.getByRole('button', { name: r.reverse.open }).click();
  await field(page, r.movement.reason).fill('سُجّلت بالخطأ');
  await page.getByRole('dialog').getByRole('button', { name: r.reverse.submit }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByText(r.movements.reversal, { exact: true })).toBeVisible();
  await expect(page.getByText(r.movements.reversed, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: r.reverse.open })).toHaveCount(0);
});

test('a USDT return to its sender names the incoming TXID (Q30)', async ({ page, admin }) => {
  await open(page, admin);
  await page.getByRole('button', { name: r.places.record }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: r.movement.from }).click();
  await page.getByRole('option', { name: r.places.usdt_bep20 }).click();
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await dialog.getByRole('combobox', { name: r.movement.to }).click();
  await page.getByRole('option', { name: r.places.outside_usd }).click();
  await field(page, r.movement.sent.replace('{{currency}}', r.currencies.USD)).fill('5');
  await expect(dialog.getByText(r.movement.returnedTxidHint)).toBeHidden();
  await dialog.getByRole('combobox', { name: r.movement.category }).click();
  await page.getByRole('option', { name: r.categories.return_to_sender }).click();
  await expect(dialog.getByText(r.movement.returnedTxidHint)).toBeVisible();
  await field(page, r.movement.reference).fill('NOT-A-TXID');
  await field(page, r.movement.reason).fill('إعادة تحويل خاطئ');
  await dialog.getByRole('button', { name: r.movement.submit }).click();
  await expect(dialog.getByText(r.movement.errors.reference)).toBeVisible();
  // No unclaimed receipt booked this transfer in: the refusal sits under the reference.
  await field(page, r.movement.reference).fill(`0x${'ab'.repeat(32)}`);
  await dialog.getByRole('button', { name: r.movement.submit }).click();
  await expect(dialog.getByText(ar.errors.api.RETURN_RECEIPT_MISSING)).toBeVisible();
  expect(admin.lastBody('POST /api/admin/treasury/movements')).toMatchObject({
    from: 'usdt_bep20',
    outsideCategory: 'return_to_sender',
  });
});

test('a supplier correction above $100 asks for the amount and re-authentication, with one key (A09-31)', async ({
  page,
  admin,
}) => {
  admin.reauthenticationRequired = true;
  await open(page, admin);
  await placeRow(page, fakeSupplier).getByRole('button', { name: r.places.correct }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: r.correction.title })).toBeVisible();
  // "خصم المورد" is the default direction.
  await expect(
    dialog.getByRole('button', { name: r.correction.directions.decrease }),
  ).toHaveAttribute('aria-pressed', 'true');
  await field(page, r.correction.amount).fill('120.123456');
  await field(page, ar.wallets.adjust.confirm).fill('120.123456');
  await field(page, r.correction.order).fill('VO-7KQ2MX');
  await field(page, r.movement.reason).fill('خصم المورد طلبًا مكررًا');
  await dialog.getByRole('button', { name: r.correction.submit }).click();
  await reauthenticate(page);
  // An unknown order is said under its field, not as a record to reload (A09-32).
  await expect(dialog.getByText(r.correction.errors.orderNotFound)).toBeVisible();
  await field(page, r.correction.order).fill('');
  await dialog.getByRole('button', { name: r.correction.submit }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(admin.lastBody('POST /api/admin/treasury/supplier-corrections')).toMatchObject({
    supplier: 'fake',
    direction: 'decrease',
    amountUnits: 120_123_456,
    amountConfirmationUnits: 120_123_456,
  });
  await page.getByRole('tab', { name: r.tabs.movements }).click();
  await expect(page.getByText(r.movements.correction).first()).toBeVisible();
});

test('the manual run comes back when its 5 minutes end, and a finished run refreshes the places (A09-28, A09-29)', async ({
  page,
  admin,
}) => {
  await page.clock.install();
  admin.reconciliation.seed();
  admin.reconciliation.manualAvailableAt = new Date(Date.now() + 5 * 60_000).toISOString();
  await open(page, admin);
  const runNow = page.getByRole('button', { name: r.runNow });
  await expect(runNow).toBeDisabled();
  await page.clock.runFor(6 * 60_000);
  await expect(runNow).toBeEnabled();
  // A run that ends while the page is open: the places table shows its new balance.
  admin.reconciliation.manualAvailableAt = null;
  await runNow.click();
  await expect(page.getByRole('status')).toBeVisible();
  admin.reconciliation.running = null;
  admin.reconciliation.external['supplier:fake'] = {
    units: 180 * USD,
    at: new Date().toISOString(),
    source: 'supplier',
  };
  await page.clock.runFor(11_000);
  await expect(placeRow(page, fakeSupplier)).toContainText('180.00');
});

test('the history opens a run with every check', async ({ page, admin }) => {
  admin.reconciliation.seed();
  await open(page, admin, '/reconciliation?tab=history');
  await page.getByRole('table').getByRole('link').first().click();
  await expect(page).toHaveURL(new RegExp(`/reconciliation/runs/${RUN_IDS.nightly}`));
  await expect(page.getByRole('cell', { name: r.checks.journal_balance })).toBeVisible();
  await expect(page.getByText(r.statuses.ok, { exact: true })).toBeVisible();
});

test('the settings are saved after re-authentication', async ({ page, admin }) => {
  admin.reconciliation.seed();
  admin.reauthenticationRequired = true;
  await open(page, admin);
  await page.getByRole('button', { name: r.settings.open }).click();
  await field(page, r.settings.tolerance).fill('2.50');
  await field(page, r.settings.staleDays).fill('10');
  await page.getByRole('button', { name: r.settings.submit }).click();
  await reauthenticate(page);
  await expect(page.getByText(r.settings.saved)).toBeVisible();
  expect(admin.reconciliation.settings).toEqual({
    toleranceUsdUnits: 2_500_000,
    countStaleDays: 10,
  });
});

// RTL screenshots of the S13 reconciliation screens in both themes (ADR 0011).
for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('S13 reconciliation screenshots', async ({ page, admin }, testInfo) => {
      admin.reconciliation.seed();
      await open(page, admin);
      await expect(page.getByText(r.internalFault)).toBeVisible();
      await screenshot(page, testInfo, `reconciliation-${colorScheme}`, { fullPage: true });

      await recordOpening(page);
      await screenshot(page, testInfo, `reconciliation-movement-${colorScheme}`);
      // Typed: only its own button closes it (audit A10-20).
      await page.getByRole('dialog').getByRole('button', { name: ar.common.close }).click();
      await expect(page.getByRole('dialog')).toBeHidden();

      await placeRow(page, r.places.sham_cash_usd)
        .getByRole('button', { name: r.places.count })
        .click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await screenshot(page, testInfo, `reconciliation-count-${colorScheme}`);
    });
  });
}
