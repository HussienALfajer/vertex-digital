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
    .on('GET /api/wallet', 200, { balanceUnits: 25 * USD, syp: null, reservedUsdUnits: 0 })
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
    api.on('GET /api/wallet', 200, { balanceUnits: 40 * USD, syp: null, reservedUsdUnits: 0 });
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
    // Counted, not the last request: the header's balance chip may read `/api/wallet` meanwhile.
    const pages = () =>
      api.requests.filter((request) => request.key === 'GET /api/wallet/entries').length;
    const before = pages();
    await page.getByRole('button', { name: ar.wallet.loadMore }).click();
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(2)).toContainText(ar.wallet.categories.test_funds);
    expect(pages()).toBe(before + 1);
    await expect(page.getByRole('button', { name: ar.wallet.loadMore })).toHaveCount(0);
  });

  test('a credit arrives live: the new entry on top, the pages loaded kept (A02-4)', async ({
    page,
    api,
  }) => {
    withEntries(api).stream(
      'GET /api/notifications/stream',
      [
        { event: 'unread', data: { unreadCount: 0 } },
        {
          event: 'notification',
          data: {
            notification: {
              id: '0199a000-0000-7000-8000-0000000000c2',
              event: 'wallet_adjusted',
              params: {
                direction: 'credit',
                amountUnits: 10 * USD,
                category: 'compensation',
                reversal: false,
              },
              readAt: null,
              createdAt: new Date().toISOString(),
            },
            unreadCount: 1,
          },
        },
      ],
      2500,
    );
    await page.goto('/wallet');
    const rows = page.locator('main').getByRole('listitem');
    await expect(rows).toHaveCount(2);
    api.on('GET /api/wallet/entries', 200, { items: [FIRST_ENTRY], nextCursor: null });
    await page.getByRole('button', { name: ar.wallet.loadMore }).click();
    await expect(rows).toHaveCount(3);
    const credit = {
      ...FIRST_ENTRY,
      occurredAt: '2026-10-09T08:00:00.000Z',
      amountUnits: 10 * USD,
      balanceAfterUnits: 35 * USD,
      adjustment: { category: 'compensation', customerNote: null, reversal: false },
    };
    api
      .on('GET /api/wallet', 200, { balanceUnits: 35 * USD, syp: null, reservedUsdUnits: 0 })
      .on('GET /api/wallet/entries', 200, { items: [credit, ...ENTRIES], nextCursor: 'page-2' });
    await expect(rows).toHaveCount(4);
    await expect(rows.first()).toContainText('+$10.00');
    // The page loaded with "load more" is still there, and nothing more to load.
    await expect(rows.nth(3)).toContainText(ar.wallet.categories.test_funds);
    await expect(page.getByRole('button', { name: ar.wallet.loadMore })).toHaveCount(0);
  });

  test('a refresh that fails keeps the wallet on screen (A02-6)', async ({ page, api }) => {
    // The bell reads its list again when the tab is shown, too.
    withEntries(api).on('GET /api/notifications', 200, {
      items: [],
      nextCursor: null,
      unreadCount: 0,
    });
    await page.goto('/wallet');
    const rows = page.locator('main').getByRole('listitem');
    await expect(rows).toHaveCount(2);
    api.on('GET /api/wallet/entries', 500, {});
    const reads = () =>
      api.requests.filter((request) => request.key === 'GET /api/wallet/entries').length;
    const before = reads();
    // The tab shown again reads the wallet (S09 rule LT2).
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(reads).toBeGreaterThan(before);
    await expect(page.getByText(ar.wallet.loadFailed)).toBeHidden();
    await expect(rows).toHaveCount(2);
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
