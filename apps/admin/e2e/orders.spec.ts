import type { Page } from '@playwright/test';
import type { AdminOrder } from '@vertex-digital/contracts';
import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import { ORDER_IDS } from './orders-mock';
import { type AdminApi, expect, PASSWORD, screenshot, TOTP_CODE, test } from './test';

/*
 * Orders (S08): the list with its tabs and the badge, a held order's decisions with
 * re-authentication (poll again, refund), a manual order confirmed delivered with its codes, a
 * code revealed and hidden, and the policy, against the mocked API.
 */

const o = ar.orders;

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

/** S09 rule AD3: a reservation waiting for its balance and one cancelled when its price rose. */
function reservations(admin: AdminApi) {
  const base = admin.orders.orders.find((row) => row.id === ORDER_IDS.held) as AdminOrder;
  const reserved = new Date(Date.now() - 2 * 3_600_000).toISOString();
  const expires = new Date(Date.now() + 22 * 3_600_000).toISOString();
  const shared = {
    ...base,
    reservedAt: reserved,
    expiresAt: expires,
    paidAt: null,
    reviewSince: null,
    attempts: [],
    journals: [],
    events: [],
    decisions: { attemptId: null, poll: false, resolve: false, refund: false },
  };
  admin.orders.orders.push(
    {
      ...shared,
      id: RESERVED_ID,
      number: 'VO-WAIT23',
      status: 'awaiting_balance',
      playerCheck: 'valid',
      playerName: 'Lina_99',
    },
    {
      ...shared,
      id: CANCELLED_ID,
      number: 'VO-GONE45',
      status: 'cancelled',
      cancelReason: 'price_rose',
      playerCheck: 'unchecked_confirmed',
      finishedAt: new Date().toISOString(),
    },
  );
}

const RESERVED_ID = '0199b000-0000-7000-8000-0000000000aa';
const CANCELLED_ID = '0199b000-0000-7000-8000-0000000000ab';

test.describe('reservations (S09 rule AD3)', () => {
  test('filters by status and shows the reservation, cancel and player-check fields', async ({
    page,
    admin,
  }) => {
    reservations(admin);
    await open(page, admin, '/orders');
    await expect(rows(page)).toHaveCount(6);
    await page.getByRole('combobox', { name: o.filters.status }).click();
    await page.getByRole('option', { name: o.statuses.awaiting_balance }).click();
    await page.getByRole('button', { name: o.filters.apply }).click();
    await expect(page).toHaveURL(/status=awaiting_balance/);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('VO-WAIT23');
    await expect(rows(page).first()).toContainText(o.statuses.awaiting_balance);

    await page.goto(`/orders/${RESERVED_ID}`);
    await expect(page.getByText(o.detail.reservedAt, { exact: true })).toBeVisible();
    await expect(page.getByText(o.detail.expiresAt)).toBeVisible();
    await expect(page.getByText(fill(o.playerChecks.valid, { name: 'Lina_99' }))).toBeVisible();

    await page.goto(`/orders/${CANCELLED_ID}`);
    await expect(page.getByText(o.cancelReasons.price_rose).first()).toBeVisible();
    await expect(page.getByText(o.playerChecks.unchecked_confirmed)).toBeVisible();
  });
});

test.describe('orders', () => {
  test('lists every order, then the held and manual tabs; the badge counts both', async ({
    page,
    admin,
  }) => {
    await open(page, admin, '/orders');
    await expect(rows(page)).toHaveCount(4);
    const badge = page.getByLabel(fill(ar.nav.ordersBadge, { needsReview: 1, manualWaiting: 1 }));
    await expect(badge.first()).toHaveText('2');

    await page.getByRole('tab', { name: o.tabs.review }).click();
    await expect(page).toHaveURL(/tab=review/);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('VO-HELD23');

    await page.getByRole('tab', { name: o.tabs.manual }).click();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText(o.manualWaiting);
    await expect(rows(page).first()).toContainText(ar.wallets.testBadge);

    await page.getByRole('tab', { name: o.tabs.active }).click();
    await page.getByRole('searchbox').fill('nobody@example.com');
    await page.getByRole('button', { name: o.filters.apply }).click();
    await expect(page.getByText(o.empty.active)).toBeVisible();
  });

  test("filters by one product from the game page's link, then clears it", async ({
    page,
    admin,
  }) => {
    await open(page, admin, '/orders?productId=0199b000-0000-7000-8000-000000000046');
    await expect(page.getByText(o.filters.oneProduct)).toBeVisible();
    await page.getByRole('button', { name: o.filters.clearProduct }).click();
    await expect(page).not.toHaveURL(/productId/);
    await expect(rows(page)).toHaveCount(4);
  });

  test('polls a held order again, then refunds it with re-authentication (rules D4, D5)', async ({
    page,
    admin,
  }) => {
    await open(page, admin, `/orders/${ORDER_IDS.held}`);
    await expect(page.getByText(o.decisions.heldHelp)).toBeVisible();
    await expect(
      page.getByRole('cell', { name: o.skipReasons.supplier_unavailable }),
    ).toBeVisible();

    admin.reauthenticationRequired = true;
    await page.getByRole('button', { name: o.decisions.poll.open }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel(o.decisions.reason).fill('قصير');
    await dialog.getByRole('button', { name: o.decisions.poll.submit }).click();
    await expect(dialog.getByText(o.decisions.reasonError)).toBeVisible();
    await dialog.getByLabel(o.decisions.reason).fill('المورد قال إنه نفّذه');
    await dialog.getByRole('button', { name: o.decisions.poll.submit }).click();
    await reauthenticate(page);
    await expect(page.getByRole('heading', { name: o.decisions.poll.title })).toBeHidden();
    admin.reauthenticationRequired = false;

    await page.getByRole('button', { name: o.decisions.refund.open }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByText(o.decisions.refund.warning)).toBeVisible();
    await dialog.getByLabel(o.decisions.reason).fill('لا جواب من المورد منذ ساعة');
    await dialog.getByRole('button', { name: o.decisions.refund.submit }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(o.statuses.refunded, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(o.decisions.heldHelp)).toBeHidden();
    expect(admin.orders.counts().needsReview).toBe(0);
  });

  test('confirms a manual code order delivered, asking one code per unit (rule D2)', async ({
    page,
    admin,
  }) => {
    await open(page, admin, `/orders/${ORDER_IDS.manual}`);
    await page.getByRole('button', { name: o.decisions.delivered.open }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel(o.decisions.delivered.quantity)).toHaveValue('2');
    await dialog.getByLabel(o.decisions.delivered.codes).fill('CODE-AAAA-1111');
    await dialog.getByLabel(o.decisions.reason).fill('سلّمني المورد الكودين يدوياً');
    await dialog.getByRole('button', { name: o.decisions.delivered.submit }).click();
    await expect(dialog.getByText(o.decisions.delivered.codesError)).toBeVisible();
    await dialog.getByLabel(o.decisions.delivered.codes).fill('CODE-AAAA-1111\nCODE-BBBB-2222');
    await dialog.getByRole('button', { name: o.decisions.delivered.submit }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(o.statuses.delivered, { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: o.codes.title })).toBeVisible();
  });

  test('reveals a code with re-authentication, logs it and hides it again (rule C3)', async ({
    page,
    admin,
  }) => {
    await open(page, admin, `/orders/${ORDER_IDS.delivered}`);
    await expect(page.getByText('•••• 7Q2M')).toBeVisible();
    await expect(page.getByText('203.0.113.7')).toBeVisible();
    admin.reauthenticationRequired = true;
    await page.getByRole('button', { name: o.codes.reveal }).click();
    await reauthenticate(page);
    await expect(page.getByText('ITUNES-7K2M-9Q4X-7Q2M')).toBeVisible();
    await expect(page.getByText(o.codes.revealedBy.admin.split('{{')[0] as string)).toBeVisible();
    await page.getByRole('button', { name: o.codes.hide }).click();
    await expect(page.getByText('ITUNES-7K2M-9Q4X-7Q2M')).toBeHidden();
  });

  test('saves the policy with re-authentication, refusing a value out of bounds', async ({
    page,
    admin,
  }) => {
    await open(page, admin, '/orders/policy');
    const hardLimit = page.getByLabel(o.policy.fields.hardLimitMinutes.label, { exact: true });
    await hardLimit.fill('2');
    await page.getByRole('button', { name: o.policy.save }).click();
    await expect(page.getByText(o.policy.fields.hardLimitMinutes.error)).toBeVisible();
    await hardLimit.fill('5');
    admin.reauthenticationRequired = true;
    await page.getByRole('button', { name: o.policy.save }).click();
    await reauthenticate(page);
    await expect(page.getByText(o.policy.saved)).toBeVisible();
    expect(admin.orders.policy.hardLimitMinutes).toBe(5);
  });
});

const CHECKOUT_ID = '0199b000-0000-7000-8000-0000000000c1';
const GIFT_LINK_ID = '0199b000-0000-7000-8000-0000000000e1';

/**
 * S10 rules AD1, AD2: the delivered order becomes a gift paid in a checkout with the refunded
 * one, with a live gift link and a receipt link the customer revoked.
 */
function checkout(admin: AdminApi) {
  const delivered = admin.orders.orders.find((row) => row.id === ORDER_IDS.delivered) as AdminOrder;
  const refunded = admin.orders.orders.find((row) => row.id === ORDER_IDS.refunded) as AdminOrder;
  const info = {
    id: CHECKOUT_ID,
    totalUsdUnits: delivered.totalUsdUnits + refunded.totalUsdUnits,
    orderCount: 2,
    finishedAt: new Date().toISOString(),
    orders: [
      { id: delivered.id, number: delivered.number, line: 1, status: delivered.status },
      { id: refunded.id, number: refunded.number, line: 2, status: refunded.status },
    ],
  };
  admin.orders.orders = admin.orders.orders.map((row) =>
    row.id === delivered.id
      ? {
          ...row,
          checkout: info,
          gift: { senderName: 'أحمد', message: 'كل عام وأنت بخير' },
          shareLinks: [
            {
              id: GIFT_LINK_ID,
              kind: 'gift',
              showPrice: false,
              playerDisplay: 'masked',
              createdAt: new Date(Date.now() - 3_600_000).toISOString(),
              revokedAt: null,
              revokedBy: null,
              revokeReason: null,
            },
            {
              id: '0199b000-0000-7000-8000-0000000000e2',
              kind: 'receipt',
              showPrice: true,
              playerDisplay: 'full',
              createdAt: new Date(Date.now() - 7_200_000).toISOString(),
              revokedAt: new Date(Date.now() - 3_000_000).toISOString(),
              revokedBy: 'customer',
              revokeReason: null,
            },
          ],
        }
      : row.id === refunded.id
        ? { ...row, checkout: info }
        : row,
  );
}

test.describe('checkouts, gifts and share links (S10 rules AD1, AD2)', () => {
  test('shows the badges, finds a checkout by its id, and revokes a link with a reason', async ({
    page,
    admin,
  }) => {
    checkout(admin);
    await open(page, admin, '/orders');
    await expect(rows(page).filter({ hasText: o.gift.badge })).toHaveCount(1);
    await expect(rows(page).filter({ hasText: o.checkout.badge })).toHaveCount(2);
    await page.getByRole('link', { name: o.checkout.filter }).first().click();
    await expect(page).toHaveURL(new RegExp(`q=${CHECKOUT_ID}`));
    await expect(rows(page)).toHaveCount(2);

    await page.goto(`/orders/${ORDER_IDS.delivered}`);
    await expect(page.getByText(fill(o.checkout.title, { count: 2 }))).toBeVisible();
    await expect(page.getByText('كل عام وأنت بخير')).toBeVisible();
    await expect(page.getByText(o.shareLinks.live)).toBeVisible();
    await expect(
      page.getByText(o.shareLinks.revokedBy.split('{{')[0] as string).first(),
    ).toBeVisible();
    await page.getByRole('button', { name: o.shareLinks.revoke }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(o.decisions.reason).fill('بلاغ');
    await dialog.getByRole('button', { name: o.shareLinks.revoke }).click();
    await expect(dialog.getByText(o.decisions.reasonError)).toBeVisible();
    await dialog.getByLabel(o.decisions.reason).fill('بلاغ عن رسالة احتيال');
    await dialog.getByRole('button', { name: o.shareLinks.revoke }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('بلاغ عن رسالة احتيال')).toBeVisible();
    await expect(page.getByText(o.shareLinks.live)).toBeHidden();
    const link = admin.orders.orders
      .find((row) => row.id === ORDER_IDS.delivered)
      ?.shareLinks.find((item) => item.id === GIFT_LINK_ID);
    expect(link).toMatchObject({ revokedBy: 'admin', revokeReason: 'بلاغ عن رسالة احتيال' });
  });
});

// RTL screenshots of the S08 admin screens in both themes: the design review evidence (ADR 0011).
for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('S08 screenshots', async ({ page, admin }, testInfo) => {
      await open(page, admin, '/orders');
      await expect(rows(page)).toHaveCount(4);
      await screenshot(page, testInfo, `orders-${colorScheme}`);
      await page.goto(`/orders/${ORDER_IDS.held}`);
      await expect(page.getByText(o.decisions.heldHelp)).toBeVisible();
      await screenshot(page, testInfo, `order-held-${colorScheme}`, { fullPage: true });
      await page.getByRole('button', { name: o.decisions.refund.open }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await screenshot(page, testInfo, `order-refund-${colorScheme}`);
      await page.keyboard.press('Escape');
      await page.goto(`/orders/${ORDER_IDS.manual}`);
      await page.getByRole('button', { name: o.decisions.delivered.open }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await screenshot(page, testInfo, `order-manual-${colorScheme}`);
      await page.keyboard.press('Escape');
      await page.goto('/orders/policy');
      await expect(page.getByRole('button', { name: o.policy.save })).toBeVisible();
      await screenshot(page, testInfo, `order-policy-${colorScheme}`, { fullPage: true });
    });

    test('S10 screenshots: the checkout, the gift and the share links', async ({
      page,
      admin,
    }, testInfo) => {
      checkout(admin);
      await open(page, admin, '/orders');
      await expect(rows(page).filter({ hasText: o.gift.badge })).toHaveCount(1);
      await screenshot(page, testInfo, `orders-s10-badges-${colorScheme}`, { fullPage: true });
      await page.goto(`/orders/${ORDER_IDS.delivered}`);
      await expect(page.getByText(o.shareLinks.live)).toBeVisible();
      await screenshot(page, testInfo, `order-s10-gift-${colorScheme}`, { fullPage: true });
      await page.getByRole('button', { name: o.shareLinks.revoke }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await screenshot(page, testInfo, `order-s10-revoke-${colorScheme}`);
    });

    test('S09 screenshots: a reservation and the status filter', async ({
      page,
      admin,
    }, testInfo) => {
      reservations(admin);
      await open(page, admin, `/orders/${RESERVED_ID}`);
      await expect(page.getByText(o.detail.expiresAt, { exact: true })).toBeVisible();
      await screenshot(page, testInfo, `order-reserved-${colorScheme}`, { fullPage: true });
      await page.goto('/orders?status=cancelled');
      await expect(rows(page)).toHaveCount(1);
      await screenshot(page, testInfo, `orders-cancelled-${colorScheme}`);
    });
  });
}
