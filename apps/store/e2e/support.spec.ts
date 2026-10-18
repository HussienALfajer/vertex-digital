import type { Page } from '@playwright/test';
import type { Order, Ticket, TicketMessage, TicketSummary } from '@vertex-digital/contracts';
import ar from '../src/messages/ar.json' with { type: 'json' };
import { PUBG, pack } from './catalog';
import { EMPTY_STORE_URL } from './servers';
import { expect, type MockApi, screenshot, test } from './test';

/*
 * S12 on the store: the frozen banner and the disabled buy box, deposit wizard and player check;
 * the daily purchase cap's refusal; the footer's support links; `/support` signed out, empty and
 * with tickets; `/support/new` with its prefilled type and order, images and refusals; the thread
 * (open, closed within 7 days, closed beyond); a reply arriving live; the help button on the
 * order page. Against the mocked API; the Telegram link comes from the catalog server.
 */

const s = ar.support;
const fill = (text: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce(
    (result, [key, value]) => result.replace(`{${key}}`, `${value}`),
    text,
  );
const lightTheme = () => localStorage.setItem('vertex-theme', 'light');

const id = (n: number) => `0199f000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const TICKET_ID = id(1);
const OTHER_TICKET_ID = id(2);
const ORDER_ID = id(10);
const OLD_ORDER_ID = id(11);
const FILE_IDS = [id(20), id(21)];
const TELEGRAM_URL = 'https://t.me/vertex_support_test';
const USD = 1_000_000;

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const daysAgo = (days: number) => minutesAgo(days * 24 * 60);

function signedIn(api: MockApi, { frozen = false } = {}): MockApi {
  return api.on('GET /api/auth/get-session', 200, {
    user: {
      name: 'سارة الأحمد',
      email: 'sara@example.com',
      emailVerified: true,
      frozenAt: frozen ? '2026-10-10T08:00:00.000Z' : null,
    },
    session: { token: 'this-device' },
  });
}

function message(n: number, changes: Partial<TicketMessage> = {}): TicketMessage {
  return {
    id: id(100 + n),
    author: 'customer',
    body: 'طلبت 60 UC قبل ساعة ولم يصل الشحن إلى حسابي بعد.',
    attachments: [],
    createdAt: minutesAgo(90 - n),
    ...changes,
  };
}

const MESSAGES: TicketMessage[] = [
  message(1, { attachments: [FILE_IDS[0] as string] }),
  message(2, {
    author: 'admin',
    body: 'مرحباً سارة، راجعنا طلبك ووصل الشحن الآن.\nتحقّق من حسابك في اللعبة وأخبرنا إن احتجت شيئاً.',
    attachments: [FILE_IDS[1] as string],
  }),
];

function ticket(changes: Partial<Ticket> = {}): Ticket {
  return {
    id: TICKET_ID,
    number: 'VT-7KQ2MX',
    category: 'order',
    order: { id: ORDER_ID, number: 'VO-7KQ2MX' },
    deposit: null,
    subject: 'لم يصل شحن 60 UC',
    status: 'answered',
    openedBy: 'customer',
    lastAuthor: 'admin',
    lastMessageAt: minutesAgo(5),
    closedAt: null,
    closedBy: null,
    createdAt: minutesAgo(90),
    canReply: true,
    messages: MESSAGES,
    ...changes,
  };
}

const summary = ({ canReply: _c, messages: _m, ...rest }: Ticket): TicketSummary => rest;

const LIST: TicketSummary[] = [
  summary(ticket()),
  summary(
    ticket({
      id: OTHER_TICKET_ID,
      number: 'VT-ACC234',
      category: 'account',
      order: null,
      subject: 'تغيير رقم الهاتف',
      status: 'open',
      lastAuthor: 'customer',
      lastMessageAt: daysAgo(1),
    }),
  ),
  summary(
    ticket({
      id: id(3),
      number: 'VT-DEP567',
      category: 'deposit',
      order: null,
      deposit: { id: id(30), referenceCode: 'VD-7KQ2M' },
      subject: 'إيداع شام كاش',
      status: 'closed',
      lastAuthor: 'admin',
      lastMessageAt: daysAgo(3),
      closedAt: daysAgo(3),
      closedBy: 'customer',
    }),
  ),
];

/** The thread with its two images. */
function thread(api: MockApi, value: Ticket = ticket()): MockApi {
  api.on(`GET /api/support/tickets/${value.id}`, 200, value);
  for (const fileId of FILE_IDS)
    api.image(`GET /api/support/tickets/${value.id}/attachments/${fileId}`);
  return api;
}

const game = { id: id(80), slug: 'pubg-mobile', nameAr: 'ببجي موبايل', cover: null };

function orderSummary(orderId: string, number: string) {
  return {
    id: orderId,
    number,
    stage: 'delivered',
    productNameAr: '60 UC',
    game,
    quantity: 1,
    totalUsdUnits: 990_000,
    totalSypUnits: null,
    expiresAt: null,
    checkoutId: null,
    isGift: false,
    repeatable: false,
    createdAt: minutesAgo(60),
  };
}

function order(orderId: string, number: string): Order {
  return {
    id: orderId,
    number,
    stage: 'delivered',
    placedByStore: null,
    customerNote: null,
    product: { id: id(70), nameAr: '660 UC', kind: 'direct', regionAr: null, redemptionAr: null },
    game,
    fields: [{ key: 'player_id', labelAr: 'معرّف اللاعب', value: '5123456789' }],
    quantity: 1,
    deliveredQuantity: 1,
    refundedQuantity: 0,
    unitPriceUsdUnits: 9_900_000,
    totalUsdUnits: 9_900_000,
    totalSypUnits: null,
    refundedUsdUnits: 0,
    refundReason: null,
    timeline: [
      { step: 'paid', at: daysAgo(40) },
      { step: 'delivered', at: daysAgo(40) },
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
    createdAt: daysAgo(40),
  };
}

/** A small valid PNG, as a picked file. */
const png = (name: string, size?: number) => ({
  name,
  mimeType: 'image/png',
  buffer: size
    ? Buffer.alloc(size, 1)
    : Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64',
      ),
});

const imagesInput = (page: Page) => page.getByTestId('ticket-images').first();

const buyBox = (page: Page) =>
  page.getByRole('dialog').or(page.getByRole('complementary', { name: ar.game.buyBox }));

async function choose(page: Page, name: string) {
  await page.getByRole('button', { name: new RegExp(`^${name}`) }).click();
  await expect(buyBox(page).getByRole('heading', { name })).toBeVisible();
}

const p60 = pack(PUBG, '60 UC');

test.describe('frozen account (S12 CF5) and the purchase cap (LM4)', () => {
  test('the banner links to an account ticket; buying, the player check and depositing are off', async ({
    page,
    api,
  }) => {
    signedIn(api, { frozen: true }).on('GET /api/wallet', 200, {
      balanceUnits: 50 * USD,
      syp: null,
    });
    await page.goto('/');
    const banner = page.getByRole('status').filter({ hasText: ar.frozen.banner });
    await expect(banner).toBeVisible();
    await expect(banner.getByRole('link', { name: ar.frozen.contact })).toHaveAttribute(
      'href',
      '/support/new?category=account',
    );

    // No player check is mocked: one sent would fail the test.
    await page.goto('/games/pubg-mobile');
    await choose(page, '60 UC');
    await buyBox(page).getByLabel('معرّف اللاعب (ID)').fill('51234567');
    await page.waitForTimeout(1200);
    await expect(buyBox(page).getByText(ar.errors.ACCOUNT_FROZEN)).toBeVisible();
    await expect(buyBox(page).getByRole('button', { name: ar.purchase.continue })).toHaveCount(0);

    api
      .on('GET /api/deposits/sham-cash/options', 200, {
        state: 'available',
        pendingDepositId: null,
      })
      .on('GET /api/deposits/usdt/options', 200, { networks: [], pendingDepositId: null });
    await page.goto('/wallet/deposit');
    await expect(page.locator('main').getByText(ar.errors.ACCOUNT_FROZEN)).toBeVisible();
    await expect(
      page.locator('main').getByRole('link', { name: ar.frozen.contactButton }),
    ).toHaveAttribute('href', '/support/new?category=account');
  });

  test('an active customer sees no banner', async ({ page, api }) => {
    signedIn(api);
    await page.goto('/');
    await expect(page.locator('[data-signed-in]')).toBeVisible();
    await expect(page.getByText(ar.frozen.banner)).toHaveCount(0);
  });

  test('a purchase over the daily cap says what remains today', async ({ page, api }) => {
    signedIn(api)
      .on('GET /api/wallet', 200, { balanceUnits: 50 * USD, syp: null })
      .on('POST /api/player-checks', 200, { result: 'valid', playerName: 'Lina_99' })
      .on('POST /api/orders', 409, {
        code: 'PURCHASE_LIMIT_EXCEEDED',
        details: { limitUnits: 20 * USD, remainingUnits: 450_000 },
      });
    await page.goto(`/games/pubg-mobile?pack=${p60.id}`);
    await buyBox(page).getByLabel('معرّف اللاعب (ID)').fill('51234567');
    await expect(buyBox(page).getByText('Lina_99')).toBeVisible();
    await buyBox(page).getByRole('button', { name: ar.purchase.continue }).click();
    await buyBox(page).getByRole('slider').focus();
    await page.keyboard.press('End');
    await expect(
      buyBox(page).getByText(fill(ar.purchase.capExceeded, { remaining: '⁦$0.45⁩' })),
    ).toBeVisible();
  });
});

test.describe('support pages (S12)', () => {
  test('signed out: the Telegram card and footer link, and a sign-in prompt', async ({
    page,
    api,
  }) => {
    api.on('GET /api/support/tickets', 401, { code: 'UNAUTHORIZED' });
    await page.goto('/support');
    await expect(page.getByText(s.signedOut.title)).toBeVisible();
    await expect(
      page.locator('main').getByRole('link', { name: s.signedOut.action }),
    ).toHaveAttribute('href', '/sign-in?next=%2Fsupport');
    const card = page.locator('main').getByRole('link', { name: s.telegram.open });
    await expect(card).toHaveAttribute('href', TELEGRAM_URL);
    await expect(card).toHaveAttribute('target', '_blank');
    await expect(card).toHaveAttribute('rel', 'noopener noreferrer');
    const footer = page.locator('footer');
    await expect(
      footer.getByRole('link', { name: ar.footer.support, exact: true }),
    ).toHaveAttribute('href', '/support');
    const telegram = footer.getByRole('link', { name: ar.footer.telegram });
    await expect(telegram).toHaveAttribute('href', TELEGRAM_URL);
    await expect(telegram).toHaveAttribute('rel', 'noopener noreferrer');
  });

  test('without a Telegram link, it is hidden everywhere', async ({ page, api }) => {
    api.on('GET /api/support/tickets', 401, { code: 'UNAUTHORIZED' });
    await page.goto(`${EMPTY_STORE_URL}/support`);
    await expect(page.getByText(s.signedOut.title)).toBeVisible();
    await expect(
      page.locator('footer').getByRole('link', { name: ar.footer.support, exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: ar.footer.telegram })).toHaveCount(0);
    await expect(page.getByText(s.telegram.title)).toHaveCount(0);
  });

  test('signed in: empty, then the list with its chips, the reply dot and more', async ({
    page,
    api,
  }) => {
    signedIn(api).on('GET /api/support/tickets', 200, { items: [], nextCursor: null });
    await page.goto('/support');
    await expect(page.getByText(s.emptyTitle)).toBeVisible();
    await expect(page.locator('main').getByRole('link', { name: s.newTicket })).toHaveAttribute(
      'href',
      '/support/new',
    );

    api.on('GET /api/support/tickets', 200, { items: LIST.slice(0, 2), nextCursor: 'c2' });
    await page.reload();
    const cards = page.locator('main').getByRole('listitem');
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(0)).toContainText('VT-7KQ2MX');
    await expect(cards.nth(0)).toContainText(s.statuses.answered);
    await expect(cards.nth(0)).toContainText('VO-7KQ2MX');
    await expect(cards.nth(0).getByRole('img', { name: s.newReply })).toBeVisible();
    await expect(cards.nth(1)).toContainText(s.statuses.open);
    await expect(cards.nth(1)).toContainText(s.categories.account);
    await expect(cards.nth(1).getByRole('img', { name: s.newReply })).toHaveCount(0);
    await expect(cards.nth(0).getByRole('link')).toHaveAttribute('href', `/support/${TICKET_ID}`);

    api.on('GET /api/support/tickets', 200, { items: LIST.slice(2), nextCursor: null });
    await page.getByRole('button', { name: s.loadMore }).click();
    await expect(cards).toHaveCount(3);
    await expect(cards.nth(2)).toContainText(s.statuses.closed);
    expect(api.last('GET /api/support/tickets')).toBeTruthy();
    await expect(page.getByRole('button', { name: s.loadMore })).toHaveCount(0);
  });

  test('a list that cannot be read offers a retry', async ({ page, api }) => {
    signedIn(api).on('GET /api/support/tickets', 500, { code: 'INTERNAL_ERROR' });
    await page.goto('/support');
    await expect(page.getByText(s.loadFailed)).toBeVisible();
    api.on('GET /api/support/tickets', 200, { items: LIST, nextCursor: null });
    await page.getByRole('button', { name: s.retry }).click();
    await expect(page.locator('main').getByRole('listitem')).toHaveCount(3);
  });
});

test.describe('a new ticket (S12 TK1)', () => {
  test('prefilled from the link, with images checked one by one, sent as multipart', async ({
    page,
    api,
  }) => {
    signedIn(api)
      .on('GET /api/orders', 200, {
        items: [orderSummary(ORDER_ID, 'VO-7KQ2MX')],
        nextCursor: null,
      })
      .on(`GET /api/orders/${OLD_ORDER_ID}`, 200, order(OLD_ORDER_ID, 'VO-OLD234'));
    await page.goto(`/support/new?category=order&order=${OLD_ORDER_ID}`);
    // The type is chosen and the older order, not among the last 30, is listed first and picked.
    await expect(
      page.getByRole('button', { name: new RegExp(s.categories.order) }),
    ).toHaveAttribute('aria-pressed', 'true');
    const older = page.getByRole('radio', { name: /VO-OLD234/ });
    await expect(older).toBeChecked();
    await expect(page.getByRole('radio', { name: /VO-7KQ2MX/ })).not.toBeChecked();

    // Nothing typed yet: each field says what it needs.
    await page.getByRole('button', { name: s.new.submit }).click();
    await expect(page.getByText(s.validation.subject)).toBeVisible();
    await expect(page.getByText(s.validation.body)).toBeVisible();

    await page.getByLabel(s.new.subject).fill('لم يصل شحن 660 UC');
    await page.getByLabel(s.new.message).fill('طلبت قبل ساعة ولم يصل.');
    await expect(page.getByText('22 / 2000')).toBeVisible();
    await imagesInput(page).setInputFiles([
      png('one.png'),
      { name: 'doc.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') },
      png('big.png', 5 * 1024 * 1024 + 1),
      png('two.png'),
    ]);
    await expect(page.getByText(fill(s.images.invalid, { name: 'doc.pdf' }))).toBeVisible();
    await expect(page.getByText(fill(s.images.tooLarge, { name: 'big.png' }))).toBeVisible();
    await expect(page.getByRole('img', { name: fill(s.images.preview, { n: 2 }) })).toBeVisible();
    await page.getByRole('button', { name: fill(s.images.remove, { n: 2 }) }).click();
    await expect(page.getByRole('img', { name: fill(s.images.preview, { n: 2 }) })).toHaveCount(0);
    await imagesInput(page).setInputFiles([png('two.png'), png('three.png'), png('four.png')]);
    await expect(page.getByText(s.images.tooMany)).toBeVisible();
    await expect(page.getByRole('img', { name: fill(s.images.preview, { n: 3 }) })).toBeVisible();
    // Three images: no more to add.
    await expect(page.getByRole('button', { name: s.images.pick })).toHaveCount(0);

    const opened = ticket({
      order: { id: OLD_ORDER_ID, number: 'VO-OLD234' },
      subject: 'لم يصل شحن 660 UC',
      status: 'open',
      lastAuthor: 'customer',
      messages: [message(1, { body: 'طلبت قبل ساعة ولم يصل.', attachments: FILE_IDS })],
    });
    api.on('POST /api/support/tickets', 201, opened);
    thread(api, opened);
    await page.getByRole('button', { name: s.new.submit }).click();
    await expect(page).toHaveURL(`/support/${TICKET_ID}`);
    const sent = api.last('POST /api/support/tickets');
    expect(sent?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent?.headers['x-altcha']).toBeTruthy();
    expect(sent?.headers['content-type']).toContain('multipart/form-data');
    const body = String(sent?.body);
    expect(body).toContain('name="category"\r\n\r\norder');
    expect(body).toContain(`name="orderId"\r\n\r\n${OLD_ORDER_ID}`);
    expect(body).not.toContain('name="depositId"');
    expect(body.match(/name="files"/g)).toHaveLength(3);
    await expect(
      page.getByRole('region', { name: s.ticket.conversation }).getByText('طلبت قبل ساعة ولم يصل.'),
    ).toBeVisible();
  });

  test('refusals keep the values and link to the open ticket or the list', async ({
    page,
    api,
  }) => {
    signedIn(api).on('POST /api/support/tickets', 409, {
      code: 'TICKET_ALREADY_OPEN',
      details: { ticketId: OTHER_TICKET_ID },
    });
    await page.goto('/support/new');
    await page.getByRole('button', { name: new RegExp(s.categories.account) }).click();
    await page.getByLabel(s.new.subject).fill('تغيير رقم الهاتف');
    await page.getByLabel(s.new.message).fill('أريد تغيير رقم هاتفي.');
    await page.getByRole('button', { name: s.new.submit }).click();
    const alert = page.getByRole('alert').filter({ hasText: ar.errors.TICKET_ALREADY_OPEN });
    await expect(alert).toBeVisible();
    await expect(alert.getByRole('link', { name: s.new.openExisting })).toHaveAttribute(
      'href',
      `/support/${OTHER_TICKET_ID}`,
    );
    await expect(page.getByLabel(s.new.subject)).toHaveValue('تغيير رقم الهاتف');
    const firstKey = api.last('POST /api/support/tickets')?.headers['idempotency-key'];

    api.on('POST /api/support/tickets', 409, {
      code: 'TICKETS_LIMIT_REACHED',
      details: { limit: 'open' },
    });
    await page.getByRole('button', { name: s.new.submit }).click();
    const limit = page.getByRole('alert').filter({ hasText: ar.errors.TICKETS_LIMIT_REACHED });
    await expect(limit.getByRole('link', { name: s.new.openTickets })).toHaveAttribute(
      'href',
      '/support',
    );
    await expect(page.getByLabel(s.new.message)).toHaveValue('أريد تغيير رقم هاتفي.');
    // The same body is the same attempt: the same key.
    expect(api.last('POST /api/support/tickets')?.headers['idempotency-key']).toBe(firstKey);
  });

  test('signed out, the form asks to sign in first', async ({ page, api: _api }) => {
    await page.goto('/support/new?category=account');
    await expect(page).toHaveURL(
      `/sign-in?next=${encodeURIComponent('/support/new?category=account')}`,
    );
  });
});

test.describe('a ticket’s thread (S12 TK3–TK7)', () => {
  test('the team’s reply under the store’s name, images full size, a reply with an image, and closing', async ({
    page,
    api,
  }) => {
    thread(signedIn(api));
    await page.goto(`/support/${TICKET_ID}`);
    await expect(page.getByRole('heading', { name: 'لم يصل شحن 60 UC' })).toBeVisible();
    await expect(page.getByText('VT-7KQ2MX')).toBeVisible();
    await expect(page.getByRole('link', { name: 'VO-7KQ2MX' })).toHaveAttribute(
      'href',
      `/orders/${ORDER_ID}`,
    );
    const bubbles = page.locator('main ol > li');
    await expect(bubbles).toHaveCount(2);
    await expect(bubbles.nth(0)).toContainText(s.ticket.you);
    await expect(bubbles.nth(1)).toContainText(s.ticket.team);
    // Plain text, new lines kept, never a link.
    await expect(bubbles.nth(1).getByRole('link')).toHaveCount(0);
    // The customer's bubble on the start side (the right in RTL), the team's on the end side.
    const [mine, theirs] = await Promise.all([
      bubbles.nth(0).boundingBox(),
      bubbles.nth(1).boundingBox(),
    ]);
    expect((mine?.x ?? 0) + (mine?.width ?? 0)).toBeGreaterThan(
      (theirs?.x ?? 0) + (theirs?.width ?? 0),
    );

    await bubbles
      .nth(1)
      .getByRole('button', { name: fill(s.ticket.imageOpen, { n: 1 }) })
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('img', { name: fill(s.ticket.image, { n: 1 }) })).toBeVisible();
    await dialog.getByRole('button', { name: s.ticket.imageClose }).click();
    await expect(dialog).toHaveCount(0);

    // An image only: the body is filled for it (TK7).
    const replied = ticket({
      status: 'open',
      lastAuthor: 'customer',
      messages: [...MESSAGES, message(3, { body: s.images.attached, attachments: [id(22)] })],
    });
    api
      .on(`POST /api/support/tickets/${TICKET_ID}/messages`, 201, replied)
      .image(`GET /api/support/tickets/${TICKET_ID}/attachments/${id(22)}`);
    await imagesInput(page).setInputFiles([png('reply.png')]);
    await page.getByRole('button', { name: s.ticket.send }).click();
    await expect(bubbles).toHaveCount(3);
    await expect(page.getByText(s.statuses.open)).toBeVisible();
    const sent = api.last(`POST /api/support/tickets/${TICKET_ID}/messages`);
    expect(sent?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(String(sent?.body)).toContain(`name="body"\r\n\r\n${s.images.attached}`);
    expect(String(sent?.body).match(/name="files"/g)).toHaveLength(1);

    // Closing asks first; a closed ticket within 7 days still takes a reply that reopens it.
    api.on(`POST /api/support/tickets/${TICKET_ID}/close`, 200, {
      ...replied,
      status: 'closed',
      closedAt: new Date().toISOString(),
      closedBy: 'customer',
    });
    await page.getByRole('button', { name: s.ticket.close }).click();
    await expect(page.getByRole('alertdialog')).toContainText(s.ticket.closeBody);
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: s.ticket.closeConfirm })
      .click();
    await expect(page.getByText(s.ticket.reopenNote)).toBeVisible();
    await expect(page.getByText(s.statuses.closed)).toBeVisible();
    await expect(page.getByRole('button', { name: s.ticket.close })).toHaveCount(0);
  });

  test('closed more than 7 days ago: a new ticket with the same type and order', async ({
    page,
    api,
  }) => {
    thread(
      signedIn(api),
      ticket({ status: 'closed', closedAt: daysAgo(10), closedBy: 'system', canReply: false }),
    );
    await page.goto(`/support/${TICKET_ID}`);
    await expect(page.getByText(s.ticket.closedTitle)).toBeVisible();
    await expect(page.getByText(s.ticket.autoClosed)).toBeVisible();
    await expect(page.getByRole('link', { name: s.ticket.newTicket })).toHaveAttribute(
      'href',
      `/support/new?category=order&order=${ORDER_ID}`,
    );
    await expect(page.getByLabel(s.ticket.reply)).toHaveCount(0);
  });

  test('a reply past the 7 days answers TICKET_CLOSED and the page offers a new ticket', async ({
    page,
    api,
  }) => {
    thread(signedIn(api), ticket({ status: 'closed', closedAt: daysAgo(6), closedBy: 'customer' }));
    await page.goto(`/support/${TICKET_ID}`);
    await expect(page.getByText(s.ticket.reopenNote)).toBeVisible();
    api
      .on(`POST /api/support/tickets/${TICKET_ID}/messages`, 409, { code: 'TICKET_CLOSED' })
      .on(
        `GET /api/support/tickets/${TICKET_ID}`,
        200,
        ticket({ status: 'closed', closedAt: daysAgo(8), closedBy: 'customer', canReply: false }),
      );
    await page.getByLabel(s.ticket.reply).fill('هل من جديد؟');
    await page.getByRole('button', { name: s.ticket.send }).click();
    await expect(page.getByText(s.ticket.closedTitle)).toBeVisible();
  });

  test('another customer’s ticket is the not-found page', async ({ page, api }) => {
    signedIn(api).on(`GET /api/support/tickets/${OTHER_TICKET_ID}`, 404, { code: 'NOT_FOUND' });
    await page.goto(`/support/${OTHER_TICKET_ID}`);
    await expect(page.getByText(ar.notFound.title)).toBeVisible();
  });

  test('a reply from the team arrives live', async ({ page, api }) => {
    thread(
      signedIn(api),
      ticket({ status: 'open', lastAuthor: 'customer', messages: [message(1)] }),
    );
    api.stream(
      'GET /api/notifications/stream',
      [
        { event: 'unread', data: { unreadCount: 0 } },
        {
          event: 'notification',
          data: {
            notification: {
              id: id(200),
              event: 'ticket_replied',
              params: { ticketId: TICKET_ID, number: 'VT-7KQ2MX' },
              readAt: null,
              createdAt: new Date().toISOString(),
            },
            unreadCount: 1,
          },
        },
      ],
      1500,
    );
    await page.goto(`/support/${TICKET_ID}`);
    await expect(page.locator('main ol > li')).toHaveCount(1);
    thread(api);
    await expect(page.locator('main ol > li')).toHaveCount(2);
    await expect(page.getByText(s.ticket.team)).toBeVisible();
  });
});

test.describe('"تحتاج مساعدة؟" on the order page', () => {
  test('opens the open ticket about the order, else a new one about it', async ({ page, api }) => {
    signedIn(api)
      .on(`GET /api/orders/${ORDER_ID}`, 200, order(ORDER_ID, 'VO-7KQ2MX'))
      .on('GET /api/support/tickets', 200, { items: LIST, nextCursor: null });
    thread(api);
    await page.goto(`/orders/${ORDER_ID}`);
    await page.getByRole('button', { name: s.help }).click();
    await expect(page).toHaveURL(`/support/${TICKET_ID}`);
    expect(api.last('GET /api/support/tickets')).toBeTruthy();

    api
      .on('GET /api/support/tickets', 200, { items: LIST.slice(1), nextCursor: null })
      .on('GET /api/orders', 200, {
        items: [orderSummary(ORDER_ID, 'VO-7KQ2MX')],
        nextCursor: null,
      });
    await page.goto(`/orders/${ORDER_ID}`);
    await page.getByRole('button', { name: s.help }).click();
    await expect(page).toHaveURL(`/support/new?category=order&order=${ORDER_ID}`);
    await expect(page.getByRole('radio', { name: /VO-7KQ2MX/ })).toBeChecked();
  });
});

test('"تحتاج مساعدة؟" on a deposit page opens a deposit ticket with the deposit chosen', async ({
  page,
  api,
}) => {
  const depositId = id(30);
  const deposit = {
    id: depositId,
    method: 'sham_cash',
    status: 'rejected',
    referenceCode: 'VD-7KQ2M',
    currency: 'USD',
    declaredAmountUnits: 25 * USD,
    declaredUsdUnits: 25 * USD,
    quote: null,
    expiresAt: daysAgo(-1),
    createdAt: daysAgo(1),
    submittedAt: daysAgo(1),
    decidedAt: daysAgo(1),
    rateFixed: false,
    receiptRequest: null,
    payTo: null,
    eta: null,
    credited: null,
    rejection: { reason: 'receipt_invalid', note: null },
    usdt: null,
  };
  signedIn(api)
    .on(`GET /api/deposits/${depositId}`, 200, deposit)
    .on('GET /api/support/tickets', 200, { items: [], nextCursor: null })
    .on('GET /api/deposits', 200, { items: [deposit], nextCursor: null });
  await page.goto(`/wallet/deposits/${depositId}`);
  await page.getByRole('button', { name: s.help }).click();
  await expect(page).toHaveURL(`/support/new?category=deposit&deposit=${depositId}`);
  const choice = page.getByRole('radio', { name: /VD-7KQ2M/ });
  await expect(choice).toBeChecked();
  await expect(page.getByRole('radiogroup').getByText(ar.deposits.statuses.rejected)).toBeVisible();
});

// RTL screenshots, dark and light, at phone width and desktop.
for (const theme of ['dark', 'light'] as const) {
  test(`support screenshots, ${theme} theme`, async ({ page, api }, testInfo) => {
    if (theme === 'light') await page.addInitScript(lightTheme);
    signedIn(api).on('GET /api/support/tickets', 200, { items: LIST, nextCursor: null });
    await page.goto('/support');
    await expect(page.locator('main').getByRole('listitem')).toHaveCount(3);
    await screenshot(page, testInfo, `s12-support-${theme}`);

    api.on('GET /api/support/tickets', 200, { items: [], nextCursor: null });
    await page.reload();
    await expect(page.getByText(s.emptyTitle)).toBeVisible();
    await screenshot(page, testInfo, `s12-support-empty-${theme}`);

    api.on('GET /api/orders', 200, {
      items: [orderSummary(ORDER_ID, 'VO-7KQ2MX'), orderSummary(OLD_ORDER_ID, 'VO-OLD234')],
      nextCursor: null,
    });
    await page.goto(`/support/new?category=order&order=${ORDER_ID}`);
    await expect(page.getByRole('radio', { name: /VO-7KQ2MX/ })).toBeChecked();
    await page.getByLabel(s.new.subject).fill('لم يصل شحن 60 UC');
    await page.getByLabel(s.new.message).fill('طلبت قبل ساعة ولم يصل.');
    await imagesInput(page).setInputFiles([png('one.png'), png('two.png')]);
    await expect(page.getByRole('img', { name: fill(s.images.preview, { n: 2 }) })).toBeVisible();
    await screenshot(page, testInfo, `s12-support-new-${theme}`);

    thread(api);
    await page.goto(`/support/${TICKET_ID}`);
    await expect(page.locator('main ol > li')).toHaveCount(2);
    await screenshot(page, testInfo, `s12-ticket-open-${theme}`);

    thread(api, ticket({ status: 'closed', closedAt: daysAgo(2), closedBy: 'customer' }));
    await page.reload();
    await expect(page.getByText(s.ticket.reopenNote)).toBeVisible();
    await screenshot(page, testInfo, `s12-ticket-closed-${theme}`);

    thread(
      api,
      ticket({ status: 'closed', closedAt: daysAgo(10), closedBy: 'system', canReply: false }),
    );
    await page.reload();
    await expect(page.getByText(s.ticket.closedTitle)).toBeVisible();
    await screenshot(page, testInfo, `s12-ticket-closed-old-${theme}`);

    signedIn(api, { frozen: true }).on('GET /api/wallet', 200, {
      balanceUnits: 50 * USD,
      syp: null,
    });
    await page.goto(`/games/pubg-mobile?pack=${p60.id}`);
    await expect(buyBox(page).getByText(ar.errors.ACCOUNT_FROZEN)).toBeVisible();
    await screenshot(page, testInfo, `s12-frozen-buy-box-${theme}`);

    api
      .on('GET /api/deposits/sham-cash/options', 200, {
        state: 'available',
        pendingDepositId: null,
      })
      .on('GET /api/deposits/usdt/options', 200, { networks: [], pendingDepositId: null });
    await page.goto('/wallet/deposit');
    await expect(page.getByRole('status').filter({ hasText: ar.frozen.banner })).toBeVisible();
    await expect(page.locator('main').getByText(ar.errors.ACCOUNT_FROZEN)).toBeVisible();
    await screenshot(page, testInfo, `s12-frozen-deposit-${theme}`);
  });
}
