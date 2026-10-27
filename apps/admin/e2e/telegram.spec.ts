import type { Page } from '@playwright/test';
import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import { type AdminApi, expect, PASSWORD, screenshot, TOTP_CODE, test } from './test';

/*
 * The Telegram page (S05, F07): not configured, linking with a single-use link after a
 * re-authentication while the page waits for the phone, then linked with a test message and
 * unlinking, against the mocked API.
 */

const field = (page: Page, label: string) =>
  page.getByLabel(label, { exact: true }).filter({ visible: true });

async function open(page: Page, admin: AdminApi) {
  admin.signedIn = true;
  await page.goto('/settings/telegram');
  await expect(page.getByRole('heading', { name: ar.telegram.title, level: 1 })).toBeVisible();
}

/** Re-authenticates in the dialog the API's refusal opened (S01 rule D5). */
async function reauthenticate(page: Page, admin: AdminApi) {
  await expect(page.getByRole('heading', { name: ar.reauth.title })).toBeVisible();
  await field(page, ar.reauth.password).fill(PASSWORD);
  await page.getByRole('textbox').filter({ visible: true }).nth(1).pressSequentially(TOTP_CODE);
  await page.getByRole('button', { name: ar.reauth.submit }).click();
  await expect(page.getByRole('heading', { name: ar.reauth.title })).toBeHidden();
  admin.reauthenticationRequired = false;
}

const LINK = {
  username: 'vertex_owner',
  since: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
};

test.describe('Telegram page', () => {
  test('explains the server variables while the bot is not configured', async ({ page, admin }) => {
    admin.telegram = { configured: false, link: null, lastMessage: null };
    await open(page, admin);
    await expect(page.getByText(ar.telegram.notConfigured.title)).toBeVisible();
    await expect(page.getByText('TELEGRAM_BOT_TOKEN')).toBeVisible();
    await expect(page.getByRole('button', { name: ar.telegram.notLinked.link })).toBeHidden();
  });

  test('links after a re-authentication, then turns to linked when the phone opens the link', async ({
    page,
    admin,
  }) => {
    admin.reauthenticationRequired = true;
    await open(page, admin);
    await expect(page.getByText(ar.telegram.notLinked.title)).toBeVisible();
    await page.getByRole('button', { name: ar.telegram.notLinked.link }).click();
    await reauthenticate(page, admin);
    await expect(page.getByRole('img', { name: ar.telegram.notLinked.qrLabel })).toBeVisible();
    await expect(
      page.getByRole('link', {
        name: 'https://t.me/vertex_digital_bot?start=Kq3v8ZbW1xT0aLmN5pR7sQ',
      }),
    ).toBeVisible();
    await expect(page.getByText(/ينتهي الرابط خلال (10:00|9:5\d)/)).toBeVisible();

    // The owner presses Start on the phone: the next poll sees the link.
    admin.telegram = { ...admin.telegram, link: LINK };
    await expect(page.getByText(ar.telegram.linked.title)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('@vertex_owner')).toBeVisible();
  });

  test('sends a test message and unlinks after a confirmation and a re-authentication', async ({
    page,
    admin,
  }) => {
    admin.telegram = { configured: true, link: LINK, lastMessage: null };
    await open(page, admin);
    await expect(page.getByText(ar.telegram.linked.noMessage)).toBeVisible();
    await page.getByRole('button', { name: ar.telegram.linked.test }).click();
    await expect(page.getByText(ar.telegram.linked.testQueued)).toBeVisible();
    await expect(page.getByText(ar.telegram.messageStatus.pending)).toBeVisible();

    admin.reauthenticationRequired = true;
    await page.getByRole('button', { name: ar.telegram.linked.unlink }).click();
    const dialog = page.getByRole('alertdialog');
    // A07-45: the confirmation names the linked account.
    await expect(
      dialog.getByText(
        ar.telegram.unlink.bodyNamed.replace('{{account}}', '\u2066@vertex_owner\u2069'),
      ),
    ).toBeVisible();
    await dialog.getByRole('button', { name: ar.telegram.unlink.action }).click();
    await reauthenticate(page, admin);
    await expect(page.getByText(ar.telegram.notLinked.title)).toBeVisible();
  });

  test('reads the test message’s status in the background until it is sent (A07-43)', async ({
    page,
    admin,
  }) => {
    admin.telegram = { configured: true, link: LINK, lastMessage: null };
    await open(page, admin);
    await page.getByRole('button', { name: ar.telegram.linked.test }).click();
    await expect(page.getByText(ar.telegram.messageStatus.pending)).toBeVisible();
    const queued = admin.telegram.lastMessage;
    if (!queued) throw new Error('No test message');
    admin.telegram = {
      ...admin.telegram,
      lastMessage: { ...queued, status: 'sent', sentAt: new Date().toISOString() },
    };
    await expect(page.getByText(ar.telegram.messageStatus.sent)).toBeVisible({ timeout: 10_000 });
    const reads = () =>
      admin.requests.filter((request) => request.key === 'GET /api/admin/telegram');
    expect(reads().at(-1)?.headers['x-background-request']).toBe('1');
    // Sent: the page stops reading.
    const count = reads().length;
    await page.waitForTimeout(4_000);
    expect(reads()).toHaveLength(count);
  });

  test('shows a test message that failed, and a refused test (A07-18)', async ({ page, admin }) => {
    admin.telegram = { configured: true, link: LINK, lastMessage: null };
    await open(page, admin);
    await page.getByRole('button', { name: ar.telegram.linked.test }).click();
    await expect(page.getByText(ar.telegram.messageStatus.pending)).toBeVisible();
    const queued = admin.telegram.lastMessage;
    if (!queued) throw new Error('No test message');
    admin.telegram = {
      ...admin.telegram,
      lastMessage: {
        ...queued,
        status: 'failed',
        error: 'TelegramApiError: HTTP 403: Forbidden: bot was blocked by the user',
      },
    };
    await expect(page.getByText(ar.telegram.messageStatus.failed)).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText(/bot was blocked by the user/)).toBeVisible();

    await page.route('**/api/admin/telegram/test', (route) =>
      route.fulfill({
        status: 500,
        json: { statusCode: 500, code: 'INTERNAL_ERROR', message: 'x' },
      }),
    );
    await page.getByRole('button', { name: ar.telegram.linked.test }).click();
    await expect(page.getByText(ar.errors.generic)).toBeVisible();
  });

  test('a link left unopened expires, with a new one offered (A07-18)', async ({ page, admin }) => {
    await page.clock.install();
    await open(page, admin);
    await page.getByRole('button', { name: ar.telegram.notLinked.link }).click();
    await expect(page.getByRole('img', { name: ar.telegram.notLinked.qrLabel })).toBeVisible();
    await page.clock.fastForward(10 * 60_000 + 1_000);
    await expect(page.getByText(ar.telegram.notLinked.expired)).toBeVisible();
    await expect(page.getByRole('img', { name: ar.telegram.notLinked.qrLabel })).toHaveCount(0);
    await expect(page.getByRole('button', { name: ar.telegram.notLinked.renew })).toBeVisible();
  });
});

// RTL screenshots in both themes: the design review evidence (ADR 0011).
for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('S05 Telegram screenshots', async ({ page, admin }, testInfo) => {
      admin.telegram = { configured: false, link: null, lastMessage: null };
      await open(page, admin);
      await expect(page.getByText(ar.telegram.notConfigured.title)).toBeVisible();
      await screenshot(page, testInfo, `telegram-not-configured-${colorScheme}`);

      admin.telegram = { configured: true, link: null, lastMessage: null };
      await page.reload();
      await page.getByRole('button', { name: ar.telegram.notLinked.link }).click();
      await expect(page.getByRole('img', { name: ar.telegram.notLinked.qrLabel })).toBeVisible();
      await screenshot(page, testInfo, `telegram-link-${colorScheme}`);

      admin.telegram = {
        configured: true,
        link: LINK,
        lastMessage: {
          kind: 'switch_changed',
          status: 'failed',
          createdAt: new Date(Date.now() - 20 * 60_000).toISOString(),
          sentAt: null,
          error: 'TelegramApiError: HTTP 403: Forbidden: bot was blocked by the user',
        },
      };
      await page.reload();
      await expect(page.getByText(ar.telegram.linked.title)).toBeVisible();
      await screenshot(page, testInfo, `telegram-linked-${colorScheme}`);
    });
  });
}
