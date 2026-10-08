import type { Page } from '@playwright/test';
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
 * USDT deposits (S04): the queue's method filter, a deposit in review with its transfer and
 * candidates, the approval with the received amount, the re-check, the incoming transfers with the
 * prefilled manual deposit, and the USDT settings, against the mocked API. The addresses are the
 * fake values of `.env.example`; the TXIDs are made up.
 */

const REVIEW_DEPOSIT = '0199a000-0000-7000-8000-0000000000d5';
const SHAM_DEPOSIT = '0199a000-0000-7000-8000-0000000000d6';
const AUTO_DEPOSIT = '0199a000-0000-7000-8000-0000000000d7';
const CANDIDATE_DEPOSIT = '0199a000-0000-7000-8000-0000000000d8';
const TRANSFER_ID = '0199a000-0000-7000-8000-0000000000c5';
const UNMATCHED_ID = '0199a000-0000-7000-8000-0000000000c6';
const TRON_ADDRESS = 'TD5gsCwxykWsLN9aPrq2TAfNjByuZKYp4E';
const BSC_ADDRESS = '0xabababababababababababababababababababab';
const SENDER = '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd';
const TXID = 'ab'.repeat(32);
const UNMATCHED_TXID = 'cd'.repeat(32);

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const field = (page: Page, label: string) =>
  page.getByLabel(label, { exact: true }).filter({ visible: true });

/** A USD amount as the panel isolates it inside an Arabic sentence (`ltr()`). */
const usd = (text: string) => `⁦${text}⁩`;

const fill = (text: string, values: Record<string, string>) =>
  Object.entries(values).reduce(
    (result, [key, value]) => result.replace(`{{${key}}}`, value),
    text,
  );

const CUSTOMER = {
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
};

const CANDIDATE = {
  depositId: CANDIDATE_DEPOSIT,
  referenceCode: 'VD-5CN8D',
  status: 'expired',
  payAmountUnits: 7_123_400,
  createdAt: minutesAgo(26 * 60),
  customer: { id: CUSTOMER_ID, name: 'سارة الأحمد', email: 'sara@example.com' },
};

/** The acceptance's review: $10 on BEP20, `10.0042` asked, `9.0042` received. */
function reviewDeposit(changes: Partial<MockDeposit> = {}): MockDeposit {
  return {
    id: REVIEW_DEPOSIT,
    method: 'usdt_bep20',
    status: 'submitted',
    referenceCode: 'VD-8BSC2',
    currency: 'USD',
    declaredAmountUnits: 10 * USD,
    declaredUsdUnits: 10 * USD,
    quote: null,
    expiresAt: minutesAgo(-24 * 60),
    createdAt: minutesAgo(30),
    submittedAt: minutesAgo(20),
    decidedAt: null,
    rateFixedAt: null,
    receiptRequestedAt: null,
    receiptRequestCount: 0,
    receiptRequestNote: null,
    approvalRate: null,
    decidedBy: null,
    adminName: null,
    credit: null,
    rejection: null,
    receipts: [],
    flags: [
      {
        id: '0199a000-0000-7000-8000-0000000000ab',
        code: 'amount_mismatch',
        receiptId: null,
        details: {
          declaredCurrency: 'USD',
          declaredAmountUnits: 10_004_200,
          receivedCurrency: 'USD',
          receivedAmountUnits: 9_004_200,
        },
        createdAt: minutesAgo(15),
      },
    ],
    customer: CUSTOMER,
    eta: { state: 'open', minutes: 15 },
    usdt: {
      method: 'usdt_bep20',
      address: BSC_ADDRESS,
      payAmount: '10.0042',
      payAmountUnits: 10_004_200,
      checkStatus: 'review',
      checkError: null,
      txid: TXID,
      explorerUrl: `https://bscscan.com/tx/0x${TXID}`,
      confirmations: 15,
      requiredConfirmations: 15,
      delayed: false,
      receivedAmountUnits: 9_004_200,
      reviewReasons: ['amount_mismatch'],
      tailUnits: 4_200,
      txidSource: 'customer',
      txidSubmissions: 2,
      lastCheckedAt: minutesAgo(14),
      transfer: {
        id: TRANSFER_ID,
        method: 'usdt_bep20',
        txid: TXID,
        explorerUrl: `https://bscscan.com/tx/0x${TXID}`,
        fromAddress: SENDER,
        toAddress: BSC_ADDRESS,
        rawAmount: '9004200000000000000',
        amountUnits: 9_004_200,
        blockNumber: 43_000_123,
        blockTime: minutesAgo(16),
        source: 'txid',
        createdAt: minutesAgo(15),
      },
      candidates: [{ ...CANDIDATE, depositId: REVIEW_DEPOSIT, referenceCode: 'VD-8BSC2' }],
    },
    ...changes,
  };
}

/** A Sham Cash deposit in the same queue, which the method filter hides. */
function shamCashDeposit(): MockDeposit {
  return {
    ...reviewDeposit(),
    id: SHAM_DEPOSIT,
    method: 'sham_cash',
    referenceCode: 'VD-3HWX9',
    declaredAmountUnits: 20 * USD,
    declaredUsdUnits: 20 * USD,
    flags: [],
    receipts: [{ id: '0199a000-0000-7000-8000-0000000000e9', createdAt: minutesAgo(20) }],
    usdt: null,
  };
}

/** An exact match the worker credited (rule U7). */
function autoCredited(): MockDeposit {
  const review = reviewDeposit();
  const usdt = review.usdt as Record<string, unknown>;
  return {
    ...review,
    id: AUTO_DEPOSIT,
    method: 'usdt_trc20',
    referenceCode: 'VD-9TR4X',
    status: 'credited',
    decidedAt: minutesAgo(5),
    decidedBy: 'system',
    flags: [],
    credit: {
      transactionNumber: UNMATCHED_TXID,
      receivedCurrency: 'USD',
      receivedAmountUnits: 25_003_700,
      creditedUsdUnits: 25 * USD,
      creditRateId: null,
      creditRate: null,
      referenceCheck: null,
      journalId: '0199a000-0000-7000-9000-0000000000c3',
    },
    usdt: {
      ...usdt,
      method: 'usdt_trc20',
      address: TRON_ADDRESS,
      checkStatus: 'done',
      txidSource: 'scan',
      candidates: [],
    },
  };
}

/** A $7.1234 transfer no live deposit holds, an expired deposit as its candidate (U4, U13). */
function unmatched(admin: AdminApi) {
  admin.usdtTransfers = [
    {
      id: UNMATCHED_ID,
      method: 'usdt_bep20',
      txid: UNMATCHED_TXID,
      explorerUrl: `https://bscscan.com/tx/0x${UNMATCHED_TXID}`,
      fromAddress: SENDER,
      toAddress: BSC_ADDRESS,
      rawAmount: '7123400000000000000',
      amountUnits: 7_123_400,
      blockNumber: 43_000_456,
      blockTime: minutesAgo(3),
      source: 'scan',
      createdAt: minutesAgo(2),
      candidates: [CANDIDATE],
    },
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

test.describe('USDT deposits', () => {
  test('the queue filters by method and names each one', async ({ page, admin }) => {
    admin.deposits = [shamCashDeposit(), reviewDeposit()];
    await open(page, admin, '/deposits');
    await expect(rows(page)).toHaveCount(3);
    await expect(rows(page).filter({ hasText: 'VD-8BSC2' })).toContainText(
      ar.wallets.methods.usdt_bep20,
    );
    await expect(rows(page).filter({ hasText: 'VD-8BSC2' })).toContainText(
      ar.deposits.flags.amount_mismatch.label,
    );

    await page.getByRole('combobox', { name: ar.deposits.methodFilter.label }).click();
    await page.getByRole('option', { name: ar.wallets.methods.usdt_bep20 }).click();
    await expect(page).toHaveURL('/deposits?method=usdt_bep20');
    await expect(rows(page)).toHaveCount(2);
    await expect(rows(page).nth(1)).toContainText('VD-8BSC2');
  });

  test('a review: the transfer and its difference, then the approval of what arrived', async ({
    page,
    admin,
  }) => {
    admin.deposits = [reviewDeposit()];
    await open(page, admin, `/deposits/${REVIEW_DEPOSIT}`);
    await expect(page.getByText(BSC_ADDRESS).first()).toBeVisible();
    await expect(page.getByText(SENDER)).toBeVisible();
    await expect(
      page.getByText(fill(ar.deposits.usdt.less, { amount: usd('1.0000 USDT') })),
    ).toBeVisible();
    await expect(page.getByText(ar.deposits.usdt.txidSources.customer)).toBeVisible();
    await expect(page.getByRole('link', { name: 'VD-8BSC2' })).toHaveAttribute(
      'href',
      `/deposits/${REVIEW_DEPOSIT}`,
    );
    // No clearer-receipt request for USDT.
    await expect(page.getByRole('button', { name: ar.deposits.requestReceipt.open })).toBeHidden();

    // The credit is what arrived, floored to whole cents; never typed (rule U15).
    const submit = page.getByRole('button', {
      name: fill(ar.deposits.approve.submit, { amount: usd('$9.00') }),
    });
    await submit.click();
    await expect(page.getByText(ar.deposits.approve.errors.flags)).toBeVisible();
    await page.getByRole('checkbox').click();
    admin.reauthenticationRequired = true;
    await submit.click();
    await reauthenticate(page);
    await expect(page.getByRole('heading', { name: ar.deposits.detail.decision })).toBeVisible();
    await expect(page.getByText(ar.deposits.statuses.credited).first()).toBeVisible();
    expect(admin.lastBody(`POST /api/admin/deposits/${REVIEW_DEPOSIT}/approve-usdt`)).toEqual({
      acknowledgedFlags: ['amount_mismatch'],
    });
    const keys = admin.requests
      .filter((request) => request.key.endsWith('/approve-usdt'))
      .map((request) => request.headers['idempotency-key']);
    // The retry after re-authentication carries the first attempt's key.
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  test('re-check, the USDT reject reasons, and an automatic credit', async ({ page, admin }) => {
    admin.deposits = [reviewDeposit(), autoCredited()];
    await open(page, admin, `/deposits/${REVIEW_DEPOSIT}`);
    await page.getByRole('button', { name: ar.deposits.usdt.recheck }).click();
    await expect(page.getByRole('button', { name: ar.deposits.usdt.rechecked })).toBeVisible();
    expect(admin.calls).toContain(`POST /api/admin/deposits/${REVIEW_DEPOSIT}/recheck`);

    await page.getByRole('button', { name: ar.deposits.reject.open }).click();
    await page.getByRole('combobox', { name: ar.deposits.reject.reason }).click();
    await expect(
      page.getByRole('option', { name: ar.deposits.rejectReasons.wrong_network }),
    ).toBeVisible();
    await expect(
      page.getByRole('option', { name: ar.deposits.rejectReasons.receipt_invalid }),
    ).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    await page.goto(`/deposits/${AUTO_DEPOSIT}`);
    await expect(page.getByText(ar.deposits.detail.decidedBySystem, { exact: true })).toBeVisible();
    await expect(page.getByText(ar.deposits.usdt.txidSources.scan)).toBeVisible();
    await expect(page.getByRole('button', { name: ar.deposits.reject.open })).toBeHidden();
  });

  test('an unmatched transfer: the badge, its candidate, then the manual deposit prefilled', async ({
    page,
    admin,
  }) => {
    unmatched(admin);
    await open(page, admin, '/deposits/transfers');
    await expect(
      page.getByLabel(fill(ar.nav.usdtTransfersBadge, { unmatched: '1' })).first(),
    ).toBeVisible();
    await expect(page.getByText('7.1234 USDT').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'VD-5CN8D' })).toBeVisible();

    await page.getByRole('button', { name: ar.deposits.transfers.record }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /سارة الأحمد/ })
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: ar.wallets.adjust.title })).toBeVisible();
    await expect(field(page, ar.wallets.adjust.amount)).toHaveValue('7.12');
    await expect(field(page, ar.wallets.adjust.reference)).toHaveValue(UNMATCHED_TXID);
    await expect(dialog.getByRole('combobox', { name: ar.wallets.adjust.method })).toContainText(
      ar.wallets.methods.usdt_bep20,
    );
    await field(page, ar.wallets.adjust.reason).fill('تحويل متأخر لإيداع منتهٍ');
    await dialog.getByRole('button', { name: ar.wallets.adjust.submit }).click();
    await expect(dialog).toBeHidden();
    expect(admin.lastBody(`POST /api/admin/wallets/${CUSTOMER_ID}/adjustments`)).toMatchObject({
      direction: 'credit',
      amountUnits: 7_120_000,
      category: 'manual_deposit',
      depositMethod: 'usdt_bep20',
      externalReference: UNMATCHED_TXID,
    });

    await expect(page.getByText(ar.deposits.transfers.emptyUnmatched)).toBeVisible();
    await page.getByRole('button', { name: ar.deposits.transfers.all }).click();
    await expect(page).toHaveURL('/deposits/transfers?state=all');
    await expect(rows(page).nth(1)).toContainText(ar.deposits.transfers.states.credited);
  });

  test('the settings: the addresses read-only, a switch per network, the minimum', async ({
    page,
    admin,
  }) => {
    admin.depositSettings = {
      ...admin.depositSettings,
      shamCashAccountName: 'متجر تجريبي',
      shamCashAccountNumber: '0990000000',
      saved: true,
      savedAt: minutesAgo(60),
      usdt: [
        { method: 'usdt_trc20', address: TRON_ADDRESS, lastScanAt: minutesAgo(1), delayed: false },
        { method: 'usdt_bep20', address: null, lastScanAt: null, delayed: true },
      ],
    };
    admin.reauthenticationRequired = true;
    await open(page, admin, '/settings/deposits');
    await expect(page.getByText(TRON_ADDRESS)).toBeVisible();
    await expect(page.getByText(ar.depositSettings.usdt.noAddress)).toBeVisible();
    await expect(page.getByRole('switch', { name: ar.wallets.methods.usdt_bep20 })).toBeDisabled();
    await page.getByRole('switch', { name: ar.wallets.methods.usdt_trc20 }).click();
    await field(page, ar.depositSettings.fields.usdtMinDepositUsdUnits).fill('7');
    await page.getByRole('button', { name: ar.depositSettings.save }).click();
    await reauthenticate(page);
    await expect(page.getByText(ar.depositSettings.saved)).toBeVisible();
    expect(admin.lastBody('PUT /api/admin/deposit-settings')).toMatchObject({
      usdtTrc20Enabled: true,
      usdtBep20Enabled: false,
      usdtMinDepositUsdUnits: 7 * USD,
    });
  });
});

// RTL screenshots of the S04 screens in both themes.
for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('S04 screenshots', async ({ page, admin }, testInfo) => {
      admin.deposits = [shamCashDeposit(), reviewDeposit()];
      unmatched(admin);
      admin.depositSettings = {
        ...admin.depositSettings,
        usdt: [
          {
            method: 'usdt_trc20',
            address: TRON_ADDRESS,
            lastScanAt: minutesAgo(1),
            delayed: false,
          },
          { method: 'usdt_bep20', address: BSC_ADDRESS, lastScanAt: minutesAgo(15), delayed: true },
        ],
      };
      await open(page, admin, '/deposits');
      await expect(rows(page)).toHaveCount(3);
      await screenshot(page, testInfo, `usdt-queue-${colorScheme}`);

      await page.goto(`/deposits/${REVIEW_DEPOSIT}`);
      await expect(page.getByText(SENDER)).toBeVisible();
      await screenshot(page, testInfo, `usdt-review-${colorScheme}`, { fullPage: true });

      await page.goto('/deposits/transfers');
      await expect(page.getByText('7.1234 USDT').first()).toBeVisible();
      await screenshot(page, testInfo, `usdt-transfers-${colorScheme}`);

      await page.goto('/settings/deposits');
      await expect(page.getByText(TRON_ADDRESS)).toBeVisible();
      await page.getByText(ar.depositSettings.usdt.title, { exact: true }).scrollIntoViewIfNeeded();
      await screenshot(page, testInfo, `usdt-settings-${colorScheme}`, { fullPage: true });
    });
  });
}
