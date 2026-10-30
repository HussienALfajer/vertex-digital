import type { Page } from '@playwright/test';
import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import { CUSTOMER_IDS, TICKET_IDS } from './customers-mock';
import { quietDashboard } from './dashboard-mock';
import { type AdminApi, chooseOption, expect, PASSWORD, screenshot, TOTP_CODE, test } from './test';

/*
 * Support (S12 F23): the queue's tabs, filters and badge (TK12, TK13), a thread with its images
 * and plain customer text, a reply with an image (Ctrl+Enter, `Idempotency-Key`), closing and
 * reopening by a reply, a ticket opened to a customer from the profile (TK2) with its refusal,
 * and the support settings (SC1), against the mocked API.
 */

const s = ar.support;

const fill = (text: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce(
    (result, [key, value]) => result.replace(`{{${key}}}`, String(value)),
    text,
  );

/** A 1×1 PNG, the image the specs attach. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
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

const attach = (page: Page, name: string) =>
  page.locator('input[type="file"]').setInputFiles({ name, mimeType: 'image/png', buffer: PNG });

test.describe('the queue (TK12, TK13)', () => {
  test('opens on the tickets waiting for the admin, with tabs, filters and the badge', async ({
    page,
    admin,
  }) => {
    await open(page, admin, '/support');
    await expect(page.getByLabel(fill(ar.nav.supportBadge, { open: 1 })).first()).toHaveText('1');
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('VT-7KQ2MX');
    await expect(rows(page).first()).toContainText('VO-HELD23');

    await page.getByRole('tab', { name: s.tabs.answered }).click();
    await expect(page).toHaveURL(/status=answered/);
    await expect(rows(page)).toHaveCount(1);
    // The frozen chip beside the customer (TK12).
    await expect(rows(page).first()).toContainText(ar.customers.chips.frozen);

    await page.getByRole('tab', { name: s.tabs.closed }).click();
    await expect(rows(page)).toHaveCount(1);
    await page.getByRole('tab', { name: s.tabs.all }).click();
    await expect(rows(page)).toHaveCount(3);

    await page.getByRole('combobox', { name: s.filters.category }).click();
    await page.getByRole('option', { name: s.categories.other }).click();
    await expect(page).toHaveURL(/category=other/);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('VT-5CN8DR');

    await page.getByRole('combobox', { name: s.filters.category }).click();
    await page.getByRole('option', { name: s.filters.allCategories }).click();
    await page.getByRole('searchbox', { name: s.filters.search }).fill('vt-3hwx');
    await page.getByRole('button', { name: s.filters.submit }).click();
    await expect(page).toHaveURL(/q=vt-3hwx/);
    await expect(rows(page)).toHaveCount(1);

    await page.getByRole('tab', { name: s.tabs.closed }).click();
    await expect(page.getByText(s.empty.filtered)).toBeVisible();

    await page.goto('/support');
    await rows(page).first().click();
    await expect(page).toHaveURL(`/support/${TICKET_IDS.waiting}`);
  });

  test('shows the order problem as a chip, filters by it and names it in the thread (S22 OP6)', async ({
    page,
    admin,
  }) => {
    await open(page, admin, '/support?status=all');
    await expect(rows(page).first()).toContainText(s.problems.not_arrived);
    await page.getByRole('combobox', { name: s.filters.problem }).click();
    await page.getByRole('option', { name: s.problems.not_arrived }).click();
    await expect(page).toHaveURL(/problem=not_arrived/);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText('VT-7KQ2MX');
    await page.getByRole('combobox', { name: s.filters.problem }).click();
    await page.getByRole('option', { name: s.problems.code_used }).click();
    await expect(page.getByText(s.empty.filtered)).toBeVisible();

    await page.goto(`/support/${TICKET_IDS.waiting}`);
    await expect(page.getByText(s.side.problem)).toBeVisible();
    await expect(page.getByText(s.problems.not_arrived).first()).toBeVisible();
  });

  test("names a merchant's tier in the queue and the thread (S23 OP2)", async ({ page, admin }) => {
    const waiting = admin.customers.tickets.find((item) => item.id === TICKET_IDS.waiting);
    const owner = waiting && admin.customers.find(waiting.customerId);
    if (!owner) throw new Error('No waiting ticket');
    owner.tier = 'gold';
    await open(page, admin, '/support');
    await expect(rows(page).first()).toContainText(ar.merchants.tierNames.gold);
    await page.goto(`/support/${TICKET_IDS.waiting}`);
    await expect(page.getByText(ar.merchants.tierNames.gold).first()).toBeVisible();
  });

  test('is empty per tab', async ({ page, admin }) => {
    admin.customers.tickets = admin.customers.tickets.filter((ticket) => ticket.status !== 'open');
    await open(page, admin, '/support');
    await expect(page.getByText(s.empty.open)).toBeVisible();
  });
});

test.describe('a thread (TK3–TK11)', () => {
  test('shows plain customer text and images, replies with an image by Ctrl+Enter', async ({
    page,
    admin,
  }) => {
    await open(page, admin, `/support/${TICKET_IDS.waiting}`);
    await expect(page.getByText('هذا رابط الطلب: https://example.com/order')).toBeVisible();
    // TK7: a URL in customer text is never a link.
    await expect(page.getByRole('link', { name: /example\.com/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'VO-HELD23' })).toBeVisible();

    await page.getByRole('button', { name: fill(s.thread.openImage, { n: 2 }) }).click();
    const viewer = page.getByRole('dialog');
    await expect(
      viewer.getByRole('img', { name: fill(s.thread.imageAlt, { n: 2 }) }),
    ).toBeVisible();
    await page.keyboard.press('Escape');

    await page
      .getByRole('textbox', { name: s.reply.label })
      .fill('وصلت الباقة الآن، نعتذر عن التأخير.');
    await attach(page, 'proof.png');
    await expect(page.getByRole('img', { name: fill(s.images.preview, { n: 1 }) })).toBeVisible();
    await page.getByRole('textbox', { name: s.reply.label }).press('Control+Enter');
    await expect(page.getByText('وصلت الباقة الآن، نعتذر عن التأخير.')).toBeVisible();
    await expect(page.getByRole('textbox', { name: s.reply.label })).toHaveValue('');
    await expect(page.getByText(s.statuses.answered).first()).toBeVisible();
    const sent = admin.requests.findLast((request) => request.key.endsWith('/messages'));
    expect(sent?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent?.headers['content-type']).toMatch(/^multipart\/form-data/);
    // The new reply's image and the side panel's history.
    await expect(
      page.getByRole('button', { name: fill(s.thread.openImage, { n: 1 }) }),
    ).toHaveCount(2);
    await expect(page.getByText(ar.audit.actions['ticket.replied'])).toBeVisible();
    // The badge follows: nothing waits for the admin now.
    await expect(page.getByLabel(fill(ar.nav.supportBadge, { open: 1 }))).toHaveCount(0);
  });

  test('refuses an empty reply and sends images only as "صورة مرفقة"', async ({ page, admin }) => {
    await open(page, admin, `/support/${TICKET_IDS.answered}`);
    await page.getByRole('button', { name: s.reply.send }).click();
    await expect(page.getByText(s.reply.bodyError)).toBeVisible();
    await attach(page, 'screen.png');
    await page.getByRole('button', { name: s.reply.send }).click();
    await expect(page.getByText(s.reply.imageOnly, { exact: true })).toBeVisible();
  });

  test('sends the same words twice as two messages with two keys', async ({ page, admin }) => {
    await open(page, admin, `/support/${TICKET_IDS.answered}`);
    const box = page.getByRole('textbox', { name: s.reply.label });
    for (const _ of [1, 2]) {
      await box.fill('هل ما زالت المشكلة قائمة؟');
      await page.getByRole('button', { name: s.reply.send }).click();
      await expect(box).toHaveValue('');
    }
    await expect(page.getByText('هل ما زالت المشكلة قائمة؟', { exact: true })).toHaveCount(2);
    const keys = admin.requests
      .filter((request) => request.key.endsWith('/messages'))
      .map((request) => request.headers['idempotency-key']);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  test('closes after a confirm, and a reply reopens it', async ({ page, admin }) => {
    await open(page, admin, `/support/${TICKET_IDS.answered}`);
    await page.getByRole('button', { name: s.thread.close }).click();
    // A07-45: the confirmation names the ticket.
    await expect(
      page
        .getByRole('alertdialog')
        .getByText(fill(s.thread.closeBody, { number: '\u2066VT-3HWX9P\u2069' })),
    ).toBeVisible();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: s.thread.closeConfirm })
      .click();
    await expect(page.getByText(s.statuses.closed).first()).toBeVisible();
    await expect(page.getByText(s.reply.reopens)).toBeVisible();
    await page
      .getByRole('textbox', { name: s.reply.label })
      .fill('أعدنا فتح التذكرة لمتابعة طلبك.');
    await page.getByRole('button', { name: s.reply.send }).click();
    await expect(page.getByText(s.reply.reopens)).toHaveCount(0);
    await expect(page.getByText(s.statuses.answered).first()).toBeVisible();
  });
});

test('opens a ticket to a customer from the profile, refused while the order has one', async ({
  page,
  admin,
}) => {
  await open(page, admin, `/customers/${CUSTOMER_IDS.sara}`);
  await page.getByRole('button', { name: ar.customers.actions.menu }).click();
  await page.getByRole('menuitem', { name: ar.customers.actions.ticket }).click();
  await expect(page).toHaveURL(`/support/new?customer=${CUSTOMER_IDS.sara}`);
  await expect(page.getByText(fill(s.new.subtitle, { name: 'سارة الأحمد' }))).toBeVisible();

  await page.getByRole('button', { name: s.new.submit }).click();
  await expect(page.getByText(s.new.linkError)).toBeVisible();
  await expect(page.getByText(s.new.subjectError)).toBeVisible();

  await page.getByRole('combobox', { name: s.new.order }).click();
  await page.getByRole('option', { name: /VO-HELD23/ }).click();
  await page.getByLabel(s.new.subject).fill('بخصوص طلبك الأخير');
  await page.getByLabel(s.new.body).fill('نحتاج صورة لمعرّف اللاعب للتحقق.');
  await attach(page, 'example.png');
  await page.getByRole('button', { name: s.new.submit }).click();
  await expect(page.getByText(ar.errors.api.TICKET_ALREADY_OPEN)).toBeVisible();
  await expect(page.getByRole('link', { name: s.new.existing })).toHaveAttribute(
    'href',
    `/support/${TICKET_IDS.waiting}`,
  );
  // The values stay after the refusal.
  await expect(page.getByLabel(s.new.subject)).toHaveValue('بخصوص طلبك الأخير');

  await page.getByRole('combobox', { name: s.new.order }).click();
  await page.getByRole('option', { name: /VO-BACK89/ }).click();
  await page.getByRole('button', { name: s.new.submit }).click();
  await expect(page).toHaveURL(/\/support\/[0-9a-f-]{36}$/);
  await expect(page.getByText('نحتاج صورة لمعرّف اللاعب للتحقق.')).toBeVisible();
  await expect(page.getByText(s.statuses.answered).first()).toBeVisible();
  await expect(page.getByText(s.openedByAdmin).first()).toBeVisible();
  const sent = admin.requests.findLast(
    (request) => request.key === 'POST /api/admin/support/tickets',
  );
  expect(sent?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
});

test('sets the Telegram support link with validation, preview and re-authentication', async ({
  page,
  admin,
}) => {
  admin.reauthenticationRequired = true;
  await open(page, admin, '/settings/support');
  await expect(page.getByText(s.settings.previewEmpty)).toBeVisible();
  const field = page.getByLabel(s.settings.telegram);
  await field.fill('https://telegram.me/vertex');
  await page.getByRole('button', { name: s.settings.save }).click();
  await expect(page.getByText(s.settings.telegramError).first()).toBeVisible();
  await field.fill('https://t.me/vertex_support');
  await expect(
    page.getByRole('link', { name: new RegExp(s.settings.previewLabel) }),
  ).toHaveAttribute('href', 'https://t.me/vertex_support');
  await page.getByRole('button', { name: s.settings.save }).click();
  await reauthenticate(page);
  await expect(page.getByText(s.settings.saved)).toBeVisible();
  expect(admin.customers.settings).toEqual({ telegramUrl: 'https://t.me/vertex_support' });

  await field.fill('');
  await page.getByRole('button', { name: s.settings.save }).click();
  await expect(page.getByText(s.settings.saved)).toBeVisible();
  expect(admin.customers.settings).toEqual({ telegramUrl: null });
});

test.describe('audit A07', () => {
  const failing = { statusCode: 500, code: 'INTERNAL_ERROR', message: 'x' };

  test('the open thread reads again every minute in the background, keeping a typed reply (A07-10)', async ({
    page,
    admin,
  }) => {
    await page.clock.install();
    await open(page, admin, `/support/${TICKET_IDS.waiting}`);
    const box = page.getByRole('textbox', { name: s.reply.label });
    await box.fill('نتحقق الآن من طلبك.');
    const ticket = admin.customers.tickets.find((item) => item.id === TICKET_IDS.waiting);
    if (!ticket) throw new Error('No waiting ticket');
    ticket.messages.push({
      id: crypto.randomUUID(),
      author: 'customer',
      body: 'هل من جديد بخصوص طلبي؟',
      attachments: [],
      createdAt: new Date().toISOString(),
    });
    await page.clock.fastForward(61_000);
    await expect(page.getByText('هل من جديد بخصوص طلبي؟')).toBeVisible();
    await expect(box).toHaveValue('نتحقق الآن من طلبك.');
    const reads = admin.requests.filter(
      (request) => request.key === `GET /api/admin/support/tickets/${TICKET_IDS.waiting}`,
    );
    expect(reads[0]?.headers['x-background-request']).toBeUndefined();
    expect(reads.at(-1)?.headers['x-background-request']).toBe('1');

    // The customer closes it meanwhile: the tab seen again shows it, the reply still typed.
    Object.assign(ticket, {
      status: 'closed',
      closedAt: new Date().toISOString(),
      closedBy: 'customer',
    });
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.getByText(s.reply.reopens)).toBeVisible();
    await expect(box).toHaveValue('نتحقق الآن من طلبك.');
  });

  test('the queue reads again in the background when the tab is seen again (A07-10)', async ({
    page,
    admin,
  }) => {
    await open(page, admin, '/support');
    await expect(rows(page)).toHaveCount(1);
    const answered = admin.customers.tickets.find((item) => item.id === TICKET_IDS.answered);
    if (answered) answered.status = 'open';
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(rows(page)).toHaveCount(2);
    const read = admin.requests.findLast(
      (request) => request.key === 'GET /api/admin/support/tickets',
    );
    expect(read?.headers['x-background-request']).toBe('1');
  });

  test('dims the previous rows while another tab loads (A07-15)', async ({ page, admin }) => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/api\/admin\/support\/tickets\?.*status=answered/, async (route) => {
      await held;
      await route.fallback();
    });
    await open(page, admin, '/support');
    await expect(rows(page)).toHaveCount(1);
    await page.getByRole('tab', { name: s.tabs.answered }).click();
    await expect(page.getByRole('table')).toHaveAttribute('aria-busy', 'true');
    release();
    await expect(page.getByRole('table')).toHaveAttribute('aria-busy', 'false');
    await expect(rows(page).first()).toContainText('VT-3HWX9P');
  });

  test('the customer filter names the customer, from the rows or the profile (A07-44)', async ({
    page,
    admin,
  }) => {
    await open(page, admin, `/support?status=all&customerId=${CUSTOMER_IDS.sara}`);
    await expect(
      page.getByText(fill(s.filters.customerChip, { name: 'سارة الأحمد' })),
    ).toBeVisible();
    // No ticket of this customer: the name comes from the profile.
    await page.goto(`/support?status=all&customerId=${CUSTOMER_IDS.omar}`);
    await expect(
      page.getByText(fill(s.filters.customerChip, { name: 'عمر الخطيب' })),
    ).toBeVisible();
    await page.getByRole('button', { name: s.filters.clearCustomer }).click();
    await expect(page).not.toHaveURL(/customerId=/);
  });

  test('the merchant applications waiting show as a badge (A07-12)', async ({ page, admin }) => {
    admin.dashboard = {
      ...quietDashboard(admin.rates[0] ?? null),
      attention: [
        {
          kind: 'merchant_applications_waiting',
          count: 2,
          oldestAt: new Date().toISOString(),
          target: '/merchants/applications',
          params: {},
          orders: [],
        },
      ],
    };
    await open(page, admin, '/support');
    await expect(
      page.getByLabel(fill(ar.nav.merchantApplicationsBadge, { waiting: 2 })).first(),
    ).toHaveText('2');
  });

  test('a failed thread read offers a retry; an unknown ticket only the way back (A07-18, A07-47)', async ({
    page,
    admin,
  }) => {
    let fail = true;
    await page.route(`**/api/admin/support/tickets/${TICKET_IDS.answered}`, (route) =>
      fail ? route.fulfill({ status: 500, json: failing }) : route.fallback(),
    );
    await open(page, admin, `/support/${TICKET_IDS.answered}`);
    await expect(page.getByText(ar.errors.generic)).toBeVisible({ timeout: 10_000 });
    fail = false;
    await page.getByRole('button', { name: ar.common.retry }).click();
    await expect(page.getByText('تظهر لي رسالة أن الحساب موقوف.')).toBeVisible();

    await page.goto('/support/0199c000-0000-7000-8000-00000000ffff');
    await expect(page.getByText(s.thread.notFound)).toBeVisible();
    await expect(page.getByRole('button', { name: ar.common.retry })).toHaveCount(0);
    await expect(
      page.getByRole('main').getByRole('link', { name: s.thread.back }).last(),
    ).toHaveAttribute('href', '/support');
  });

  test('an archived customer’s ticket explains that replies are refused (Q28, A07-20)', async ({
    page,
    admin,
  }) => {
    const rami = admin.customers.find(CUSTOMER_IDS.rami);
    if (rami) rami.archivedAt = new Date().toISOString();
    await open(page, admin, `/support/${TICKET_IDS.answered}`);
    await expect(page.getByText(s.reply.archivedTitle)).toBeVisible();
    await expect(page.getByText(s.reply.archivedBody)).toBeVisible();
    await expect(page.getByRole('textbox', { name: s.reply.label })).toHaveCount(0);
  });

  test('the refused images go once the reply is sent (A07-52)', async ({ page, admin }) => {
    await open(page, admin, `/support/${TICKET_IDS.answered}`);
    await page.getByRole('textbox', { name: s.reply.label }).fill('أرفقنا لقطة الشاشة.');
    await page.locator('input[type="file"]').setInputFiles([
      { name: 'proof.png', mimeType: 'image/png', buffer: PNG },
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('x') },
    ]);
    const refused = page.getByText(fill(s.images.badType, { name: 'notes.txt' }));
    await expect(refused).toBeVisible();
    await page.getByRole('button', { name: s.reply.send }).click();
    await expect(page.getByRole('textbox', { name: s.reply.label })).toHaveValue('');
    await expect(refused).toHaveCount(0);
  });

  test('a failed read of the orders offers a retry inside the link field (A07-14)', async ({
    page,
    admin,
  }) => {
    let fail = true;
    await page.route(/\/api\/admin\/orders\?/, (route) =>
      fail ? route.fulfill({ status: 500, json: failing }) : route.fallback(),
    );
    await open(page, admin, `/support/new?customer=${CUSTOMER_IDS.sara}`);
    const retry = page.getByRole('button', { name: ar.common.retry });
    await expect(retry).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: s.new.submit }).click();
    await expect(page.getByText(s.new.linkError)).toBeVisible();
    await expect(retry).toBeFocused();
    fail = false;
    await retry.click();
    await expect(page.getByRole('combobox', { name: s.new.order })).toBeVisible();
  });

  test('an archived customer gets no new ticket, with the way to the profile (A07-48)', async ({
    page,
    admin,
  }) => {
    await open(page, admin, `/support/new?customer=${CUSTOMER_IDS.omar}`);
    await expect(page.getByText(s.new.archivedTitle)).toBeVisible();
    await expect(page.getByRole('button', { name: s.new.submit })).toHaveCount(0);
    await expect(page.getByRole('link', { name: s.new.toProfile })).toHaveAttribute(
      'href',
      `/customers/${CUSTOMER_IDS.omar}`,
    );
  });

  test('opens a deposit ticket, refused while the deposit is not the customer’s (A07-18)', async ({
    page,
    admin,
  }) => {
    const deposit = {
      id: '0199c000-0000-7000-8000-0000000007d1',
      method: 'sham_cash',
      status: 'credited',
      referenceCode: 'VD-4RT8K',
      currency: 'USD' as const,
      declaredAmountUnits: 10_000_000,
      declaredUsdUnits: 10_000_000,
      receiptRequestCount: 0,
      approvalRate: null,
      flags: [],
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
      customer: {
        id: CUSTOMER_IDS.sara,
        name: 'سارة الأحمد',
        email: 'sara@example.com',
        isTest: false,
      },
    };
    admin.deposits.push(deposit);
    await open(page, admin, `/support/new?customer=${CUSTOMER_IDS.sara}`);
    await chooseOption(
      page,
      page.getByRole('combobox', { name: s.new.category }),
      s.categories.deposit,
    );
    await chooseOption(page, page.getByRole('combobox', { name: s.new.deposit }), 'VD-4RT8K');
    await page.getByLabel(s.new.subject).fill('بخصوص إيداعك الأخير');
    await page.getByLabel(s.new.body).fill('أُضيف المبلغ إلى محفظتك.');
    // The deposit belongs to another account by the time the ticket is sent.
    deposit.customer = { ...deposit.customer, id: CUSTOMER_IDS.layla };
    await page.getByRole('button', { name: s.new.submit }).click();
    await expect(page.getByText(ar.errors.api.TICKET_LINK_INVALID)).toBeVisible();
    deposit.customer = { ...deposit.customer, id: CUSTOMER_IDS.sara };
    await page.getByRole('button', { name: s.new.submit }).click();
    await expect(page).toHaveURL(/\/support\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('link', { name: 'VD-4RT8K' })).toHaveAttribute(
      'href',
      `/deposits/${deposit.id}`,
    );
  });

  test('refuses a ticket to a customer archived meanwhile (A07-18)', async ({ page, admin }) => {
    await open(page, admin, `/support/new?customer=${CUSTOMER_IDS.layla}`);
    await chooseOption(
      page,
      page.getByRole('combobox', { name: s.new.category }),
      s.categories.other,
    );
    await page.getByLabel(s.new.subject).fill('سؤال عن حسابك');
    await page.getByLabel(s.new.body).fill('نحتاج إلى تأكيد رقم الهاتف.');
    const layla = admin.customers.find(CUSTOMER_IDS.layla);
    if (layla) layla.archivedAt = new Date().toISOString();
    await page.getByRole('button', { name: s.new.submit }).click();
    // The refusal reads the customer again: the page then says why no ticket opens (A07-48).
    await expect(page.getByText(s.new.archivedTitle)).toBeVisible();
    await expect(page.getByRole('button', { name: s.new.submit })).toHaveCount(0);
  });

  test('a failed read after saving the settings keeps the form with a notice (A07-47)', async ({
    page,
    admin,
  }) => {
    let fail = false;
    await page.route('**/api/admin/support/settings', (route) =>
      fail && route.request().method() === 'GET'
        ? route.fulfill({ status: 500, json: failing })
        : route.fallback(),
    );
    await open(page, admin, '/settings/support');
    const field = page.getByLabel(s.settings.telegram);
    await field.fill('https://t.me/vertex_support');
    fail = true;
    await page.getByRole('button', { name: s.settings.save }).click();
    await expect(page.getByText(s.settings.stale)).toBeVisible({ timeout: 10_000 });
    await expect(field).toHaveValue('https://t.me/vertex_support');
    fail = false;
    await page.getByRole('button', { name: ar.common.retry }).click();
    await expect(page.getByText(s.settings.stale)).toBeHidden();
  });
});

// RTL screenshots of the S12 support screens in both themes: the design review evidence.
for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('the queue and a thread', async ({ page, admin }, testInfo) => {
      // S23 OP2: the waiting ticket is a Gold merchant's, with the tier in the row.
      const waiting = admin.customers.tickets.find((item) => item.id === TICKET_IDS.waiting);
      const owner = waiting && admin.customers.find(waiting.customerId);
      if (owner) owner.tier = 'gold';
      await open(page, admin, '/support?status=all');
      await expect(rows(page)).toHaveCount(3);
      await screenshot(page, testInfo, `support-queue-${colorScheme}`);
      // S22 OP6: the queue filtered by an order problem.
      await page.goto('/support?status=all&problem=not_arrived');
      await expect(rows(page)).toHaveCount(1);
      await screenshot(page, testInfo, `support-queue-problem-${colorScheme}`);

      await page.goto(`/support/${TICKET_IDS.waiting}`);
      await expect(page.getByText('مرحبًا، دفعت قبل ساعة', { exact: false })).toBeVisible();
      await attach(page, 'proof.png');
      await expect(page.getByRole('img', { name: fill(s.images.preview, { n: 1 }) })).toBeVisible();
      await screenshot(page, testInfo, `support-thread-${colorScheme}`, { fullPage: true });
    });

    test('an answered thread', async ({ page, admin }, testInfo) => {
      await open(page, admin, `/support/${TICKET_IDS.answered}`);
      await expect(page.getByText(s.thread.admin).first()).toBeVisible();
      await screenshot(page, testInfo, `support-thread-answered-${colorScheme}`, {
        fullPage: true,
      });
    });

    test('a new ticket and the settings', async ({ page, admin }, testInfo) => {
      await open(page, admin, `/support/new?customer=${CUSTOMER_IDS.sara}`);
      await page.getByRole('button', { name: s.new.submit }).click();
      await expect(page.getByText(s.new.linkError)).toBeVisible();
      await screenshot(page, testInfo, `support-new-${colorScheme}`, { fullPage: true });

      await page.goto('/settings/support');
      await page.getByLabel(s.settings.telegram).fill('https://t.me/vertex_support');
      await expect(
        page.getByRole('link', { name: new RegExp(s.settings.previewLabel) }),
      ).toBeVisible();
      await screenshot(page, testInfo, `support-settings-${colorScheme}`);
    });
  });
}
