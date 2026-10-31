import type { Order, ProductAlert, Ticket } from '@vertex-digital/contracts';
import oh from '../src/features/order-help/messages.ar.json' with { type: 'json' };
import pa from '../src/features/product-alerts/messages.ar.json' with { type: 'json' };
import ar from '../src/messages/ar.json' with { type: 'json' };
import { PUBG, pack } from './catalog';
import { expect, type MockApi, screenshot, test } from './test';

/*
 * S22 PR 3 against the mocked API: the order page's problem card (OP1–OP3), a hint sheet before
 * the ticket (OP4), the form sending an order ticket naming the problem (OP5), the open ticket in
 * place of the card; the availability alert on an unavailable pack and the price-drop bell (PA1),
 * and "تنبيهاتي" (PA7). Screenshots at phone and desktop width, dark and light.
 */

const fill = (text: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce(
    (result, [key, value]) => result.replace(`{${key}}`, `${value}`),
    text,
  );
const id = (n: number) => `0199f000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const ORDER_ID = id(1);
const TICKET_ID = id(2);
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function signedIn(api: MockApi): MockApi {
  return api.on('GET /api/auth/get-session', 200, {
    user: { name: 'سارة الأحمد', email: 'sara@example.com', emailVerified: true },
    session: { token: 'this-device' },
  });
}

function order(changes: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    number: 'VO-HLP234',
    stage: 'processing',
    placedByStore: null,
    customerNote: null,
    product: { id: id(70), nameAr: '60 UC', kind: 'direct', regionAr: null, redemptionAr: null },
    game: { id: PUBG.game.id, slug: 'pubg-mobile', nameAr: 'ببجي موبايل', cover: null },
    fields: [{ key: 'player_id', labelAr: 'معرّف اللاعب', value: '5123456789', valueLabelAr: null }],
    quantity: 1,
    deliveredQuantity: 0,
    refundedQuantity: 0,
    unitPriceUsdUnits: 990_000,
    totalUsdUnits: 990_000,
    totalSypUnits: 1_287_000,
    refundedUsdUnits: 0,
    refundReason: null,
    timeline: [{ step: 'paid', at: minutesAgo(1) }],
    codes: [],
    expiresAt: null,
    cancelReason: null,
    playerName: null,
    playerRegion: null,
    deliveryStats: { medianMs: 60_000, p90Ms: 300_000, count: 20 },
    expectedWithinMinutes: null,
    checkoutId: null,
    isGift: false,
    gift: null,
    shareLinks: [],
    privatePrice: false,
    verificationCode: 'VrfyCode0123456789abcd',
    sale: null,
    codeReleases: [],
    help: {
      status: 'sent_to_supplier',
      paidAt: minutesAgo(1),
      finishedAt: null,
      openTicketId: null,
    },
    repeatable: false,
    createdAt: minutesAgo(1),
    ...changes,
  };
}

const ticket: Ticket = {
  id: TICKET_ID,
  number: 'VT-HLP234',
  category: 'order',
  order: { id: ORDER_ID, number: 'VO-HLP234' },
  deposit: null,
  subject: 'تأخر الطلب · VO-HLP234',
  orderProblem: 'not_arrived',
  status: 'open',
  openedBy: 'customer',
  lastAuthor: 'customer',
  lastMessageAt: minutesAgo(0),
  closedAt: null,
  closedBy: null,
  createdAt: minutesAgo(0),
  canReply: true,
  messages: [
    {
      id: id(3),
      author: 'customer',
      body: 'لم يصل الطلب بعد.',
      attachments: [],
      createdAt: minutesAgo(0),
    },
  ],
};

const p1800 = pack(PUBG, '1800 UC');
const alert = (changes: Partial<ProductAlert>): ProductAlert => ({
  id: id(10),
  kind: 'available',
  status: 'active',
  product: { id: p1800.id, nameAr: '1800 UC', kind: 'direct' },
  game: { id: PUBG.game.id, slug: 'pubg-mobile', nameAr: 'ببجي موبايل', cover: null },
  baselinePriceUsdUnits: null,
  expiresAt: '2027-01-20T10:00:00.000Z',
  sentAt: null,
  endedAt: null,
  createdAt: '2026-10-22T10:00:00.000Z',
  ...changes,
});

test.describe('order problems (S22 OP1–OP5)', () => {
  test('a late order shows the usual-time hint, then opens a ticket naming the problem', async ({
    page,
    api,
  }) => {
    signedIn(api)
      .on(`GET /api/orders/${ORDER_ID}`, 200, order())
      .on('POST /api/support/tickets', 201, ticket)
      .on(`GET /api/support/tickets/${TICKET_ID}`, 200, ticket);
    await page.goto(`/orders/${ORDER_ID}`);
    const card = page.getByTestId('problem-card');
    await expect(card.getByText(oh.card.title)).toBeVisible();
    await expect(card.getByRole('button')).toHaveText([
      oh.problems.not_arrived_waiting,
      oh.problems.wrong_player_id,
      oh.problems.other,
    ]);
    await card.getByRole('button', { name: oh.problems.not_arrived_waiting }).click();
    const sheet = page.getByTestId('problem-sheet');
    await expect(sheet.getByText(fill(oh.hints.usual_time, { minutes: 5 }))).toBeVisible();
    // "حسناً، سأنتظر" closes it with nothing sent.
    await sheet.getByRole('button', { name: oh.hints.wait }).click();
    await expect(sheet).toBeHidden();
    await card.getByRole('button', { name: oh.problems.not_arrived_waiting }).click();
    await page.getByTestId('problem-sheet').getByRole('button', { name: oh.hints.anyway }).click();
    await page.getByTestId('problem-sheet').getByRole('textbox').fill('دفعت قبل دقيقة.');
    await page.getByTestId('problem-sheet').getByRole('button', { name: oh.form.send }).click();
    await expect(page).toHaveURL(`/support/${TICKET_ID}`);
    const sent = api.last('POST /api/support/tickets');
    expect(sent?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    const body = String(sent?.body);
    expect(body).toContain('name="category"\r\n\r\norder');
    expect(body).toContain(`name="orderId"\r\n\r\n${ORDER_ID}`);
    expect(body).toContain('name="orderProblem"\r\n\r\nnot_arrived');
    expect(body).toContain(`name="subject"\r\n\r\n${oh.problems.not_arrived_waiting} · VO-HLP234`);
    // Multipart text fields carry their new lines as CRLF.
    expect(body).toContain(`${oh.sentences.not_arrived}\r\n\r\nدفعت قبل دقيقة.`);
  });

  test('a delivered code offers its problems; an open ticket or the closed window replace them', async ({
    page,
    api,
  }) => {
    const delivered = order({
      stage: 'delivered',
      product: {
        id: id(71),
        nameAr: 'بطاقة آيتونز 10$',
        kind: 'code',
        regionAr: 'الولايات المتحدة',
        redemptionAr: 'افتح App Store ثم استرداد بطاقة هدية.',
      },
      fields: [],
      help: {
        status: 'delivered',
        paidAt: minutesAgo(60),
        finishedAt: minutesAgo(59),
        openTicketId: null,
      },
    });
    signedIn(api).on(`GET /api/orders/${ORDER_ID}`, 200, delivered);
    await page.goto(`/orders/${ORDER_ID}`);
    const card = page.getByTestId('problem-card');
    await expect(card.getByRole('button')).toHaveText([
      oh.problems.code_not_working,
      oh.problems.code_used,
      oh.problems.wrong_region,
      oh.problems.other,
    ]);
    await card.getByRole('button', { name: oh.problems.code_used }).click();
    const sheet = page.getByTestId('problem-sheet');
    await expect(
      sheet.getByText(fill(oh.hints.region, { region: 'الولايات المتحدة' })),
    ).toBeVisible();
    await expect(sheet.getByText('افتح App Store ثم استرداد بطاقة هدية.')).toBeVisible();
    // The ticket refused because the order changed: the card reads the order again.
    api
      .on('POST /api/support/tickets', 409, {
        code: 'ORDER_PROBLEM_UNAVAILABLE',
        details: { reason: 'window_closed' },
      })
      .on(`GET /api/orders/${ORDER_ID}`, 200, {
        ...delivered,
        help: { ...delivered.help, finishedAt: '2026-01-01T10:00:00.000Z' },
      });
    await sheet.getByRole('button', { name: oh.hints.anyway }).click();
    await page.getByTestId('problem-sheet').getByRole('button', { name: oh.form.send }).click();
    // The sheet says why and keeps what was typed; closing it refreshes the card (audit A04-41).
    await expect(
      page.getByTestId('problem-sheet').getByText(ar.errors.ORDER_PROBLEM_UNAVAILABLE),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByText(oh.card.windowClosed)).toBeVisible();
    await expect(page.getByRole('link', { name: oh.card.windowClosedLink })).toHaveAttribute(
      'href',
      `/support/new?category=order&order=${ORDER_ID}`,
    );

    api.on(`GET /api/orders/${ORDER_ID}`, 200, {
      ...delivered,
      help: { ...delivered.help, openTicketId: TICKET_ID },
    });
    await page.reload();
    await expect(page.getByText(oh.card.openTicket)).toBeVisible();
    await expect(page.getByRole('link', { name: oh.card.openTicketLink })).toHaveAttribute(
      'href',
      `/support/${TICKET_ID}`,
    );
  });
});

test.describe('product alerts (S22 PA1, PA7)', () => {
  test('sets an availability alert on a folded pack and cancels it', async ({ page, api }) => {
    signedIn(api).on('POST /api/product-alerts', 201, alert({}));
    await page.goto('/games/pubg-mobile');
    await page
      .locator('summary', { hasText: ar.game.unavailable.split(' (')[0] as string })
      .click();
    await page
      .getByTestId('alert-available')
      .getByRole('button', { name: pa.button.available })
      .click();
    await expect(page.getByText(pa.button.availableSet)).toBeVisible();
    await expect(page.getByText(pa.set.available)).toBeVisible();
    expect(api.last('POST /api/product-alerts')?.body).toEqual({
      productId: p1800.id,
      kind: 'available',
    });
    api.on(`DELETE /api/product-alerts/${id(10)}`, 204, null);
    await page.getByRole('button', { name: pa.button.cancel }).click();
    await expect(
      page.getByTestId('alert-available').getByRole('button', { name: pa.button.available }),
    ).toBeVisible();
  });

  test('a link to a resting pack opens the list with its alert, no click needed (DL3, PA1)', async ({
    page,
    api,
  }) => {
    signedIn(api);
    await page.goto(`/games/pubg-mobile?pack=${p1800.id}`);
    await expect(
      page.getByTestId('alert-available').getByRole('button', { name: pa.button.available }),
    ).toBeVisible();
  });

  test('signed out, the alert leads to sign-in and back', async ({ page }) => {
    await page.goto('/games/pubg-mobile');
    await page
      .locator('summary', { hasText: ar.game.unavailable.split(' (')[0] as string })
      .click();
    await expect(page.getByRole('link', { name: pa.button.available })).toHaveAttribute(
      'href',
      `/sign-in?next=${encodeURIComponent('/games/pubg-mobile')}`,
    );
  });

  test('"تنبيهاتي" lists the active and ended alerts and cancels one', async ({ page, api }) => {
    const drop = alert({
      id: id(11),
      kind: 'price_drop',
      product: { id: id(72), nameAr: '660 UC', kind: 'direct' },
      baselinePriceUsdUnits: 9_990_000,
    });
    signedIn(api)
      .on('GET /api/product-alerts?status=active', 200, { items: [alert({}), drop] })
      .on('GET /api/product-alerts?status=ended', 200, { items: [] });
    await page.goto('/account/alerts');
    await expect(page.getByRole('heading', { name: pa.page.active })).toBeVisible();
    await expect(page.getByText(fill(pa.page.baseline, { price: '⁦$9.99⁩' }))).toBeVisible();
    api
      .on(`DELETE /api/product-alerts/${id(11)}`, 204, null)
      .on('GET /api/product-alerts?status=active', 200, { items: [alert({})] });
    await page.getByRole('button', { name: fill(pa.page.cancelLabel, { name: '660 UC' }) }).click();
    await expect(page.getByText('660 UC')).toHaveCount(0);
  });

  test('"تنبيهاتي" offers a retry when its read fails (audit A04-17)', async ({ page, api }) => {
    signedIn(api).on('GET /api/product-alerts?status=active', 500, { code: 'INTERNAL_ERROR' });
    await page.goto('/account/alerts');
    await expect(page.getByText(pa.page.loadFailed)).toBeVisible();
    api.on('GET /api/product-alerts?status=active', 200, { items: [alert({})] });
    await page.getByRole('button', { name: pa.page.retry }).click();
    await expect(page.getByRole('heading', { name: pa.page.active })).toBeVisible();
  });

  test('"تنبيهاتي" without alerts points to the games', async ({ page, api }) => {
    signedIn(api);
    await page.goto('/account/alerts');
    await expect(page.getByText(pa.page.empty)).toBeVisible();
  });
});

for (const theme of ['dark', 'light'] as const) {
  test(`order help and alerts screenshots, ${theme} theme`, async ({ page, api }, testInfo) => {
    if (theme === 'light') {
      await page.addInitScript(() => localStorage.setItem('vertex-theme', 'light'));
    }
    signedIn(api).on(`GET /api/orders/${ORDER_ID}`, 200, order());
    await page.goto(`/orders/${ORDER_ID}`);
    await expect(page.getByTestId('problem-card')).toBeVisible();
    await page.getByTestId('problem-card').scrollIntoViewIfNeeded();
    await screenshot(page, testInfo, `order-problem-card-${theme}`);
    await page.getByRole('button', { name: oh.problems.not_arrived_waiting }).click();
    await expect(page.getByTestId('problem-sheet')).toBeVisible();
    await screenshot(page, testInfo, `order-problem-hint-${theme}`);
    await page.getByRole('button', { name: oh.hints.anyway }).click();
    await expect(page.getByRole('button', { name: oh.form.send })).toBeVisible();
    await screenshot(page, testInfo, `order-problem-form-${theme}`);

    api.on('GET /api/product-alerts?status=active', 200, { items: [alert({})] });
    api.on('GET /api/product-alerts?status=ended', 200, {
      items: [
        alert({
          id: id(12),
          status: 'sent',
          sentAt: '2026-10-24T10:00:00.000Z',
          endedAt: '2026-10-24T10:00:00.000Z',
          kind: 'price_drop',
          baselinePriceUsdUnits: 9_990_000,
          product: { id: id(72), nameAr: '660 UC', kind: 'direct' },
        }),
      ],
    });
    await page.goto('/account/alerts');
    await expect(page.getByRole('heading', { name: pa.page.active })).toBeVisible();
    await screenshot(page, testInfo, `alerts-page-${theme}`);

    api.on('GET /api/product-alerts', 200, { items: [alert({})] });
    await page.goto('/games/pubg-mobile');
    await page
      .locator('summary', { hasText: ar.game.unavailable.split(' (')[0] as string })
      .click();
    await expect(page.getByText(pa.button.availableSet)).toBeVisible();
    await screenshot(page, testInfo, `alert-button-${theme}`);
  });
}
