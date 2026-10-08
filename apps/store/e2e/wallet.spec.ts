import ar from '../src/messages/ar.json' with { type: 'json' };
import { expect, type MockApi, screenshot, test } from './test';

/*
 * The customer's wallet (S02): the header balance chip and the wallet page, against the mocked
 * API. Amounts are in micro-dollars (ADR 0003).
 */

const USD = 1_000_000;

/** A signed-in customer. */
function signedIn(api: MockApi): MockApi {
  return api.on('GET /api/auth/get-session', 200, {
    user: { name: 'سارة الأحمد', email: 'sara@example.com' },
    session: { token: 'this-device' },
  });
}

/** Newest first: a reversal, the compensation it reverses, and the first test credit. */
const ENTRIES = [
  {
    occurredAt: '2026-10-08T10:00:00.000Z',
    kind: 'adjustment',
    amountUnits: -250 * USD,
    balanceAfterUnits: 25 * USD,
    adjustment: { category: 'compensation', customerNote: null, reversal: true },
    deposit: null,
  },
  {
    occurredAt: '2026-10-08T09:30:00.000Z',
    kind: 'adjustment',
    amountUnits: 250 * USD,
    balanceAfterUnits: 275 * USD,
    adjustment: {
      category: 'compensation',
      customerNote: 'تعويض عن تأخير الطلب',
      reversal: false,
    },
    deposit: null,
  },
];

const FIRST_ENTRY = {
  occurredAt: '2026-10-08T09:00:00.000Z',
  kind: 'adjustment',
  amountUnits: 25 * USD,
  balanceAfterUnits: 25 * USD,
  adjustment: { category: 'test_funds', customerNote: 'رصيد للتجربة', reversal: false },
  deposit: null,
};

function withEntries(api: MockApi): MockApi {
  return signedIn(api)
    .on('GET /api/wallet', 200, { balanceUnits: 25 * USD, syp: null })
    .on('GET /api/wallet/entries', 200, { items: ENTRIES, nextCursor: 'page-2' });
}

test.describe('wallet', () => {
  test('the header shows the balance, opens the wallet and reads it again', async ({
    page,
    api,
  }) => {
    withEntries(api);
    await page.goto('/');
    const chip = page.getByRole('link', { name: ar.header.balance.replace('{balance}', '$25.00') });
    await expect(chip).toBeVisible();
    // The header stays mounted across client navigations: the chip reads the balance again.
    api.on('GET /api/wallet', 200, { balanceUnits: 40 * USD, syp: null });
    await chip.click();
    await expect(page).toHaveURL('/wallet');
    await expect(page.getByRole('heading', { level: 1, name: ar.wallet.title })).toBeVisible();
    await expect(
      page.getByRole('link', { name: ar.header.balance.replace('{balance}', '$40.00') }),
    ).toBeVisible();
  });

  test('a failed balance read hides the chip; the page still works', async ({ page, api }) => {
    signedIn(api).on('GET /api/wallet', 500, {});
    await page.goto('/');
    await expect(page.getByRole('button', { name: ar.header.menu })).toBeVisible();
    await expect(page.getByRole('link', { name: /\$/ })).toHaveCount(0);
  });

  test('shows each entry with its label, note, sign and running balance, then loads more', async ({
    page,
    api,
  }) => {
    withEntries(api);
    await page.goto('/wallet');
    const rows = page.locator('main').getByRole('listitem');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText(
      ar.wallet.reversal.replace('{category}', ar.wallet.categories.compensation),
    );
    await expect(rows.nth(0)).toContainText('−$250.00');
    await expect(rows.nth(1)).toContainText(ar.wallet.categories.compensation);
    await expect(rows.nth(1)).toContainText('تعويض عن تأخير الطلب');
    await expect(rows.nth(1)).toContainText('+$250.00');
    await expect(rows.nth(1)).toContainText(`${ar.wallet.balanceAfter} $275.00`);

    api.on('GET /api/wallet/entries', 200, { items: [FIRST_ENTRY], nextCursor: null });
    await page.getByRole('button', { name: ar.wallet.loadMore }).click();
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(2)).toContainText(ar.wallet.categories.test_funds);
    expect(api.requests.at(-1)?.key).toBe('GET /api/wallet/entries');
    await expect(page.getByRole('button', { name: ar.wallet.loadMore })).toHaveCount(0);
  });

  test('a new wallet says there is nothing yet', async ({ page, api }) => {
    signedIn(api).on('GET /api/wallet/entries', 200, { items: [], nextCursor: null });
    await page.goto('/wallet');
    await expect(page.getByText(ar.wallet.emptyTitle)).toBeVisible();
    await expect(page.locator('main').getByText('$0.00')).toBeVisible();
  });

  test('a failed read offers a retry', async ({ page, api }) => {
    signedIn(api).on('GET /api/wallet/entries', 500, {});
    await page.goto('/wallet');
    await expect(page.getByText(ar.wallet.loadFailed)).toBeVisible();
    api.on('GET /api/wallet/entries', 200, { items: [], nextCursor: null });
    await page.getByRole('button', { name: ar.wallet.retry }).click();
    await expect(page.getByText(ar.wallet.emptyTitle)).toBeVisible();
  });

  test('without a session, the wallet sends to sign-in and back', async ({ page, api }) => {
    api.on('GET /api/wallet', 401, { code: 'UNAUTHORIZED' });
    api.on('GET /api/wallet/entries', 401, { code: 'UNAUTHORIZED' });
    await page.goto('/wallet');
    await expect(page).toHaveURL('/sign-in?next=%2Fwallet');
  });
});

// RTL screenshots of the wallet, dark and light, at phone width and desktop.
for (const theme of ['dark', 'light'] as const) {
  test(`wallet screenshots, ${theme} theme`, async ({ page, api }, testInfo) => {
    if (theme === 'light') {
      await page.addInitScript(() => localStorage.setItem('vertex-theme', 'light'));
    }
    signedIn(api).on('GET /api/wallet/entries', 200, { items: [], nextCursor: null });
    await page.goto('/wallet');
    await expect(page.getByText(ar.wallet.emptyTitle)).toBeVisible();
    await screenshot(page, testInfo, `wallet-empty-${theme}`);

    withEntries(api).on('GET /api/wallet/entries', 200, {
      items: [...ENTRIES, FIRST_ENTRY],
      nextCursor: 'page-2',
    });
    await page.reload();
    await expect(page.locator('main').getByRole('listitem')).toHaveCount(3);
    await screenshot(page, testInfo, `wallet-${theme}`);
  });
}
