import type { Page } from '@playwright/test';
import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import { CUSTOMER_IDS, TICKET_IDS } from './customers-mock';
import { type AdminApi, expect, PASSWORD, screenshot, TOTP_CODE, test } from './test';

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

// RTL screenshots of the S12 support screens in both themes: the design review evidence.
for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('the queue and a thread', async ({ page, admin }, testInfo) => {
      await open(page, admin, '/support?status=all');
      await expect(rows(page)).toHaveCount(3);
      await screenshot(page, testInfo, `support-queue-${colorScheme}`);

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
