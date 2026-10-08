import type { Page } from '@playwright/test';
import type { AuditEntry } from '@vertex-digital/contracts';
import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import {
  type AdminApi,
  CUSTOMER_ID,
  expect,
  type MockDeposit,
  PASSWORD,
  screenshot,
  TOTP_CODE,
  test,
  USD,
} from './test';

/*
 * Exchange rates and Sham Cash deposits (S03): the stale-rate banner, the rate change with its
 * typed confirmation, the deposit settings, the review queue and a deposit's review (approve,
 * clearer receipt, reject), against the mocked API.
 */

const RATE_ID = '0199a000-0000-7000-8000-0000000000f1';
const SYP_DEPOSIT = '0199a000-0000-7000-8000-0000000000d1';
const USD_DEPOSIT = '0199a000-0000-7000-8000-0000000000d2';
const OTHER_DEPOSIT = '0199a000-0000-7000-8000-0000000000d3';
const RECEIPT_ID = '0199a000-0000-7000-8000-0000000000e9';

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const field = (page: Page, label: string) =>
  page.getByLabel(label, { exact: true }).filter({ visible: true });

/** A USD amount as the panel isolates it inside an Arabic sentence (`ltr()`). */
const usd = (text: string) => `\u2066${text}\u2069`;

/** Fills `{{name}}` placeholders the way i18next does. */
const fill = (text: string, values: Record<string, string>) =>
  Object.entries(values).reduce(
    (result, [key, value]) => result.replace(`{{${key}}}`, value),
    text,
  );

/** A deposit in review, of the test customer; `changes` override any field. */
function deposit(changes: Partial<MockDeposit> & { id: string }): MockDeposit {
  return {
    method: 'sham_cash',
    status: 'submitted',
    referenceCode: 'VD-7KQ2M',
    currency: 'SYP',
    declaredAmountUnits: 300_000,
    declaredUsdUnits: 25_420_000,
    quote: { rateId: RATE_ID, rate: '118', expiresAt: minutesAgo(-5) },
    expiresAt: minutesAgo(-24 * 60),
    createdAt: minutesAgo(30),
    submittedAt: minutesAgo(20),
    decidedAt: null,
    rateFixedAt: minutesAgo(20),
    receiptRequestedAt: null,
    receiptRequestCount: 0,
    receiptRequestNote: null,
    approvalRate: { rateId: RATE_ID, rate: '118' },
    decidedBy: null,
    adminName: null,
    credit: null,
    rejection: null,
    receipts: [{ id: RECEIPT_ID, createdAt: minutesAgo(20) }],
    flags: [],
    customer: {
      id: CUSTOMER_ID,
      name: 'سارة الأحمد',
      email: 'sara@example.com',
      isTest: true,
      phone: '+963944123456',
      createdAt: '2026-10-01T09:00:00.000Z',
      established: false,
      creditedCount: 0,
      creditedTotalUsdUnits: 0,
      balanceUnits: 0,
      recentDeposits: [],
    },
    eta: { state: 'open', minutes: 15 },
    usdt: null,
    ...changes,
  };
}

/** The queue of the S03 acceptance: a flagged pound deposit and a plain dollar one. */
function queue(admin: AdminApi) {
  admin.deposits = [
    deposit({
      id: USD_DEPOSIT,
      referenceCode: 'VD-3HWX9',
      currency: 'USD',
      declaredAmountUnits: 20 * USD,
      declaredUsdUnits: 20 * USD,
      quote: null,
      rateFixedAt: null,
      submittedAt: minutesAgo(40),
    }),
    deposit({
      id: SYP_DEPOSIT,
      flags: [
        {
          id: '0199a000-0000-7000-8000-0000000000a9',
          code: 'new_account_large',
          receiptId: RECEIPT_ID,
          details: { declaredUsdUnits: 25_420_000, thresholdUnits: 25 * USD },
          createdAt: minutesAgo(20),
        },
        {
          id: '0199a000-0000-7000-8000-0000000000aa',
          code: 'receipt_reused',
          receiptId: RECEIPT_ID,
          details: {
            matches: [{ depositId: OTHER_DEPOSIT, receiptId: RECEIPT_ID, customerId: CUSTOMER_ID }],
          },
          createdAt: minutesAgo(20),
        },
      ],
    }),
  ];
}

async function open(page: Page, admin: AdminApi, path: string) {
  admin.signedIn = true;
  await page.goto(path);
}

/** Re-authenticates in the dialog the API's refusal opened (S01 rule D5). */
async function reauthenticate(page: Page) {
  await expect(page.getByRole('heading', { name: ar.reauth.title })).toBeVisible();
  await field(page, ar.reauth.password).fill(PASSWORD);
  await page.getByRole('textbox').filter({ visible: true }).nth(1).pressSequentially(TOTP_CODE);
  await page.getByRole('button', { name: ar.reauth.submit }).click();
}

const rows = (page: Page) => page.getByRole('table').first().getByRole('row');

test.describe('exchange rate', () => {
  test('the banner without a rate, the first rate, then a change above 5% typed twice', async ({
    page,
    admin,
  }) => {
    admin.rates = [];
    admin.reauthenticationRequired = true;
    await open(page, admin, '/');
    await expect(page.getByText(ar.rates.stale.noneTitle)).toBeVisible();
    await page.getByRole('link', { name: ar.rates.stale.action }).click();
    await expect(page).toHaveURL('/rates');
    await expect(page.getByText(ar.rates.current.none)).toBeVisible();

    await field(page, ar.rates.form.rate).fill('118');
    await page.getByRole('button', { name: ar.rates.form.submit }).click();
    await reauthenticate(page);
    await expect(page.getByText(fill(ar.rates.current.value, { rate: '118' }))).toBeVisible();
    await expect(page.getByText(ar.rates.stale.noneTitle)).toBeHidden();

    // Rule FX2: 118 → 130 is +10.17%, so the rate is typed again, never pasted.
    await field(page, ar.rates.form.rate).fill('130');
    await expect(page.getByText(/\+10\.17%/)).toBeVisible();
    await page.getByRole('button', { name: ar.rates.form.submit }).click();
    await expect(page.getByText(ar.rates.form.errors.confirmation)).toBeVisible();
    await field(page, ar.rates.form.confirmation).fill('131');
    await page.getByRole('button', { name: ar.rates.form.submit }).click();
    await expect(page.getByText(ar.errors.api.RATE_CONFIRMATION_MISMATCH)).toBeVisible();
    await field(page, ar.rates.form.confirmation).fill('130');
    await page.getByRole('button', { name: ar.rates.form.submit }).click();
    await expect(page.getByText(fill(ar.rates.current.value, { rate: '130' }))).toBeVisible();
    expect(admin.lastBody('POST /api/admin/rates')).toEqual({
      sypPerUsd: '130',
      displayStepSypUnits: 500,
      rateConfirmation: '130',
    });
    await expect(rows(page)).toHaveCount(3);
    await expect(rows(page).nth(1)).toContainText('+10.17%');
  });

  test('a rate older than 48 hours shows the banner on every page', async ({ page, admin }) => {
    admin.rates = admin.rates.map((rate) => ({ ...rate, createdAt: minutesAgo(49 * 60) }));
    await open(page, admin, '/audit');
    await expect(page.getByText(ar.rates.stale.title)).toBeVisible();
  });
});

test.describe('deposit settings', () => {
  test('a fresh install: the notice, a currency needs its QR, then the save', async ({
    page,
    admin,
  }) => {
    admin.reauthenticationRequired = true;
    await open(page, admin, '/settings/deposits');
    await expect(page.getByText(ar.depositSettings.fresh.title)).toBeVisible();
    await field(page, ar.depositSettings.account.name).fill('متجر تجريبي');
    await field(page, ar.depositSettings.account.number).fill('0990000000');
    await page.getByRole('switch', { name: ar.depositSettings.currencies.SYP }).click();
    await page.getByRole('button', { name: ar.depositSettings.save }).click();
    await expect(page.getByText(ar.depositSettings.errors.sypQrFileId)).toBeVisible();

    await page
      .locator('input[type="file"]')
      .first()
      .setInputFiles({
        name: 'qr.png',
        mimeType: 'image/png',
        buffer: Buffer.from('not checked by the mock'),
      });
    await reauthenticate(page);
    await expect(
      page.getByRole('img', {
        name: fill(ar.depositSettings.currencies.qrAlt, {
          currency: ar.depositSettings.currencies.SYP,
        }),
      }),
    ).toBeVisible();
    await page.getByRole('button', { name: ar.depositSettings.save }).click();
    await expect(page.getByText(ar.depositSettings.saved)).toBeVisible();
    await expect(page.getByText(ar.depositSettings.fresh.title)).toBeHidden();
    expect(admin.lastBody('PUT /api/admin/deposit-settings')).toMatchObject({
      shamCashAccountName: 'متجر تجريبي',
      shamCashAccountNumber: '0990000000',
      sypEnabled: true,
      usdEnabled: false,
      minDepositUsdUnits: 2 * USD,
      reviewHoursStart: '10:00',
    });
  });
});

test.describe('deposits', () => {
  test('the queue: the badge, flagged first, the tabs and the search', async ({ page, admin }) => {
    queue(admin);
    await open(page, admin, '/deposits');
    await expect(
      page.getByLabel(fill(ar.nav.depositsBadgeFlagged, { submitted: '2' })).first(),
    ).toBeVisible();
    await expect(rows(page)).toHaveCount(3);
    await expect(rows(page).nth(1)).toContainText('VD-7KQ2M');
    await expect(rows(page).nth(1)).toContainText(ar.deposits.flags.new_account_large.label);
    await expect(rows(page).nth(2)).toContainText('VD-3HWX9');

    await page.getByRole('tab', { name: ar.deposits.tabs.pending }).click();
    await expect(page).toHaveURL('/deposits?status=pending');
    await expect(page.getByText(ar.deposits.empty.pending)).toBeVisible();
    await page.getByRole('tab', { name: ar.deposits.tabs.all }).click();
    await page.getByRole('searchbox').fill('vd-3hwx9');
    await page.getByRole('button', { name: ar.deposits.search.submit }).click();
    await expect(rows(page)).toHaveCount(2);
    await expect(rows(page).nth(1)).toContainText(ar.deposits.statuses.submitted);
  });

  test('approving: the live credit, the flags ticked, re-authentication, one key', async ({
    page,
    admin,
  }) => {
    queue(admin);
    admin.reauthenticationRequired = true;
    await open(page, admin, `/deposits/${SYP_DEPOSIT}`);
    await expect(page.getByText(ar.deposits.flags.receipt_reused.label).first()).toBeVisible();
    await expect(page.getByRole('link', { name: ar.deposits.flags.otherDeposit })).toHaveAttribute(
      'href',
      `/deposits/${OTHER_DEPOSIT}`,
    );

    await field(page, ar.deposits.approve.transaction).fill('TEST-001');
    // 2,900 pounds instead of 3,000: the credit follows what was received (rule RV2).
    await field(page, ar.deposits.approve.amountSYP).fill('2900');
    await page.getByRole('button', { name: ar.deposits.referenceChecks.matches }).click();
    await expect(page.getByText('$24.57').first()).toBeVisible();
    await expect(page.getByText(ar.deposits.flags.amount_mismatch.label)).toBeVisible();
    const submit = page.getByRole('button', {
      name: fill(ar.deposits.approve.submit, { amount: usd('$24.57') }),
    });
    await submit.click();
    await expect(page.getByText(ar.deposits.approve.errors.flags)).toBeVisible();
    for (const box of await page.getByRole('checkbox').all()) await box.click();
    // Rule RV5: a corrected amount clears the mismatch's tick; when it comes back, it is unticked.
    await field(page, ar.deposits.approve.amountSYP).fill('3000');
    await field(page, ar.deposits.approve.amountSYP).fill('2900');
    const mismatch = page.getByRole('checkbox').nth(2);
    await expect(mismatch).not.toBeChecked();
    await mismatch.click();
    await submit.click();
    await reauthenticate(page);
    await expect(page.getByRole('heading', { name: ar.deposits.detail.decision })).toBeVisible();
    await expect(page.getByText('TEST-001')).toBeVisible();
    expect(admin.lastBody(`POST /api/admin/deposits/${SYP_DEPOSIT}/approve`)).toEqual({
      transactionNumber: 'TEST-001',
      receivedCurrency: 'SYP',
      receivedAmountUnits: 290_000,
      referenceCheck: 'matches',
      acknowledgedFlags: ['new_account_large', 'receipt_reused', 'amount_mismatch'],
    });
    // The retry after re-authentication carries the first attempt's key (rule RV9).
    const keys = admin.requests
      .filter((request) => request.key.endsWith('/approve'))
      .map((request) => request.headers['idempotency-key']);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  test('a transaction number already claimed is refused under its field', async ({
    page,
    admin,
  }) => {
    queue(admin);
    admin.claimedReferences.add('TEST-001');
    await open(page, admin, `/deposits/${USD_DEPOSIT}`);
    await field(page, ar.deposits.approve.transaction).fill(' test-001 ');
    await page.getByRole('button', { name: ar.deposits.referenceChecks.matches }).click();
    await page
      .getByRole('button', { name: fill(ar.deposits.approve.submit, { amount: usd('$20.00') }) })
      .click();
    await expect(page.getByText(ar.errors.api.EXTERNAL_REFERENCE_TAKEN)).toBeVisible();
    await expect(page.getByText('0199a000-0000-7000-8000-0000000000b9')).toBeVisible();
  });

  test('a clearer receipt once, then a rejection with its reasons', async ({ page, admin }) => {
    queue(admin);
    await open(page, admin, `/deposits/${USD_DEPOSIT}`);
    await page.getByRole('button', { name: ar.deposits.requestReceipt.open }).click();
    const request = page.getByRole('dialog');
    await request.getByLabel(ar.deposits.decision.customerNote).fill('الصورة مقطوعة');
    await request.getByLabel(ar.deposits.decision.internalNote).fill('رقم العملية غير ظاهر');
    await request.getByRole('button', { name: ar.deposits.requestReceipt.submit }).click();
    await expect(request).toBeHidden();
    await expect(page.getByText(ar.deposits.statuses.pending).first()).toBeVisible();
    await expect(page.getByRole('button', { name: ar.deposits.requestReceipt.open })).toBeHidden();

    // The customer sends a new receipt: back in review, the request already used.
    const [usd] = admin.deposits;
    if (usd) usd.status = 'submitted';
    await page.reload();
    await expect(page.getByRole('button', { name: ar.deposits.requestReceipt.open })).toBeHidden();
    await page.getByRole('button', { name: ar.deposits.reject.open }).click();
    const reject = page.getByRole('dialog');
    await reject.getByRole('combobox', { name: ar.deposits.reject.reason }).click();
    await page.getByRole('option', { name: ar.deposits.rejectReasons.other }).click();
    await reject.getByLabel(ar.deposits.decision.internalNote).fill('إيصال معدّل');
    await reject.getByRole('button', { name: ar.deposits.reject.submit }).click();
    await expect(reject.getByText(ar.deposits.decision.errors.customerNote)).toBeVisible();
    await reject.getByLabel(ar.deposits.decision.customerNoteRequired).fill('راجعنا الصورة');
    await reject.getByRole('button', { name: ar.deposits.reject.submit }).click();
    await expect(reject).toBeHidden();
    await expect(page.getByText(ar.deposits.rejectReasons.other)).toBeVisible();
    expect(admin.lastBody(`POST /api/admin/deposits/${USD_DEPOSIT}/reject`)).toEqual({
      reason: 'other',
      customerNote: 'راجعنا الصورة',
      internalNote: 'إيصال معدّل',
    });
  });
});

test.describe('Telegram (S05 rules TC4, TC5)', () => {
  test('the deposit settings hold the Telegram limit; decisions from the bot are marked', async ({
    page,
    admin,
  }) => {
    queue(admin);
    admin.auditEntries.unshift(telegramDecision());
    await open(page, admin, `/deposits/${SYP_DEPOSIT}`);
    await expect(page.getByText(ar.deposits.detail.fromTelegram)).toBeVisible();

    admin.reauthenticationRequired = false;
    await page.goto('/settings/deposits');
    const limit = field(page, ar.depositSettings.fields.telegramApprovalMaxUsdUnits);
    await expect(limit).toHaveValue('100');
    await limit.fill('150');
    await page.getByRole('button', { name: ar.depositSettings.save }).click();
    await expect(
      page.getByText(ar.depositSettings.errors.telegramApprovalMaxUsdUnits),
    ).toBeVisible();
  });
});

/** A rejection of the SYP deposit made in the bot, as the audit log records it. */
const telegramDecision = (): AuditEntry => ({
  id: '0199a000-0000-7000-8000-0000000000ea',
  occurredAt: minutesAgo(2),
  actorKind: 'admin',
  actorId: '0199a000-0000-7000-8000-000000000001',
  actorName: 'ريم الخطيب',
  channel: 'telegram',
  action: 'deposit.rejected',
  entityType: 'deposit',
  entityId: SYP_DEPOSIT,
  reason: 'لم يصل التحويل إلى الحساب',
  details: {
    depositId: SYP_DEPOSIT,
    customerId: CUSTOMER_ID,
    rejectReason: 'not_received',
    customerNote: null,
  },
  ipAddress: null,
  userAgent: null,
});

// RTL screenshots of the S03 screens in both themes: the design review evidence (ADR 0011).
for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('S03 screenshots', async ({ page, admin }, testInfo) => {
      queue(admin);
      await open(page, admin, '/deposits');
      await expect(rows(page)).toHaveCount(3);
      await screenshot(page, testInfo, `deposits-queue-${colorScheme}`);

      await page.goto(`/deposits/${SYP_DEPOSIT}`);
      await field(page, ar.deposits.approve.transaction).fill('TEST-001');
      await field(page, ar.deposits.approve.amountSYP).fill('2900');
      await page.getByRole('button', { name: ar.deposits.referenceChecks.different }).click();
      await expect(page.getByText(ar.deposits.flags.amount_mismatch.label)).toBeVisible();
      await screenshot(page, testInfo, `deposit-review-${colorScheme}`, { fullPage: true });

      await page.getByRole('button', { name: ar.deposits.reject.open }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await screenshot(page, testInfo, `deposit-reject-${colorScheme}`);
      await page.keyboard.press('Escape');

      await page.goto('/rates');
      await field(page, ar.rates.form.rate).fill('130');
      await expect(field(page, ar.rates.form.confirmation)).toBeVisible();
      await screenshot(page, testInfo, `rates-${colorScheme}`);

      await page.goto('/settings/deposits');
      await expect(page.getByText(ar.depositSettings.fresh.title)).toBeVisible();
      await screenshot(page, testInfo, `deposit-settings-${colorScheme}`);
    });

    test('S05 screenshots', async ({ page, admin }, testInfo) => {
      queue(admin);
      admin.auditEntries.unshift(telegramDecision());
      await open(page, admin, `/deposits/${SYP_DEPOSIT}`);
      const trail = page.getByRole('region', { name: ar.deposits.detail.audit });
      await expect(trail.getByText(ar.deposits.detail.fromTelegram)).toBeVisible();
      await trail.scrollIntoViewIfNeeded();
      await screenshot(page, testInfo, `deposit-audit-telegram-${colorScheme}`);

      await page.goto('/settings/deposits');
      const limit = page.getByRole('heading', { name: ar.depositSettings.telegram.title });
      await limit.scrollIntoViewIfNeeded();
      await screenshot(page, testInfo, `deposit-settings-telegram-${colorScheme}`);
    });
  });
}
