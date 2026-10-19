import type { Page } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import {
  ENDPOINT,
  IPHONE_SAFARI,
  iphoneSafari,
  OLD_KEY,
  PUBLIC_KEY,
  pushBrowser,
  pushRecord,
} from './push-browser';
import { expect, type MockApi, screenshot, test } from './test';

/*
 * Web push in the store (S15): the permission card on the order and deposit pages (PC1–PC3),
 * this device's switch (PC4), the "الهاتف" preferences column (PP1, PP2), the refresh on a
 * signed-in load (PS6, PS7), sign-out forgetting the subscription (PS5), and installing (IN1),
 * against the mocked API and a stubbed browser push side (`push-browser.ts`).
 */

const p = ar.push;
const ORDER_ID = '0199c000-0000-7000-8000-000000000001';
const DEPOSIT_ID = '0199a000-0000-7000-8000-0000000000d1';

function signedIn(api: MockApi): MockApi {
  return api
    .on('GET /api/auth/get-session', 200, {
      user: { name: 'سارة الأحمد', email: 'sara@example.com' },
      session: { token: 'this-device' },
    })
    .on('GET /api/account', 200, {
      id: '0199a000-0000-7000-8000-000000000010',
      name: 'سارة الأحمد',
      email: 'sara@example.com',
      phone: '+963944123456',
      createdAt: '2026-10-01T09:00:00.000Z',
    })
    .on('GET /api/auth/list-sessions', 200, [
      {
        id: 's-1',
        token: 'this-device',
        createdAt: '2026-10-07T08:00:00.000Z',
        updatedAt: '2026-10-08T08:00:00.000Z',
        ipAddress: '5.0.0.1',
        userAgent:
          'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
      },
    ]);
}

/** Push configured, a delivered order and a credited deposit to open. */
function withPush(api: MockApi): MockApi {
  return signedIn(api)
    .on('GET /api/push/config', 200, { publicKey: PUBLIC_KEY })
    .on('PUT /api/push/subscription', 204, null)
    .on('DELETE /api/push/subscription', 204, null)
    .on(`GET /api/orders/${ORDER_ID}`, 200, ORDER)
    .on(`GET /api/deposits/${DEPOSIT_ID}`, 200, DEPOSIT)
    .on('GET /api/deposits/usdt/options', 200, { state: 'off' });
}

const ORDER = {
  id: ORDER_ID,
  number: 'VO-7KQ2MX',
  stage: 'delivered',
  product: {
    id: `${ORDER_ID.slice(0, -2)}70`,
    nameAr: '60 UC',
    kind: 'direct',
    regionAr: null,
    redemptionAr: null,
  },
  game: {
    id: `${ORDER_ID.slice(0, -2)}80`,
    slug: 'pubg-mobile',
    nameAr: 'ببجي موبايل',
    cover: null,
  },
  fields: [{ key: 'player_id', labelAr: 'معرّف اللاعب', value: '5123456789', valueLabelAr: null }],
  quantity: 1,
  deliveredQuantity: 1,
  refundedQuantity: 0,
  unitPriceUsdUnits: 990_000,
  totalUsdUnits: 990_000,
  totalSypUnits: 1_287_000,
  refundedUsdUnits: 0,
  refundReason: null,
  timeline: [
    { step: 'paid', at: '2026-10-09T10:00:00.000Z' },
    { step: 'sent', at: '2026-10-09T10:00:01.000Z' },
    { step: 'delivered', at: '2026-10-09T10:00:12.000Z' },
  ],
  codes: [],
  expiresAt: null,
  cancelReason: null,
  playerName: null,
  deliveryStats: null,
  expectedWithinMinutes: null,
  checkoutId: null,
  isGift: false,
  gift: null,
  shareLinks: [],
  repeatable: false,
  createdAt: '2026-10-09T10:00:00.000Z',
};

const DEPOSIT = {
  id: DEPOSIT_ID,
  method: 'sham_cash',
  status: 'credited',
  referenceCode: 'VD-7KQ2M',
  currency: 'SYP',
  declaredAmountUnits: 200_000,
  declaredUsdUnits: 16_940_000,
  quote: null,
  expiresAt: '2026-10-09T09:00:00.000Z',
  createdAt: '2026-10-08T09:00:00.000Z',
  submittedAt: '2026-10-08T09:05:00.000Z',
  decidedAt: '2026-10-08T09:20:00.000Z',
  rateFixed: true,
  receiptRequest: null,
  payTo: null,
  eta: null,
  credited: {
    usdUnits: 16_100_000,
    receivedCurrency: 'SYP',
    receivedAmountUnits: 190_000,
    rate: '118',
  },
  rejection: null,
  usdt: null,
};

const card = (page: Page) => page.getByTestId('push-card');

test.describe('the permission card (PC1–PC3)', () => {
  test('is not offered while push is not configured', async ({ page, api }) => {
    withPush(api).on('GET /api/push/config', 200, { publicKey: null });
    await pushBrowser(page, { permission: 'default' });
    await page.goto(`/orders/${ORDER_ID}`);
    await expect(page.getByText(ORDER.number)).toBeVisible();
    await expect(card(page)).toHaveCount(0);
  });

  test('asks only on the tap, subscribes and registers the device', async ({
    page,
    api,
  }, testInfo) => {
    withPush(api);
    await pushBrowser(page, { permission: 'default', answer: 'granted' });
    await page.goto(`/orders/${ORDER_ID}`);
    await expect(card(page)).toContainText(p.card.order);
    expect((await pushRecord(page)).asked).toBe(0);
    await screenshot(page, testInfo, 'push-card-offer');

    await card(page).getByRole('button', { name: p.card.enable }).click();
    await expect(card(page)).toContainText(p.card.done);
    expect(await pushRecord(page)).toMatchObject({ asked: 1, subscribed: 1 });
    expect(api.last('PUT /api/push/subscription')?.body).toEqual({
      endpoint: ENDPOINT,
      expirationTime: null,
      keys: { p256dh: expect.any(String), auth: expect.any(String) },
    });
    await screenshot(page, testInfo, 'push-card-done');

    // Subscribed now: the card does not come back.
    await page.reload();
    await expect(page.getByText(ORDER.number)).toBeVisible();
    await expect(card(page)).toHaveCount(0);
  });

  test('explains how to allow notifications after a denial, then stops', async ({
    page,
    api,
  }, testInfo) => {
    withPush(api);
    await pushBrowser(page, { permission: 'default', answer: 'denied' });
    await page.goto(`/wallet/deposits/${DEPOSIT_ID}`);
    await expect(card(page)).toContainText(p.card.deposit);
    await card(page).getByRole('button', { name: p.card.enable }).click();
    await expect(card(page)).toContainText(p.denied.title);
    await expect(card(page)).toContainText(p.denied.hint);
    expect(api.last('PUT /api/push/subscription')).toBeUndefined();
    await screenshot(page, testInfo, 'push-card-denied');
  });

  test('keeps the button and says so when the registration fails', async ({ page, api }) => {
    withPush(api).on('PUT /api/push/subscription', 429, { code: 'RATE_LIMITED' });
    await pushBrowser(page, { permission: 'default', answer: 'granted' });
    await page.goto(`/orders/${ORDER_ID}`);
    await card(page).getByRole('button', { name: p.card.enable }).click();
    await expect(card(page).getByRole('alert')).toHaveText(p.card.failed);
    await expect(card(page).getByRole('button', { name: p.card.enable })).toBeEnabled();
  });

  test('"later" and a dismissed prompt keep it away for 30 days', async ({ page, api }) => {
    withPush(api);
    await pushBrowser(page, { permission: 'default', answer: 'default' });
    await page.goto(`/orders/${ORDER_ID}`);
    await card(page).getByRole('button', { name: p.card.enable }).click();
    await expect(card(page)).toHaveCount(0);
    await page.goto(`/wallet/deposits/${DEPOSIT_ID}`);
    await expect(page.getByText(DEPOSIT.referenceCode)).toBeVisible();
    await expect(card(page)).toHaveCount(0);
    // A month later it is offered again.
    await page.evaluate(() =>
      localStorage.setItem('vd-push-card-closed', String(Date.now() - 31 * 86_400_000)),
    );
    await page.reload();
    await card(page).getByRole('button', { name: p.card.later }).click();
    await expect(card(page)).toHaveCount(0);
    await page.reload();
    await expect(page.getByText(DEPOSIT.referenceCode)).toBeVisible();
    await expect(card(page)).toHaveCount(0);
  });

  test.describe('on an iPhone outside the installed app', () => {
    test.use({ userAgent: IPHONE_SAFARI });

    test('asks to install first, with the steps', async ({ page, api }, testInfo) => {
      withPush(api);
      await iphoneSafari(page);
      await page.goto(`/orders/${ORDER_ID}`);
      await expect(card(page)).toContainText(p.card.ios);
      await expect(card(page).getByRole('button', { name: p.card.enable })).toHaveCount(0);
      await screenshot(page, testInfo, 'push-card-ios');
      await card(page).getByRole('button', { name: p.card.iosSteps }).click();
      const steps = page.getByTestId('install-steps');
      await expect(steps).toContainText(ar.pwa.ios.step2);
      await screenshot(page, testInfo, 'install-steps-ios');
      await steps.getByRole('button', { name: ar.pwa.ios.close }).click();
      await expect(steps).toHaveCount(0);
      // The footer offers the same steps (IN1).
      await expect(page.getByRole('button', { name: ar.pwa.install })).toBeVisible();
    });
  });
});

test.describe('this device and the preferences (PC4, PP1, PP2)', () => {
  test('the "الهاتف" column, and the device switch on then off', async ({
    page,
    api,
  }, testInfo) => {
    withPush(api).on('PUT /api/account/notification-preferences', 200, {
      email: { order_delivered: true },
      push: { order_delivered: false },
    });
    await pushBrowser(page, { permission: 'default', answer: 'granted' });
    await page.goto('/account');
    const label = ar.account.notifications.events.deposit_credited;
    const push = page.getByRole('switch', {
      name: ar.account.notifications.pushLabel.replace('{event}', label),
    });
    await expect(push).toBeChecked();
    await expect(page.getByText(p.device.off)).toBeVisible();
    await screenshot(page, testInfo, 'push-preferences');

    await push.click();
    await expect(push).not.toBeChecked();
    expect(api.last('PUT /api/account/notification-preferences')?.body).toEqual({
      event: 'deposit_credited',
      push: false,
    });

    const device = page.getByRole('switch', { name: p.device.label });
    await device.click();
    await expect(device).toBeChecked();
    await expect(page.getByText(p.device.off)).toHaveCount(0);
    expect(api.last('PUT /api/push/subscription')?.body).toMatchObject({ endpoint: ENDPOINT });

    await device.click();
    await expect(device).not.toBeChecked();
    expect(api.last('DELETE /api/push/subscription')?.body).toEqual({ endpoint: ENDPOINT });
    expect((await pushRecord(page)).unsubscribed).toBe(1);
  });

  test('the switch is disabled with the hint once denied', async ({ page, api }) => {
    withPush(api);
    await pushBrowser(page, { permission: 'denied' });
    await page.goto('/account');
    await expect(page.getByRole('switch', { name: p.device.label })).toBeDisabled();
    await expect(page.getByText(p.denied.hint)).toBeVisible();
  });

  test('without push configured, no column and no switch', async ({ page, api }) => {
    signedIn(api);
    await pushBrowser(page, { permission: 'default' });
    await page.goto('/account');
    await expect(
      page.getByRole('switch', { name: ar.account.notifications.events.deposit_credited }),
    ).toBeChecked();
    await expect(
      page.getByRole('switch', {
        name: ar.account.notifications.pushLabel.replace(
          '{event}',
          ar.account.notifications.events.deposit_credited,
        ),
      }),
    ).toHaveCount(0);
    await expect(page.getByRole('switch', { name: p.device.label })).toHaveCount(0);
  });

  test('the notification center shows the switch only while push is off here', async ({
    page,
    api,
  }) => {
    withPush(api).on('GET /api/notifications', 200, {
      items: [],
      nextCursor: null,
      unreadCount: 0,
    });
    await pushBrowser(page, { permission: 'default' });
    await page.goto('/notifications');
    await expect(page.getByRole('switch', { name: p.device.label })).not.toBeChecked();
  });

  test('…and not once it is on', async ({ page, api }) => {
    withPush(api).on('GET /api/notifications', 200, {
      items: [],
      nextCursor: null,
      unreadCount: 0,
    });
    await pushBrowser(page, { permission: 'granted', heldKey: PUBLIC_KEY });
    await page.goto('/notifications');
    await expect(page.getByText(ar.notifications.empty)).toBeVisible();
    await expect(page.getByRole('switch', { name: p.device.label })).toHaveCount(0);
  });
});

test.describe('the subscription follows the session (PS5–PS7)', () => {
  test('a signed-in load re-registers the held subscription once per tab', async ({
    page,
    api,
  }) => {
    withPush(api);
    await pushBrowser(page, { permission: 'granted', heldKey: PUBLIC_KEY });
    await page.goto(`/orders/${ORDER_ID}`);
    await expect
      .poll(() => api.requests.filter((r) => r.key === 'PUT /api/push/subscription').length)
      .toBe(1);
    await page.reload();
    await expect(page.getByText(ORDER.number)).toBeVisible();
    await page.waitForTimeout(500);
    expect(api.requests.filter((r) => r.key === 'PUT /api/push/subscription')).toHaveLength(1);
    expect((await pushRecord(page)).subscribed).toBe(0);

    // Signed in again in this tab (the session expired or was revoked elsewhere): rebound.
    api.on('GET /api/auth/get-session', 200, {
      user: { name: 'سارة الأحمد', email: 'sara@example.com' },
      session: { token: 'a-new-session' },
    });
    await page.reload();
    await expect
      .poll(() => api.requests.filter((r) => r.key === 'PUT /api/push/subscription').length)
      .toBe(2);
    expect(await page.evaluate(() => sessionStorage.getItem('vd-push-refreshed'))).not.toContain(
      'a-new-session',
    );
  });

  test('a subscription made with another key is replaced without a prompt', async ({
    page,
    api,
  }) => {
    withPush(api);
    await pushBrowser(page, { permission: 'granted', heldKey: OLD_KEY });
    await page.goto(`/orders/${ORDER_ID}`);
    await expect.poll(() => api.last('PUT /api/push/subscription')).toBeTruthy();
    expect(await pushRecord(page)).toEqual({ asked: 0, subscribed: 1, unsubscribed: 1 });
  });

  test('sign-out makes the browser forget its subscription', async ({ page, api }) => {
    withPush(api).on('POST /api/auth/sign-out', 200, { success: true });
    await pushBrowser(page, { permission: 'granted', heldKey: PUBLIC_KEY });
    await page.goto(`/orders/${ORDER_ID}`);
    await expect(page.getByText(ORDER.number)).toBeVisible();
    await page.getByRole('button', { name: ar.header.menu }).click();
    await page.getByRole('menuitem', { name: ar.header.signOut }).click();
    await expect(page).toHaveURL(/\/$/);
    expect(api.last('POST /api/auth/sign-out')).toBeTruthy();
    expect(await page.evaluate(() => sessionStorage.getItem('e2e-push-unsubscribed'))).toBe('1');
  });
});

test.describe('installing (IN1)', () => {
  test("offers Chromium's prompt once the browser allows it", async ({ page, api }) => {
    signedIn(api);
    await page.goto('/');
    const footer = page.getByRole('contentinfo');
    await expect(footer.getByRole('button', { name: ar.pwa.install })).toHaveCount(0);
    await page.evaluate(() => {
      const event = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), {
        prompt: async () => {
          (window as unknown as { __prompted: boolean }).__prompted = true;
        },
      });
      window.dispatchEvent(event);
    });
    await page.getByRole('button', { name: ar.header.menu }).click();
    await expect(page.getByRole('menuitem', { name: ar.pwa.install })).toBeVisible();
    await page.keyboard.press('Escape');
    await footer.getByRole('button', { name: ar.pwa.install }).click();
    expect(
      await page.evaluate(() => (window as unknown as { __prompted?: boolean }).__prompted),
    ).toBe(true);
    // The kept event works once.
    await expect(footer.getByRole('button', { name: ar.pwa.install })).toHaveCount(0);
  });
});

// RTL screenshots in light too (dark is the default above): every state of the card, the
// preferences and the iOS steps.
test.describe('push screenshots (light)', () => {
  test.beforeEach(async ({ page, api }) => {
    withPush(api);
    await page.addInitScript(() => localStorage.setItem('vertex-theme', 'light'));
  });

  test('offer, done and the preferences', async ({ page }, testInfo) => {
    await pushBrowser(page, { permission: 'default', answer: 'granted' });
    await page.goto(`/orders/${ORDER_ID}`);
    await expect(card(page)).toContainText(p.card.order);
    await screenshot(page, testInfo, 'push-card-offer-light');
    await card(page).getByRole('button', { name: p.card.enable }).click();
    await expect(card(page)).toContainText(p.card.done);
    await screenshot(page, testInfo, 'push-card-done-light');
    await page.goto('/account');
    await expect(page.getByRole('switch', { name: p.device.label })).toBeChecked();
    await screenshot(page, testInfo, 'push-preferences-on-light');
  });

  test('denied', async ({ page }, testInfo) => {
    await pushBrowser(page, { permission: 'default', answer: 'denied' });
    await page.goto(`/wallet/deposits/${DEPOSIT_ID}`);
    await card(page).getByRole('button', { name: p.card.enable }).click();
    await expect(card(page)).toContainText(p.denied.title);
    await screenshot(page, testInfo, 'push-card-denied-light');
    await page.goto('/account');
    await expect(page.getByText(p.denied.hint)).toBeVisible();
    await screenshot(page, testInfo, 'push-preferences-light');
  });

  test.describe('iPhone', () => {
    test.use({ userAgent: IPHONE_SAFARI });

    test('the install hint and steps', async ({ page }, testInfo) => {
      await iphoneSafari(page);
      await page.goto(`/orders/${ORDER_ID}`);
      await expect(card(page)).toContainText(p.card.ios);
      await screenshot(page, testInfo, 'push-card-ios-light');
      await card(page).getByRole('button', { name: p.card.iosSteps }).click();
      await expect(page.getByTestId('install-steps')).toContainText(ar.pwa.ios.step2);
      await screenshot(page, testInfo, 'install-steps-ios-light');
    });
  });
});
