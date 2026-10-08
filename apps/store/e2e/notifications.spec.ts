import ar from '../src/messages/ar.json' with { type: 'json' };
import { expect, type MockApi, screenshot, test } from './test';

/*
 * The customer notification center (S05 F27): the header bell, `/notifications` and the email
 * choices on `/account`, against the mocked API. Amounts are in micro-dollars (ADR 0003).
 */

const USD = 1_000_000;
const DEPOSIT = '01920000-0000-7000-8000-000000000001';

function signedIn(api: MockApi): MockApi {
  return api.on('GET /api/auth/get-session', 200, {
    user: { name: 'سارة الأحمد', email: 'sara@example.com' },
    session: { token: 'this-device' },
  });
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/** Newest first: two unread, two read. */
const ITEMS = [
  {
    id: 'n4',
    event: 'deposit_credited',
    params: { depositId: DEPOSIT, referenceCode: 'VD-7KQ2M', creditedUsdUnits: 20 * USD },
    readAt: null,
    createdAt: minutesAgo(2),
  },
  {
    id: 'n3',
    event: 'deposit_receipt_requested',
    params: { depositId: DEPOSIT, referenceCode: 'VD-7KQ2M' },
    readAt: null,
    createdAt: minutesAgo(50),
  },
  {
    id: 'n2',
    event: 'deposit_rejected',
    params: { depositId: DEPOSIT, referenceCode: 'VD-3HT8P', reason: 'not_received' },
    readAt: minutesAgo(60),
    createdAt: minutesAgo(26 * 60),
  },
  {
    id: 'n1',
    event: 'wallet_adjusted',
    params: {
      direction: 'credit',
      amountUnits: 5 * USD,
      category: 'compensation',
      reversal: false,
    },
    readAt: minutesAgo(60),
    createdAt: minutesAgo(3 * 24 * 60),
  },
];

const withNotifications = (api: MockApi) =>
  signedIn(api)
    .on('GET /api/notifications', 200, { items: ITEMS, nextCursor: null, unreadCount: 2 })
    .on('POST /api/notifications/read', 200, { unreadCount: 0 });

const unread = (count: string) => ar.header.notificationsUnread.replace('{count}', count);

test.describe('notifications', () => {
  test('the bell shows the live unread count and opens the list', async ({ page, api }) => {
    withNotifications(api).stream('GET /api/notifications/stream', [
      { event: 'unread', data: { unreadCount: 9 } },
      { event: 'notification', data: { notification: ITEMS[0], unreadCount: 12 } },
    ]);
    await page.goto('/');
    const bell = page.getByRole('link', { name: unread('9+') });
    await expect(bell).toBeVisible();
    await bell.click();
    await expect(page).toHaveURL('/notifications');
    await expect(
      page.getByRole('heading', { level: 1, name: ar.notifications.title }),
    ).toBeVisible();
    // Opening the page marks what it shows as read, up to the newest (rule NT5).
    await expect
      .poll(() => api.last('POST /api/notifications/read')?.body)
      .toEqual({ upToId: 'n4' });
    await expect(
      page.getByRole('link', { name: ar.header.notifications, exact: true }),
    ).toBeVisible();
  });

  test('the list says what happened, links to it and loads more', async ({ page, api }) => {
    withNotifications(api).on('GET /api/notifications', 200, {
      items: ITEMS.slice(0, 2),
      nextCursor: 'page-2',
      unreadCount: 2,
    });
    await page.goto('/notifications');
    await expect(page.getByText(/أُضيف .*\$20\.00.* إلى رصيدك/)).toBeVisible();
    await expect(page.getByRole('link', { name: /نحتاج إيصالًا أوضح/ })).toHaveAttribute(
      'href',
      `/wallet/deposits/${DEPOSIT}`,
    );
    api.on('GET /api/notifications', 200, {
      items: ITEMS.slice(2),
      nextCursor: null,
      unreadCount: 0,
    });
    await page.getByRole('button', { name: ar.notifications.loadMore }).click();
    await expect(page.getByText(/لم يصل التحويل إلى حسابنا/)).toBeVisible();
    await expect(page.getByRole('link', { name: /أضافت الإدارة/ })).toHaveAttribute(
      'href',
      '/wallet',
    );
    await expect(page.getByRole('button', { name: ar.notifications.loadMore })).toHaveCount(0);
  });

  test('a failed read offers a retry', async ({ page, api }) => {
    signedIn(api).on('GET /api/notifications', 500, {});
    await page.goto('/notifications');
    await expect(page.getByText(ar.notifications.loadFailed)).toBeVisible();
    withNotifications(api);
    await page.getByRole('button', { name: ar.notifications.retry }).click();
    await expect(page.getByText(/أُضيف .*\$20\.00/)).toBeVisible();
  });

  test('without a session the page sends to sign-in', async ({ page, api }) => {
    api.on('GET /api/notifications', 401, { code: 'UNAUTHORIZED' });
    await page.goto('/notifications');
    await expect(page).toHaveURL('/sign-in?next=%2Fnotifications');
  });

  test('the account page saves an email choice on toggle (rule NT8)', async ({ page, api }) => {
    signedIn(api)
      .on('GET /api/account', 200, {
        id: '0199a000-0000-7000-8000-000000000010',
        name: 'سارة الأحمد',
        email: 'sara@example.com',
        phone: '+963944123456',
        createdAt: '2026-10-01T09:00:00.000Z',
      })
      .on('GET /api/auth/list-sessions', 200, [])
      .on('PUT /api/account/notification-preferences', 200, {
        email: {
          deposit_credited: true,
          deposit_rejected: false,
          deposit_receipt_requested: true,
          wallet_adjusted: true,
        },
      });
    await page.goto('/account');
    const rejected = page.getByRole('switch', {
      name: ar.account.notifications.events.deposit_rejected,
    });
    await expect(rejected).toBeChecked();
    await rejected.click();
    await expect(page.getByText(ar.account.notifications.saved)).toBeVisible();
    await expect(rejected).not.toBeChecked();
    expect(api.last('PUT /api/account/notification-preferences')?.body).toEqual({
      event: 'deposit_rejected',
      email: false,
    });
    await expect(page.getByText(ar.account.notifications.security)).toBeVisible();
  });
});

// RTL screenshots, dark and light, at phone width and desktop.
for (const theme of ['dark', 'light'] as const) {
  test(`notification screenshots (${theme})`, async ({ page, api }, testInfo) => {
    if (theme === 'light') {
      await page.addInitScript(() => localStorage.setItem('vertex-theme', 'light'));
    }
    withNotifications(api).stream('GET /api/notifications/stream', [
      { event: 'unread', data: { unreadCount: 2 } },
    ]);
    await page.goto('/');
    await expect(page.getByRole('link', { name: unread('2') })).toBeVisible();
    await screenshot(page, testInfo, `notification-bell-${theme}`);

    await page.goto('/notifications');
    await expect(page.getByText(/أُضيف .*\$20\.00/)).toBeVisible();
    await screenshot(page, testInfo, `notifications-${theme}`);

    api.on('GET /api/notifications', 200, { items: [], nextCursor: null, unreadCount: 0 });
    await page.goto('/notifications');
    await expect(page.getByText(ar.notifications.empty)).toBeVisible();
    await screenshot(page, testInfo, `notifications-empty-${theme}`);
  });
}
