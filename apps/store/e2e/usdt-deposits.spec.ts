import ar from '../src/messages/ar.json' with { type: 'json' };
import { expect, type MockApi, screenshot, test } from './test';

/*
 * USDT deposits (S04): the method picker, the USDT form with the busy-amount offer, and a
 * deposit's page by its check status, against the mocked API. The addresses are the fake values
 * of `.env.example`; the TXIDs are made up.
 */

const USD = 1_000_000;
const DEPOSIT_ID = '0199a000-0000-7000-8000-0000000000e1';
const DEPOSIT_PATH = `/api/deposits/${DEPOSIT_ID}`;
const TRON_ADDRESS = 'TD5gsCwxykWsLN9aPrq2TAfNjByuZKYp4E';
const BSC_ADDRESS = '0xabababababababababababababababababababab';
const TXID = 'ab'.repeat(32);

const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

const fill = (text: string, values: Record<string, string>) =>
  Object.entries(values).reduce((result, [key, value]) => result.replace(`{${key}}`, value), text);

const LIMITS = {
  established: false,
  minUnits: 5 * USD,
  perDepositUnits: 50 * USD,
  dailyUnits: 100 * USD,
  remainingTodayUnits: 100 * USD,
};

const SHAM_CASH_OPTIONS = {
  state: 'available',
  currencies: { SYP: { available: true, reason: null }, USD: { available: true, reason: null } },
  account: { name: 'متجر تجريبي', number: '0990000000' },
  limits: { ...LIMITS, minUnits: 2 * USD },
  rate: { id: '0199a000-0000-7000-8000-0000000000f1', sypPerUsd: '118', displayStepSypUnits: 500 },
  reviewHours: { start: '10:00', end: '22:00' },
  eta: { state: 'open', minutes: 15 },
  pendingDepositId: null,
};

const USDT_OPTIONS = {
  networks: [
    {
      method: 'usdt_trc20',
      state: 'available',
      available: true,
      unavailableReason: null,
      address: TRON_ADDRESS,
      confirmations: 19,
    },
    {
      method: 'usdt_bep20',
      state: 'unavailable',
      available: false,
      unavailableReason: 'delayed',
      address: null,
      confirmations: 15,
    },
  ],
  limits: LIMITS,
  pendingDepositId: null,
};

const USDT = {
  method: 'usdt_trc20',
  address: TRON_ADDRESS,
  payAmount: '25.0037',
  payAmountUnits: 25_003_700,
  checkStatus: 'awaiting_transfer',
  checkError: null,
  txid: null,
  explorerUrl: null,
  confirmations: null,
  requiredConfirmations: 19,
  delayed: false,
  receivedAmountUnits: null,
  reviewReasons: [],
};

/** A $25 USDT deposit on TRON, waiting for its transfer. */
function deposit(changes: Record<string, unknown> = {}, usdt: Record<string, unknown> = {}) {
  return {
    id: DEPOSIT_ID,
    method: 'usdt_trc20',
    status: 'pending',
    referenceCode: 'VD-9TR4X',
    currency: 'USD',
    declaredAmountUnits: 25 * USD,
    declaredUsdUnits: 25 * USD,
    quote: null,
    expiresAt: minutesFromNow(24 * 60),
    createdAt: '2026-10-08T09:00:00.000Z',
    submittedAt: null,
    decidedAt: null,
    rateFixed: false,
    receiptRequest: null,
    payTo: null,
    eta: null,
    credited: null,
    rejection: null,
    ...changes,
    usdt: { ...USDT, ...usdt },
  };
}

const found = {
  txid: TXID,
  explorerUrl: `https://tronscan.org/#/transaction/${TXID}`,
};

const SEARCHING = deposit(
  { status: 'submitted', submittedAt: '2026-10-08T09:05:00.000Z' },
  { checkStatus: 'searching', ...found },
);

const CONFIRMING = deposit(
  { status: 'submitted', submittedAt: '2026-10-08T09:05:00.000Z' },
  { checkStatus: 'confirming', confirmations: 7, ...found },
);

const REVIEW = deposit(
  {
    status: 'submitted',
    submittedAt: '2026-10-08T09:05:00.000Z',
    eta: { state: 'open', minutes: 15 },
  },
  {
    checkStatus: 'review',
    receivedAmountUnits: 24_003_700,
    reviewReasons: ['amount_mismatch'],
    ...found,
  },
);

const CREDITED = deposit(
  {
    status: 'credited',
    submittedAt: '2026-10-08T09:05:00.000Z',
    decidedAt: '2026-10-08T09:06:00.000Z',
    credited: {
      usdUnits: 25 * USD,
      receivedCurrency: 'USD',
      receivedAmountUnits: 25_003_700,
      rate: null,
    },
  },
  { checkStatus: 'done', ...found },
);

const BOUNCED = deposit({}, { checkError: 'tx_failed' });

function signedIn(api: MockApi): MockApi {
  return api.on('GET /api/auth/get-session', 200, {
    user: { name: 'سارة الأحمد', email: 'sara@example.com' },
    session: { token: 'this-device' },
  });
}

function options(api: MockApi): MockApi {
  return signedIn(api)
    .on('GET /api/deposits/sham-cash/options', 200, SHAM_CASH_OPTIONS)
    .on('GET /api/deposits/usdt/options', 200, USDT_OPTIONS);
}

test.describe('USDT deposits', () => {
  test('the picker, the form, a busy amount, then the exact amount to send', async ({
    page,
    api,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    options(api);
    await page.goto('/wallet/deposit');
    const picker = page.getByRole('group', { name: ar.deposits.form.method });
    await expect(picker.getByRole('button', { name: /USDT \(BEP20\)/ })).toBeDisabled();
    await expect(picker).toContainText(ar.deposits.form.methodUnavailable.delayed);
    await picker.getByRole('button', { name: ar.deposits.methods.usdt_trc20 }).click();
    await expect(page.getByText(ar.deposits.usdt.networkNote.usdt_trc20)).toBeVisible();
    await expect(page.getByText(ar.deposits.usdt.fees)).toBeVisible();
    // The $100 preset is above this account's $50 per deposit.
    await expect(page.getByRole('button', { name: '$100.00' })).toHaveCount(0);
    await page.getByRole('button', { name: '$25.00' }).click();
    await expect(page.getByLabel(ar.deposits.form.amountUsd)).toHaveValue('25');

    // Every tail of $25 is taken (rule U3): one cent up or down.
    api.on('POST /api/deposits/usdt', 409, { code: 'DEPOSIT_AMOUNT_BUSY' });
    await page.getByRole('button', { name: ar.deposits.form.submit }).click();
    await expect(page.getByText(ar.errors.DEPOSIT_AMOUNT_BUSY)).toBeVisible();
    const busyKey = api.last('POST /api/deposits/usdt')?.headers['idempotency-key'];
    await page.getByRole('button', { name: '$25.01' }).click();
    await expect(page.getByLabel(ar.deposits.form.amountUsd)).toHaveValue('25.01');

    signedIn(api)
      .on('POST /api/deposits/usdt', 201, deposit())
      .on(`GET ${DEPOSIT_PATH}`, 200, deposit());
    await page.getByRole('button', { name: ar.deposits.form.submit }).click();
    await expect(page).toHaveURL(`/wallet/deposits/${DEPOSIT_ID}`);
    const created = api.last('POST /api/deposits/usdt');
    expect(created?.body).toEqual({ method: 'usdt_trc20', amountUnits: 25_010_000 });
    expect(created?.headers['idempotency-key']).not.toBe(busyKey);
    expect(created?.headers['x-altcha']).toBeTruthy();

    // The exact amount with its tail, the network, the QR and the address in groups.
    await expect(page.getByText(ar.deposits.usdt.sendExactly)).toBeVisible();
    await expect(page.locator('mark')).toHaveText('37');
    await expect(page.getByText(ar.deposits.usdt.networks.usdt_trc20)).toBeVisible();
    await expect(page.getByRole('img', { name: ar.deposits.usdt.qrLabel })).toBeVisible();
    await expect(page.getByTestId('usdt-address')).toHaveText(/TD5g\s*sCwx/);
    await expect(page.getByText(ar.deposits.usdt.copyFromHere)).toBeVisible();
    await expect(page.getByText(ar.deposits.usdt.feeWarning)).toBeVisible();
    await page.getByRole('button', { name: ar.deposits.usdt.copyAmount }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('25.0037');
    await page.getByRole('button', { name: ar.deposits.usdt.copyAddress }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(TRON_ADDRESS);
  });

  test('a TXID: checked first, then searching on the network', async ({ page, api }) => {
    signedIn(api).on(`GET ${DEPOSIT_PATH}`, 200, deposit());
    await page.goto(`/wallet/deposits/${DEPOSIT_ID}`);
    const field = page.getByLabel(ar.deposits.usdt.txidLabel);
    await field.fill('not a transaction');
    await page.getByRole('button', { name: ar.deposits.usdt.txidSubmit }).click();
    await expect(page.getByText(ar.errors.TXID_INVALID)).toBeVisible();
    expect(api.last(`POST ${DEPOSIT_PATH}/txid`)).toBeUndefined();

    api.on(`POST ${DEPOSIT_PATH}/txid`, 200, SEARCHING);
    await field.fill(`https://tronscan.org/#/transaction/${TXID.toUpperCase()}`);
    await page.getByRole('button', { name: ar.deposits.usdt.txidSubmit }).click();
    await expect(
      page.getByRole('heading', { name: ar.deposits.usdt.searchingTitle }),
    ).toBeVisible();
    expect(api.last(`POST ${DEPOSIT_PATH}/txid`)?.body).toEqual({
      txid: `https://tronscan.org/#/transaction/${TXID.toUpperCase()}`,
    });
    await expect(page.getByRole('link', { name: ar.deposits.usdt.explorer })).toHaveAttribute(
      'href',
      found.explorerUrl,
    );
  });

  test('every check status says what is happening', async ({ page, api }) => {
    signedIn(api).on(`GET ${DEPOSIT_PATH}`, 200, BOUNCED);
    await page.goto(`/wallet/deposits/${DEPOSIT_ID}`);
    await expect(page.getByText(ar.deposits.usdt.checkErrors.tx_failed)).toBeVisible();

    api.on(`GET ${DEPOSIT_PATH}`, 200, CONFIRMING);
    await page.reload();
    await expect(
      page.getByRole('heading', { name: ar.deposits.usdt.confirmingTitle }),
    ).toBeVisible();
    await expect(
      page.getByRole('progressbar', { name: ar.deposits.usdt.confirmationsLabel }),
    ).toBeVisible();
    await expect(
      page.getByText(fill(ar.deposits.usdt.confirmations, { count: '7', required: '19' })),
    ).toBeVisible();

    api.on(`GET ${DEPOSIT_PATH}`, 200, REVIEW);
    await page.reload();
    await expect(
      page.getByText(
        fill(ar.deposits.usdt.review.amount_mismatch, { received: '24.0037', asked: '25.0037' }),
      ),
    ).toBeVisible();
    await expect(page.getByText(fill(ar.deposits.eta.open, { minutes: '15' }))).toBeVisible();

    api.on(`GET ${DEPOSIT_PATH}`, 200, CREDITED);
    await page.reload();
    await expect(
      page.getByRole('heading', { name: ar.deposits.detail.creditedTitle }),
    ).toBeVisible();
    await expect(page.getByText('$25.00')).toBeVisible();
    await expect(page.getByRole('link', { name: ar.deposits.usdt.explorer })).toBeVisible();

    api.on(`GET ${DEPOSIT_PATH}`, 200, deposit({ status: 'expired' }, { checkStatus: 'done' }));
    await page.reload();
    await expect(page.getByText(ar.deposits.usdt.lateTransfer)).toBeVisible();
  });

  test('the list names the method', async ({ page, api }) => {
    signedIn(api).on('GET /api/deposits', 200, { items: [CREDITED, SEARCHING], nextCursor: null });
    await page.goto('/wallet/deposits');
    const rows = page.locator('main').getByRole('listitem');
    await expect(rows.first()).toContainText(ar.deposits.methods.usdt_trc20);
    await expect(rows.nth(1)).toContainText(ar.deposits.usdt.statuses.checking);
  });
});

// RTL screenshots, dark and light, at phone width and desktop.
for (const theme of ['dark', 'light'] as const) {
  test(`USDT deposit screenshots, ${theme} theme`, async ({ page, api }, testInfo) => {
    if (theme === 'light') {
      await page.addInitScript(() => localStorage.setItem('vertex-theme', 'light'));
    }
    options(api);
    await page.goto('/wallet/deposit');
    await page.getByRole('button', { name: ar.deposits.methods.usdt_trc20 }).click();
    await page.getByLabel(ar.deposits.form.amountUsd).fill('25');
    await screenshot(page, testInfo, `usdt-form-${theme}`);

    api.on(`GET ${DEPOSIT_PATH}`, 200, deposit());
    await page.goto(`/wallet/deposits/${DEPOSIT_ID}`);
    await expect(page.getByText(ar.deposits.usdt.sendExactly)).toBeVisible();
    await screenshot(page, testInfo, `usdt-awaiting-${theme}`);

    for (const [name, state, text] of [
      ['bounced', BOUNCED, ar.deposits.usdt.checkErrors.tx_failed],
      ['searching', SEARCHING, ar.deposits.usdt.searchingTitle],
      ['confirming', CONFIRMING, ar.deposits.usdt.confirmingTitle],
      ['review', REVIEW, ar.deposits.usdt.reviewTitle],
      ['credited', CREDITED, ar.deposits.detail.creditedTitle],
    ] as const) {
      api.on(`GET ${DEPOSIT_PATH}`, 200, state);
      await page.reload();
      await expect(page.getByText(text).first()).toBeVisible();
      await screenshot(page, testInfo, `usdt-${name}-${theme}`);
    }

    api.on('GET /api/deposits/usdt/options', 200, {
      ...USDT_OPTIONS,
      networks: [
        {
          ...USDT_OPTIONS.networks[0],
          state: 'unavailable',
          available: false,
          unavailableReason: 'disabled',
        },
        { ...USDT_OPTIONS.networks[1], address: BSC_ADDRESS },
      ],
    });
    await page.goto('/wallet/deposit');
    await expect(page.getByText(ar.deposits.form.methodUnavailable.unavailable)).toBeVisible();
    await screenshot(page, testInfo, `usdt-picker-unavailable-${theme}`);
  });
}
