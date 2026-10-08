import type { Page } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import { expect, type MockApi, screenshot, test } from './test';

/*
 * Sham Cash deposits (S03): the wallet card, the deposit form, a deposit's page by status, the
 * requote, and the list, against the mocked API. Amounts are in units (ADR 0003); the account
 * details are test values only.
 */

const USD = 1_000_000;
const DEPOSIT_ID = '0199a000-0000-7000-8000-0000000000d1';
const RATE_ID = '0199a000-0000-7000-8000-0000000000f1';
const NEW_RATE_ID = '0199a000-0000-7000-8000-0000000000f2';
const DEPOSIT_PATH = `/api/deposits/${DEPOSIT_ID}`;

const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

/** A signed-in customer. */
function signedIn(api: MockApi): MockApi {
  return api.on('GET /api/auth/get-session', 200, {
    user: { name: 'سارة الأحمد', email: 'sara@example.com' },
    session: { token: 'this-device' },
  });
}

const OPTIONS = {
  currencies: { SYP: { available: true, reason: null }, USD: { available: true, reason: null } },
  account: { name: 'متجر تجريبي', number: '0990000000' },
  limits: {
    established: false,
    minUnits: 2 * USD,
    perDepositUnits: 50 * USD,
    dailyUnits: 100 * USD,
    remainingTodayUnits: 100 * USD,
  },
  rate: { id: RATE_ID, sypPerUsd: '118', displayStepSypUnits: 500 },
  reviewHours: { start: '10:00', end: '22:00' },
  eta: { state: 'open', minutes: 15 },
  pendingDepositId: null,
};

/** A 2,000-pound deposit waiting for its receipt, its quote locked for 15 minutes. */
function deposit(changes: Record<string, unknown> = {}) {
  return {
    id: DEPOSIT_ID,
    method: 'sham_cash',
    status: 'pending',
    referenceCode: 'VD-7KQ2M',
    currency: 'SYP',
    declaredAmountUnits: 200_000,
    declaredUsdUnits: 16_940_000,
    quote: { rateId: RATE_ID, rate: '118', expiresAt: minutesFromNow(15) },
    expiresAt: minutesFromNow(24 * 60),
    createdAt: '2026-10-08T09:00:00.000Z',
    submittedAt: null,
    decidedAt: null,
    rateFixed: false,
    receiptRequest: null,
    payTo: {
      accountName: 'متجر تجريبي',
      accountNumber: '0990000000',
      qrUrl: '/api/deposits/sham-cash/qr/SYP',
    },
    eta: null,
    credited: null,
    rejection: null,
    ...changes,
  };
}

const SUBMITTED = deposit({
  status: 'submitted',
  submittedAt: '2026-10-08T09:05:00.000Z',
  rateFixed: true,
  payTo: null,
  eta: { state: 'open', minutes: 20 },
});

const CREDITED = deposit({
  status: 'credited',
  submittedAt: '2026-10-08T09:05:00.000Z',
  decidedAt: '2026-10-08T09:20:00.000Z',
  rateFixed: true,
  payTo: null,
  credited: {
    usdUnits: 16_100_000,
    receivedCurrency: 'SYP',
    receivedAmountUnits: 190_000,
    rate: '118',
  },
});

const REJECTED = deposit({
  status: 'rejected',
  currency: 'USD',
  declaredAmountUnits: 25 * USD,
  declaredUsdUnits: 25 * USD,
  quote: null,
  submittedAt: '2026-10-08T09:05:00.000Z',
  decidedAt: '2026-10-08T09:20:00.000Z',
  payTo: null,
  rejection: { reason: 'receipt_invalid', note: 'الصورة لا تُظهر رقم العملية' },
});

/** A pending deposit's page, with its QR image. */
function pending(api: MockApi, changes: Record<string, unknown> = {}): MockApi {
  return signedIn(api)
    .on(`GET ${DEPOSIT_PATH}`, 200, deposit(changes))
    .image('GET /api/deposits/sham-cash/qr/SYP');
}

/** The receipt chosen with the file picker (the first of the page's file inputs). */
async function chooseReceipt(page: Page) {
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: 'receipt.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64',
      ),
    });
  await expect(page.getByRole('img', { name: ar.deposits.receipt.preview })).toBeVisible();
}

/** A USD amount as the screens isolate it inside an Arabic sentence (`ltr()`). */
const usd = (text: string) => `\u2066${text}\u2069`;

const fill = (text: string, values: Record<string, string>) =>
  Object.entries(values).reduce((result, [key, value]) => result.replace(`{${key}}`, value), text);

test.describe('deposits', () => {
  test('the wallet shows the SYP value, the deposit links and deposit entries', async ({
    page,
    api,
  }) => {
    signedIn(api)
      .on('GET /api/wallet', 200, {
        balanceUnits: 16_100_000,
        syp: { valueUnits: 189_500, rate: '118' },
      })
      .on('GET /api/wallet/entries', 200, {
        items: [
          {
            occurredAt: '2026-10-08T09:20:00.000Z',
            kind: 'deposit',
            amountUnits: 16_100_000,
            balanceAfterUnits: 16_100_000,
            adjustment: null,
            deposit: {
              method: 'sham_cash',
              referenceCode: 'VD-7KQ2M',
              syp: { amountUnits: 190_000, rate: '118' },
            },
          },
        ],
        nextCursor: null,
      });
    await page.goto('/wallet');
    const main = page.locator('main');
    await expect(main.getByText(fill(ar.wallet.syp, { amount: '1,895' }))).toBeVisible();
    await expect(main.getByText(fill(ar.wallet.sypRate, { rate: '118' }))).toBeVisible();
    const row = main.getByRole('listitem');
    await expect(row).toContainText(ar.wallet.depositMethods.sham_cash);
    await expect(row).toContainText('VD-7KQ2M');
    await expect(row).toContainText(fill(ar.wallet.depositSyp, { amount: '1,900', rate: '118' }));
    await expect(main.getByRole('link', { name: ar.wallet.myDeposits })).toHaveAttribute(
      'href',
      '/wallet/deposits',
    );
    await expect(main.getByRole('link', { name: ar.wallet.deposit, exact: true })).toHaveAttribute(
      'href',
      '/wallet/deposit',
    );
  });

  test('a SYP deposit: the preview, then the deposit created with its key and challenge', async ({
    page,
    api,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    signedIn(api).on('GET /api/deposits/sham-cash/options', 200, OPTIONS);
    await page.goto('/wallet/deposit');
    // The $10 preset in pounds: 10 × 118 = 1,180, rounded up to the 5-pound step.
    await page.getByRole('button', { name: '1,180 ل.س' }).click();
    await expect(page.getByLabel(ar.deposits.form.amountSyp)).toHaveValue('1180');
    await page.getByLabel(ar.deposits.form.amountSyp).fill('2000');
    await expect(
      page.getByText(fill(ar.deposits.form.youGet, { amount: usd('$16.94') })),
    ).toBeVisible();
    await expect(page.getByText(fill(ar.deposits.form.rate, { rate: '118' }))).toBeVisible();

    pending(api).on('POST /api/deposits/sham-cash', 201, deposit());
    await page.getByRole('button', { name: ar.deposits.form.submit }).click();
    await expect(page).toHaveURL(`/wallet/deposits/${DEPOSIT_ID}`);
    const created = api.last('POST /api/deposits/sham-cash');
    expect(created?.body).toEqual({ currency: 'SYP', amountUnits: 200_000 });
    expect(created?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(created?.headers['x-altcha']).toBeTruthy();

    // Rule SC7: the account, the amount, the code and the countdown.
    await expect(page.getByText('VD-7KQ2M')).toBeVisible();
    await expect(page.getByText('0990000000')).toBeVisible();
    await expect(page.getByText('2,000 ل.س')).toBeVisible();
    await expect(page.getByText(ar.deposits.pending.referenceNote)).toBeVisible();
    await expect(page.getByText(/مقفل لمدة 1[45]:\d\d/)).toBeVisible();
    await page.getByRole('button', { name: ar.deposits.pending.copyReference }).click();
    await expect(page.getByRole('button', { name: ar.deposits.copied })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('VD-7KQ2M');
  });

  test('limits, an open deposit and no method are handled before sending', async ({
    page,
    api,
  }) => {
    signedIn(api).on('GET /api/deposits/sham-cash/options', 200, OPTIONS);
    await page.goto('/wallet/deposit');
    await page.getByRole('button', { name: '$', exact: true }).click();
    await page.getByLabel(ar.deposits.form.amountUsd).fill('60');
    await page.getByRole('button', { name: ar.deposits.form.submit }).click();
    await expect(
      page.getByText(fill(ar.deposits.limits.perDeposit, { limit: usd('$50.00') })),
    ).toBeVisible();
    expect(api.last('POST /api/deposits/sham-cash')).toBeUndefined();

    // A deposit already waiting for its receipt opens instead (rule SC4).
    pending(api).on('GET /api/deposits/sham-cash/options', 200, {
      ...OPTIONS,
      pendingDepositId: DEPOSIT_ID,
    });
    await page.goto('/wallet/deposit');
    await expect(page).toHaveURL(`/wallet/deposits/${DEPOSIT_ID}`);

    // Nothing to deposit with yet (edge case 11).
    api.on('GET /api/deposits/sham-cash/options', 200, {
      ...OPTIONS,
      currencies: {
        SYP: { available: false, reason: 'not_configured' },
        USD: { available: false, reason: 'not_configured' },
      },
      account: null,
      limits: null,
      rate: null,
    });
    await page.goto('/wallet/deposit');
    await expect(page.getByText(ar.deposits.form.unavailableTitle)).toBeVisible();
  });

  test('the receipt after the quote expired: the new rate, accepted, then submitted', async ({
    page,
    api,
  }) => {
    pending(api).on(`POST ${DEPOSIT_PATH}/receipt`, 409, {
      code: 'QUOTE_EXPIRED',
      details: { rateId: NEW_RATE_ID, rate: '130', declaredUsdUnits: 15_380_000 },
    });
    await page.goto(`/wallet/deposits/${DEPOSIT_ID}`);
    await chooseReceipt(page);
    await page.getByRole('button', { name: ar.deposits.pending.submit }).click();
    const sheet = page.getByRole('dialog', { name: ar.deposits.requote.title });
    await expect(sheet).toContainText('130');
    await expect(sheet).toContainText('$15.38');

    api
      .on(
        `POST ${DEPOSIT_PATH}/quote`,
        200,
        deposit({
          quote: { rateId: NEW_RATE_ID, rate: '130', expiresAt: minutesFromNow(15) },
          declaredUsdUnits: 15_380_000,
        }),
      )
      .on(`POST ${DEPOSIT_PATH}/receipt`, 200, SUBMITTED);
    await sheet.getByRole('button', { name: ar.deposits.requote.accept }).click();
    await expect(
      page.getByRole('heading', { name: ar.deposits.detail.submittedTitle }),
    ).toBeVisible();
    await expect(page.getByText(fill(ar.deposits.eta.open, { minutes: '20' }))).toBeVisible();
    // The second submission carries the rate the customer accepted (rule SC9).
    expect(String(api.last(`POST ${DEPOSIT_PATH}/receipt`)?.body)).toContain(NEW_RATE_ID);
  });

  test('a clearer-receipt request shows its note; cancelling asks first', async ({ page, api }) => {
    pending(api, {
      currency: 'USD',
      declaredAmountUnits: 25 * USD,
      declaredUsdUnits: 25 * USD,
      quote: null,
      receiptRequest: { at: '2026-10-08T09:30:00.000Z', note: 'الصورة مقطوعة، أرسل الإيصال كاملًا' },
    });
    await page.goto(`/wallet/deposits/${DEPOSIT_ID}`);
    await expect(page.getByText(ar.deposits.pending.receiptRequested)).toBeVisible();
    await expect(page.getByText('الصورة مقطوعة، أرسل الإيصال كاملًا')).toBeVisible();
    await expect(page.getByText('$25.00').first()).toBeVisible();

    api.on(`POST ${DEPOSIT_PATH}/cancel`, 200, deposit({ status: 'cancelled', quote: null }));
    await page.getByRole('button', { name: ar.deposits.pending.cancel }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: ar.deposits.cancel.confirm })
      .click();
    await expect(
      page.getByRole('heading', { name: ar.deposits.detail.cancelledTitle }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: ar.deposits.newDeposit })).toBeVisible();
  });

  test('credited and rejected deposits say what happened', async ({ page, api }) => {
    signedIn(api).on(`GET ${DEPOSIT_PATH}`, 200, CREDITED);
    await page.goto(`/wallet/deposits/${DEPOSIT_ID}`);
    await expect(
      page.getByRole('heading', { name: ar.deposits.detail.creditedTitle }),
    ).toBeVisible();
    await expect(page.getByText('$16.10')).toBeVisible();
    await expect(
      page.getByText(fill(ar.deposits.sypAtRate, { amount: '1,900', rate: '118' })),
    ).toBeVisible();

    api.on(`GET ${DEPOSIT_PATH}`, 200, REJECTED);
    await page.reload();
    await expect(page.getByText(ar.deposits.rejectReasons.receipt_invalid)).toBeVisible();
    await expect(page.getByText('الصورة لا تُظهر رقم العملية')).toBeVisible();
    await expect(page.getByRole('link', { name: ar.deposits.newDeposit })).toHaveAttribute(
      'href',
      '/wallet/deposit',
    );
  });

  test('another customer’s deposit is the 404 page', async ({ page, api }) => {
    signedIn(api).on(`GET ${DEPOSIT_PATH}`, 404, { code: 'NOT_FOUND' });
    await page.goto(`/wallet/deposits/${DEPOSIT_ID}`);
    await expect(page.getByText(ar.notFound.title)).toBeVisible();
  });

  test('the list loads more, and an empty one offers a deposit', async ({ page, api }) => {
    signedIn(api).on('GET /api/deposits', 200, { items: [CREDITED], nextCursor: 'page-2' });
    await page.goto('/wallet/deposits');
    const rows = page.locator('main').getByRole('listitem');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(ar.deposits.statuses.credited);
    api.on('GET /api/deposits', 200, { items: [REJECTED], nextCursor: null });
    await page.getByRole('button', { name: ar.wallet.loadMore }).click();
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(1)).toContainText(ar.deposits.statuses.rejected);

    api.on('GET /api/deposits', 200, { items: [], nextCursor: null });
    await page.reload();
    await expect(page.getByText(ar.deposits.list.emptyTitle)).toBeVisible();
  });
});

// RTL screenshots, dark and light, at phone width and desktop.
for (const theme of ['dark', 'light'] as const) {
  test(`deposit screenshots, ${theme} theme`, async ({ page, api }, testInfo) => {
    if (theme === 'light') {
      await page.addInitScript(() => localStorage.setItem('vertex-theme', 'light'));
    }
    signedIn(api)
      .on('GET /api/wallet', 200, {
        balanceUnits: 16_100_000,
        syp: { valueUnits: 189_500, rate: '118' },
      })
      .on('GET /api/wallet/entries', 200, { items: [], nextCursor: null })
      .on('GET /api/deposits/sham-cash/options', 200, OPTIONS);
    await page.goto('/wallet');
    await expect(
      page.locator('main').getByText(fill(ar.wallet.syp, { amount: '1,895' })),
    ).toBeVisible();
    await screenshot(page, testInfo, `wallet-syp-${theme}`);

    await page.goto('/wallet/deposit');
    await page.getByLabel(ar.deposits.form.amountSyp).fill('2000');
    await expect(
      page.getByText(fill(ar.deposits.form.youGet, { amount: usd('$16.94') })),
    ).toBeVisible();
    await screenshot(page, testInfo, `deposit-form-${theme}`);

    pending(api);
    await page.goto(`/wallet/deposits/${DEPOSIT_ID}`);
    await expect(page.getByText('VD-7KQ2M')).toBeVisible();
    await screenshot(page, testInfo, `deposit-pending-${theme}`);

    for (const [name, state] of [
      ['submitted', SUBMITTED],
      ['credited', CREDITED],
      ['rejected', REJECTED],
    ] as const) {
      api.on(`GET ${DEPOSIT_PATH}`, 200, state);
      await page.reload();
      await expect(page.getByText(ar.deposits.statuses[name]).first()).toBeVisible();
      await screenshot(page, testInfo, `deposit-${name}-${theme}`);
    }
  });
}
