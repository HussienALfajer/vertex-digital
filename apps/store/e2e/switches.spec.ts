import ar from '../src/messages/ar.json' with { type: 'json' };
import { expect, type MockApi, screenshot, test } from './test';

/*
 * The store switches (S05 F26): the stop banner under the header (rule SW9) and the deposit
 * wizard with paused and stopped methods (rules SW4, SW6), against the mocked API.
 */

const USD = 1_000_000;

const status = (changes: { purchasesStopped?: boolean; depositsStopped?: boolean }) => ({
  registrationOpen: true,
  purchasesStopped: false,
  depositsStopped: false,
  ...changes,
});

const SHAM_CASH = {
  state: 'available',
  currencies: { SYP: { available: true, reason: null }, USD: { available: true, reason: null } },
  account: { name: 'متجر تجريبي', number: '0990000000' },
  limits: {
    established: false,
    minUnits: 2 * USD,
    perDepositUnits: 50 * USD,
    dailyUnits: 100 * USD,
    remainingTodayUnits: 100 * USD,
  },
  rate: { id: '0199a000-0000-7000-8000-0000000000f1', sypPerUsd: '118', displayStepSypUnits: 500 },
  reviewHours: { start: '10:00', end: '22:00' },
  eta: { state: 'open', minutes: 15 },
  pendingDepositId: null,
};

const network = (method: 'usdt_trc20' | 'usdt_bep20', state: string) => ({
  method,
  state,
  available: state !== 'unavailable',
  unavailableReason: state === 'unavailable' ? 'not_configured' : null,
  address: state === 'available' ? 'TQ4Gu8n2aZ8tEjc7VJpi5LKZ2aSBEMXxG6' : null,
  confirmations: method === 'usdt_trc20' ? 19 : 15,
});

const usdt = (trc20: string, bep20: string) => ({
  networks: [network('usdt_trc20', trc20), network('usdt_bep20', bep20)],
  limits: null,
  pendingDepositId: null,
});

/** A signed-in customer on the deposit wizard. */
function signedIn(api: MockApi): MockApi {
  return api.on('GET /api/auth/get-session', 200, {
    user: { name: 'سارة الأحمد', email: 'sara@example.com' },
    session: { token: 'this-device' },
  });
}

test.describe('the stop banner (rule SW9)', () => {
  test('names what is stopped, and is absent while nothing is', async ({ page, api }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.getByRole('status')).toHaveCount(0);

    for (const [changes, text] of [
      [{ depositsStopped: true }, ar.stopBanner.deposits],
      [{ purchasesStopped: true }, ar.stopBanner.purchases],
      [{ purchasesStopped: true, depositsStopped: true }, ar.stopBanner.both],
    ] as const) {
      api.on('GET /api/store/status', 200, status(changes));
      await page.goto('/sign-in');
      await expect(page.getByRole('status')).toHaveText(text);
    }
  });
});

test.describe('the deposit wizard while stopped (rules SW4, SW6)', () => {
  test('shows a paused method disabled and keeps the others', async ({ page, api }) => {
    signedIn(api)
      .on('GET /api/deposits/sham-cash/options', 200, { ...SHAM_CASH, state: 'paused' })
      .on('GET /api/deposits/usdt/options', 200, usdt('available', 'unavailable'));
    await page.goto('/wallet/deposit');
    const shamCash = page.getByRole('button', { name: new RegExp(ar.deposits.methods.sham_cash) });
    await expect(shamCash).toBeDisabled();
    await expect(shamCash).toContainText(ar.deposits.form.methodUnavailable.stopped);
    await expect(
      page.getByRole('button', { name: ar.deposits.methods.usdt_trc20, exact: true }),
    ).toBeEnabled();
  });

  test('shows the stop text when every method is stopped', async ({ page, api }) => {
    signedIn(api)
      .on('GET /api/store/status', 200, status({ depositsStopped: true }))
      .on('GET /api/deposits/sham-cash/options', 200, { ...SHAM_CASH, state: 'stopped' })
      .on('GET /api/deposits/usdt/options', 200, usdt('stopped', 'stopped'));
    await page.goto('/wallet/deposit');
    await expect(page.getByText(ar.deposits.form.stoppedTitle, { exact: true })).toBeVisible();
    await expect(page.getByText(ar.deposits.form.stoppedBody)).toBeVisible();
    await expect(page.getByRole('status')).toHaveText(ar.stopBanner.deposits);
  });

  test('keeps the amount when a stop wins the race (edge case 8)', async ({ page, api }) => {
    signedIn(api)
      .on('GET /api/deposits/sham-cash/options', 200, SHAM_CASH)
      .on('GET /api/deposits/usdt/options', 200, usdt('unavailable', 'unavailable'))
      .on('POST /api/deposits/sham-cash', 409, {
        statusCode: 409,
        code: 'DEPOSITS_STOPPED',
        message: 'New deposits are stopped',
        details: { reason: 'emergency' },
      });
    await page.goto('/wallet/deposit');
    await page.getByLabel(ar.deposits.form.amountSyp).fill('2000');
    await page.getByRole('button', { name: ar.deposits.form.submit }).click();
    await expect(page.getByText(ar.errors.DEPOSITS_STOPPED)).toBeVisible();
    await expect(page.getByLabel(ar.deposits.form.amountSyp)).toHaveValue('2000');
  });
});

// RTL screenshots, dark and light, at phone width and desktop.
for (const theme of ['dark', 'light'] as const) {
  test(`switch screenshots, ${theme} theme`, async ({ page, api }, testInfo) => {
    if (theme === 'light') {
      await page.addInitScript(() => localStorage.setItem('vertex-theme', 'light'));
    }
    signedIn(api)
      .on('GET /api/store/status', 200, status({ depositsStopped: true }))
      .on('GET /api/deposits/sham-cash/options', 200, { ...SHAM_CASH, state: 'stopped' })
      .on('GET /api/deposits/usdt/options', 200, usdt('stopped', 'stopped'));
    await page.goto('/');
    await expect(page.getByRole('status')).toBeVisible();
    await screenshot(page, testInfo, `stop-banner-${theme}`);

    await page.goto('/wallet/deposit');
    await expect(page.getByText(ar.deposits.form.stoppedTitle, { exact: true })).toBeVisible();
    await screenshot(page, testInfo, `deposit-stopped-${theme}`);

    api
      .on('GET /api/store/status', 200, status({}))
      .on('GET /api/deposits/sham-cash/options', 200, SHAM_CASH)
      .on('GET /api/deposits/usdt/options', 200, usdt('paused', 'available'));
    await page.goto('/wallet/deposit');
    await expect(page.getByText(ar.deposits.form.methodUnavailable.stopped)).toBeVisible();
    await screenshot(page, testInfo, `deposit-method-paused-${theme}`);
  });
}
