import type { Order, OrderSummary } from '@vertex-digital/contracts';
import ar from '../src/messages/ar.json' with { type: 'json' };
import { expect, type MockApi, screenshot, test } from './test';

/*
 * "طلباتي" and the order page (S08): the empty list, the list with each stage, a delivered
 * top-up, a code product's codes masked then revealed, a partial refund and a delayed order,
 * another customer's order as not found, against the mocked API. Amounts in micro-dollars.
 */

const o = ar.orders;

const id = (n: number) => `0199c000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const IDS = {
  topUp: id(1),
  codes: id(2),
  partial: id(3),
  delayed: id(4),
  reserved: id(5),
  cancelled: id(6),
  other: id(9),
};
const CODE_ID = id(50);

function signedIn(api: MockApi): MockApi {
  return api.on('GET /api/auth/get-session', 200, {
    user: { name: 'سارة الأحمد', email: 'sara@example.com' },
    session: { token: 'this-device' },
  });
}

const game = { id: id(80), slug: 'pubg-mobile', nameAr: 'ببجي موبايل', cover: null };
const itunes = { id: id(81), slug: 'itunes', nameAr: 'آيتونز', cover: null };

function order(changes: Partial<Order> & { id: string }): Order {
  return {
    number: 'VO-7KQ2MX',
    stage: 'delivered',
    product: { id: id(70), nameAr: '60 UC', kind: 'direct', regionAr: null, redemptionAr: null },
    game,
    fields: [{ key: 'player_id', labelAr: 'معرّف اللاعب', value: '5123456789' }],
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
    createdAt: '2026-10-09T10:00:00.000Z',
    ...changes,
  };
}

const ORDERS: Record<Exclude<keyof typeof IDS, 'other'>, Order> = {
  topUp: order({ id: IDS.topUp }),
  codes: order({
    id: IDS.codes,
    number: 'VO-CODE23',
    product: {
      id: id(71),
      nameAr: 'بطاقة آيتونز 10$',
      kind: 'code',
      regionAr: 'الولايات المتحدة',
      redemptionAr: 'افتح App Store، ثم الحساب، ثم استرداد بطاقة هدية.',
    },
    game: itunes,
    fields: [],
    codes: [{ id: CODE_ID, position: 1, masked: '•••• 9Q4X', firstRevealedAt: null }],
  }),
  partial: order({
    id: IDS.partial,
    number: 'VO-PART45',
    stage: 'partially_refunded',
    product: {
      id: id(71),
      nameAr: 'بطاقة آيتونز 10$',
      kind: 'code',
      regionAr: null,
      redemptionAr: null,
    },
    game: itunes,
    fields: [],
    quantity: 3,
    deliveredQuantity: 2,
    refundedQuantity: 1,
    unitPriceUsdUnits: 10_600_000,
    totalUsdUnits: 31_800_000,
    refundedUsdUnits: 10_600_000,
    refundReason: 'routes_exhausted',
    timeline: [
      { step: 'paid', at: '2026-10-09T09:00:00.000Z' },
      { step: 'sent', at: '2026-10-09T09:00:01.000Z' },
      { step: 'partially_refunded', at: '2026-10-09T09:01:00.000Z' },
    ],
    codes: [
      { id: id(51), position: 1, masked: '•••• 1A2B', firstRevealedAt: '2026-10-09T09:05:00.000Z' },
      { id: id(52), position: 2, masked: '•••• 3C4D', firstRevealedAt: null },
    ],
  }),
  reserved: order({
    id: IDS.reserved,
    number: 'VO-WAIT23',
    stage: 'awaiting_balance',
    deliveredQuantity: 0,
    product: { id: id(72), nameAr: '660 UC', kind: 'direct', regionAr: null, redemptionAr: null },
    unitPriceUsdUnits: 9_990_000,
    totalUsdUnits: 9_990_000,
    totalSypUnits: 12_987_000,
    timeline: [{ step: 'reserved', at: '2026-10-09T11:00:00.000Z' }],
    expiresAt: new Date(Date.now() + 23 * 3_600_000).toISOString(),
    playerName: 'Lina_99',
  }),
  cancelled: order({
    id: IDS.cancelled,
    number: 'VO-GONE45',
    stage: 'cancelled',
    deliveredQuantity: 0,
    timeline: [
      { step: 'reserved', at: '2026-10-08T11:00:00.000Z' },
      { step: 'cancelled', at: '2026-10-09T11:00:00.000Z' },
    ],
    expiresAt: '2026-10-09T11:00:00.000Z',
    cancelReason: 'expired',
  }),
  delayed: order({
    id: IDS.delayed,
    number: 'VO-LATE67',
    stage: 'delayed',
    deliveredQuantity: 0,
    timeline: [
      { step: 'paid', at: '2026-10-09T08:00:00.000Z' },
      { step: 'sent', at: '2026-10-09T08:00:01.000Z' },
      { step: 'delayed', at: '2026-10-09T08:30:00.000Z' },
    ],
  }),
};

const summary = (item: Order): OrderSummary => ({
  id: item.id,
  number: item.number,
  stage: item.stage,
  productNameAr: item.product.nameAr,
  game: item.game,
  quantity: item.quantity,
  totalUsdUnits: item.totalUsdUnits,
  totalSypUnits: item.totalSypUnits,
  expiresAt: item.expiresAt,
  createdAt: item.createdAt,
});

function withOrders(api: MockApi): MockApi {
  signedIn(api).on('GET /api/orders', 200, {
    items: Object.values(ORDERS).map(summary),
    nextCursor: null,
  });
  for (const item of Object.values(ORDERS)) api.on(`GET /api/orders/${item.id}`, 200, item);
  return api;
}

test.describe('orders', () => {
  test('an empty list points to the games', async ({ page, api }) => {
    signedIn(api).on('GET /api/orders', 200, { items: [], nextCursor: null });
    await page.goto('/orders');
    await expect(page.getByText(o.emptyTitle)).toBeVisible();
    await expect(page.getByRole('link', { name: o.browseGames })).toHaveAttribute('href', '/');
  });

  test('lists each order with its stage, opens one, and the account menu leads here', async ({
    page,
    api,
  }) => {
    withOrders(api);
    await page.goto('/');
    await page.getByRole('button', { name: ar.header.menu }).click();
    await page.getByRole('menuitem', { name: ar.header.orders }).click();
    await expect(page).toHaveURL('/orders');
    for (const stage of ['delivered', 'partially_refunded', 'delayed'] as const) {
      await expect(page.getByText(o.stages[stage], { exact: true }).first()).toBeVisible();
    }
    await page.getByRole('link', { name: /VO-LATE67/ }).click();
    await expect(page).toHaveURL(`/orders/${IDS.delayed}`);
    await expect(page.getByText(o.sentences.delayed)).toBeVisible();
  });

  test('a delivered top-up shows its account field, money and stages', async ({ page, api }) => {
    withOrders(api);
    await page.goto(`/orders/${IDS.topUp}`);
    await expect(page.getByText(o.sentences.delivered).first()).toBeVisible();
    await expect(page.getByText('5123456789')).toBeVisible();
    await expect(page.getByText('$0.99').first()).toBeVisible();
    await expect(page.getByRole('list', { name: o.detail.timeline })).toContainText(o.steps.sent);
  });

  test('a code is masked until revealed, then copied with its first reveal time (rule C2)', async ({
    page,
    api,
  }) => {
    withOrders(api).on(`POST /api/orders/${IDS.codes}/codes/${CODE_ID}/reveal`, 200, {
      code: 'ITUNES-7K2M-9Q4X',
      firstRevealedAt: '2026-10-09T10:05:00.000Z',
    });
    await page.goto(`/orders/${IDS.codes}`);
    await expect(page.getByText('•••• 9Q4X')).toBeVisible();
    await expect(page.getByText('ITUNES-7K2M-9Q4X')).toBeHidden();
    await page.getByRole('button', { name: o.codes.reveal }).click();
    await expect(page.getByText('ITUNES-7K2M-9Q4X')).toBeVisible();
    await expect(page.getByText(o.codes.firstRevealed.split('{')[0] as string)).toBeVisible();
    await expect(page.getByRole('button', { name: o.codes.copy })).toBeVisible();
    await expect(page.getByText('الولايات المتحدة')).toBeVisible();
  });

  test('a refused reveal says what to do next', async ({ page, api }) => {
    withOrders(api).on(`POST /api/orders/${IDS.codes}/codes/${CODE_ID}/reveal`, 429, {
      statusCode: 429,
      code: 'RATE_LIMITED',
    });
    await page.goto(`/orders/${IDS.codes}`);
    await page.getByRole('button', { name: o.codes.reveal }).click();
    await expect(page.getByText(ar.errors.RATE_LIMITED)).toBeVisible();
  });

  test('a partial refund names the amount and the reason', async ({ page, api }) => {
    withOrders(api);
    await page.goto(`/orders/${IDS.partial}`);
    await expect(page.getByText(o.sentences.partially_refunded)).toBeVisible();
    await expect(page.getByText('$10.60').first()).toBeVisible();
    await expect(page.getByText(o.refundReasons.routes_exhausted)).toBeVisible();
  });

  test("another customer's order is the not-found page", async ({ page, api }) => {
    signedIn(api).on(`GET /api/orders/${IDS.other}`, 404, { statusCode: 404, code: 'NOT_FOUND' });
    await page.goto(`/orders/${IDS.other}`);
    await expect(page.getByText(ar.notFound.title)).toBeVisible();
  });

  test('a reservation counts down, prefills the deposit and can be cancelled (steps 6, 8)', async ({
    page,
    api,
  }) => {
    withOrders(api).on('GET /api/wallet', 200, { balanceUnits: 5_000_000, syp: null });
    await page.goto(`/orders/${IDS.reserved}`);
    await expect(page.getByRole('heading', { name: o.reservation.title })).toBeVisible();
    await expect(page.getByRole('timer')).toHaveText(/^2[23]:\d\d:\d\d$/);
    await expect(page.getByText('Lina_99')).toBeVisible();
    await expect(page.getByRole('link', { name: o.reservation.deposit })).toHaveAttribute(
      'href',
      `/wallet/deposit?amount=499&order=${IDS.reserved}`,
    );
    // The steps ahead are listed, greyed.
    await expect(
      page.getByRole('list', { name: o.detail.timeline }).getByRole('listitem'),
    ).toHaveText(
      [o.steps.reserved, o.steps.paid, o.steps.sent, o.steps.delivered].map(
        (step) => new RegExp(step),
      ),
    );
    await page.getByRole('button', { name: o.reservation.cancel }).click();
    const cancelled = { ...ORDERS.reserved, stage: 'cancelled', cancelReason: 'customer' };
    api
      .on(`POST /api/orders/${IDS.reserved}/cancel`, 200, cancelled)
      .on(`GET /api/orders/${IDS.reserved}`, 200, cancelled);
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: o.reservation.cancelConfirm })
      .click();
    await expect(page.getByText(o.cancelReasons.customer)).toBeVisible();
    await expect(page.getByText(o.stages.cancelled, { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: o.reservation.title })).toBeHidden();
  });

  test('a paid order moves to delivered live over the stream, with the success mark (step 5)', async ({
    page,
    api,
  }) => {
    const processing = order({
      id: IDS.topUp,
      stage: 'processing',
      deliveredQuantity: 0,
      timeline: [{ step: 'paid', at: '2026-10-09T10:00:00.000Z' }],
      deliveryStats: { medianMs: 40_000, p90Ms: 95_000, count: 20 },
    });
    signedIn(api)
      .on(`GET /api/orders/${IDS.topUp}`, 200, processing)
      .stream(
        'GET /api/notifications/stream',
        [
          { event: 'unread', data: { unreadCount: 0 } },
          {
            event: 'order',
            data: { orderId: IDS.topUp, status: 'delivered', stage: 'delivered' },
          },
        ],
        2_000,
      );
    await page.goto(`/orders/${IDS.topUp}`);
    await expect(page.getByText(o.sentences.processing)).toBeVisible();
    await expect(
      page.getByText(ar.catalog.delivery.p90.replace('{duration}', 'دقيقتين')),
    ).toBeVisible();
    // The next read, when the event arrives, finds the order delivered.
    api.on(`GET /api/orders/${IDS.topUp}`, 200, ORDERS.topUp);
    await expect(page.getByText(o.sentences.delivered).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-slot="success-mark"]')).toBeVisible();
  });

  test('"طلباتي" shows the time a reservation has left', async ({ page, api }) => {
    withOrders(api);
    await page.goto('/orders');
    const card = page.getByRole('link', { name: /VO-WAIT23/ });
    await expect(card).toContainText(o.stages.awaiting_balance);
    await expect(card).toContainText(o.reservation.leftShort);
  });

  test('without a session the list sends to sign-in and back', async ({ page, api }) => {
    api.on('GET /api/orders', 401, { statusCode: 401, code: 'UNAUTHORIZED' });
    await page.goto('/orders');
    await expect(page).toHaveURL(/\/sign-in\?next=%2Forders/);
  });
});

for (const theme of ['dark', 'light'] as const) {
  test(`order screenshots, ${theme} theme`, async ({ page, api }, testInfo) => {
    if (theme === 'light') {
      await page.addInitScript(() => localStorage.setItem('vertex-theme', 'light'));
    }
    signedIn(api).on('GET /api/orders', 200, { items: [], nextCursor: null });
    await page.goto('/orders');
    await expect(page.getByText(o.emptyTitle)).toBeVisible();
    await screenshot(page, testInfo, `orders-empty-${theme}`);

    withOrders(api).on(`POST /api/orders/${IDS.codes}/codes/${CODE_ID}/reveal`, 200, {
      code: 'ITUNES-7K2M-9Q4X',
      firstRevealedAt: '2026-10-09T10:05:00.000Z',
    });
    await page.goto('/orders');
    await expect(page.getByText('VO-LATE67')).toBeVisible();
    await screenshot(page, testInfo, `orders-${theme}`);
    for (const [name, orderId] of [
      ['delivered', IDS.topUp],
      ['partial', IDS.partial],
      ['delayed', IDS.delayed],
      ['reserved', IDS.reserved],
      ['cancelled', IDS.cancelled],
    ] as const) {
      await page.goto(`/orders/${orderId}`);
      await expect(page.getByRole('list', { name: o.detail.timeline })).toBeVisible();
      await screenshot(page, testInfo, `order-${name}-${theme}`);
    }
    await page.goto(`/orders/${IDS.codes}`);
    await page.getByRole('button', { name: o.codes.reveal }).click();
    await expect(page.getByText('ITUNES-7K2M-9Q4X')).toBeVisible();
    await screenshot(page, testInfo, `order-codes-${theme}`);
  });
}
