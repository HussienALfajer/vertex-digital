import type { Page } from '@playwright/test';
import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import { ORDER_IDS } from './orders-mock';
import { type AdminApi, expect, PASSWORD, screenshot, TOTP_CODE, test } from './test';

/*
 * The live room (S11, F17): the four columns with a slow (amber) and a held (red) card and the
 * tab title's count, a stream event moving a card without a reload, the URL filters, and from
 * the side sheet the reroute of a held order and the manual fulfil with its proof and loss
 * confirmation; the order page's manual fulfil from review and the Telegram link that opens it.
 */

const o = ar.orders;
const live = o.live;

/** A 1×1 PNG: the screenshot the admin uploads as the delivery proof. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

async function openLive(page: Page, admin: AdminApi, query = '') {
  admin.signedIn = true;
  admin.orders.addLiveOrders();
  await page.goto(`/orders/live${query}`);
}

async function reauthenticate(page: Page) {
  await expect(page.getByRole('heading', { name: ar.reauth.title })).toBeVisible();
  await page.getByLabel(ar.reauth.password, { exact: true }).fill(PASSWORD);
  await page.getByRole('textbox').filter({ visible: true }).nth(1).pressSequentially(TOTP_CODE);
  await page.getByRole('button', { name: ar.reauth.submit }).click();
}

const column = (page: Page, name: keyof typeof live.columns) =>
  page.locator(`section[data-column="${name}"]`);

const cardOf = (page: Page, number: string) =>
  page.getByRole('button', { name: new RegExp(number) });

async function uploadProof(page: Page) {
  await page.locator('input[type="file"]').setInputFiles({
    name: 'proof.png',
    mimeType: 'image/png',
    buffer: PNG,
  });
  await expect(page.getByRole('img', { name: o.fulfil.proofAlt })).toBeVisible();
}

test('the board: four columns, a slow card amber, a held card red, the count in the title', async ({
  page,
  admin,
}) => {
  await openLive(page, admin);
  for (const name of Object.values(live.columns)) {
    await expect(page.getByRole('heading', { name })).toBeVisible();
  }
  await expect(column(page, 'at_supplier').getByText('VO-SLOW52')).toBeVisible();
  await expect(cardOf(page, 'VO-SLOW52')).toHaveAttribute('data-slow', 'true');
  await expect(cardOf(page, 'VO-SLOW52')).toContainText(live.slow);
  await expect(cardOf(page, 'VO-NEWW63')).not.toHaveAttribute('data-slow');
  await expect(cardOf(page, 'VO-HELD23')).toHaveAttribute('data-review', 'true');
  await expect(column(page, 'manual').getByText('VO-MANU45')).toBeVisible();
  await expect(column(page, 'finished').getByText('VO-DONE67')).toBeVisible();
  // Rule LR6: one held, one manual.
  await expect(page).toHaveTitle(/^\(2\) /);
  await expect(page.getByRole('status')).toHaveText(live.stream.live);
});

test('a stream event moves a card to "finished" without a reload (rule LR5)', async ({
  page,
  admin,
}) => {
  // One stream answer, a few seconds in, and no reconnect: only the event can trigger the read.
  admin.stream = {
    events: [{ event: 'order', data: { orderId: ORDER_IDS.fresh, status: 'delivered' } }],
    delayMs: 4_000,
    retryMs: 600_000,
  };
  await openLive(page, admin);
  await expect(column(page, 'at_supplier').getByText('VO-NEWW63')).toBeVisible();
  admin.orders.deliver(ORDER_IDS.fresh);
  await expect(column(page, 'finished').getByText('VO-NEWW63')).toBeVisible({ timeout: 10_000 });
  await expect(column(page, 'at_supplier').getByText('VO-NEWW63')).toBeHidden();
});

test('filters live in the URL: the manual supplier only', async ({ page, admin }) => {
  await openLive(page, admin, '?supplier=manual');
  await expect(column(page, 'manual').getByText('VO-MANU45')).toBeVisible();
  await expect(page.getByText('VO-SLOW52')).toBeHidden();
  expect(admin.calls.some((call) => call === 'GET /api/admin/orders/live')).toBe(true);
  await page.getByRole('combobox', { name: o.filters.supplier }).click();
  await page.getByRole('option', { name: o.filters.all }).click();
  await expect(page).not.toHaveURL(/supplier=/);
  await expect(page.getByText('VO-SLOW52')).toBeVisible();
});

test('reroute a held order from the side sheet, with the warning (rules RR2–RR4)', async ({
  page,
  admin,
}) => {
  await openLive(page, admin);
  await cardOf(page, 'VO-HELD23').click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByText('VO-HELD23')).toBeVisible();
  await sheet.getByRole('button', { name: o.reroute.open }).click();
  const dialog = page.getByRole('dialog', { name: o.reroute.title });
  await expect(dialog.getByText(o.reroute.warning)).toBeVisible();
  // The supplier that held it was tried; the fake and manual routes are eligible.
  await expect(dialog.getByRole('row', { name: /WDGZone/ })).toContainText(
    o.skipReasons.already_tried,
  );
  await dialog.getByRole('radio', { name: /مورد تجريبي/ }).check();
  await dialog.getByLabel(o.decisions.reason).fill('No answer after the hard limit');
  admin.reauthenticationRequired = true;
  await dialog.getByRole('button', { name: o.reroute.submit }).click();
  await reauthenticate(page);
  admin.reauthenticationRequired = false;
  await expect(dialog).toBeHidden();
  await expect(column(page, 'at_supplier').getByText('VO-HELD23')).toBeVisible();
  expect(admin.requests.findLast((r) => r.key.endsWith('/reroute'))?.headers).toHaveProperty(
    'idempotency-key',
  );
});

test('manual fulfil of a manual order: codes, proof, and a loss to confirm (rules MF2–MF4)', async ({
  page,
  admin,
}) => {
  await openLive(page, admin);
  await cardOf(page, 'VO-MANU45').click();
  await page.getByRole('dialog').getByRole('button', { name: o.fulfil.open }).click();
  const dialog = page.getByRole('dialog', { name: o.fulfil.title });
  // Prefilled with the manual route's cost: 80% of $10.60.
  await expect(dialog.getByLabel(o.fulfil.cost)).toHaveValue('8.48');
  await expect(dialog.getByTestId('fulfil-profit')).toContainText('$4.24');
  await dialog.getByLabel(o.decisions.delivered.codes).fill('CODE-AAAA-1111\nCODE-BBBB-2222');
  await dialog.getByLabel(o.fulfil.cost).fill('11.00');
  await expect(dialog.getByTestId('fulfil-profit')).toContainText('$0.80');
  await uploadProof(page);
  await dialog.getByLabel(o.fulfil.reference).fill('SC-778812');
  await dialog.getByLabel(o.decisions.reason).fill('Bought at the other shop');
  await dialog.getByRole('button', { name: o.fulfil.submit }).click();
  await expect(dialog.getByText(o.fulfil.acceptLossError)).toBeVisible();
  await dialog.getByText(o.fulfil.acceptLoss).click();
  admin.reauthenticationRequired = true;
  await dialog.getByRole('button', { name: o.fulfil.submit }).click();
  await reauthenticate(page);
  admin.reauthenticationRequired = false;
  await expect(dialog).toBeHidden();
  const sent = admin.bodies.findLast((item) => item.key.endsWith('/fulfil'))?.body;
  expect(sent).toMatchObject({ quantity: 2, unitCostUsdUnits: 11_000_000, acceptLoss: true });
  await expect(column(page, 'finished').getByText('VO-MANU45')).toBeVisible();
});

test('the order page fulfils a held order manually and shows the proof (rule MF5)', async ({
  page,
  admin,
}) => {
  admin.signedIn = true;
  await page.goto(`/orders/${ORDER_IDS.held}`);
  await page.getByRole('button', { name: o.fulfil.open }).click();
  const dialog = page.getByRole('dialog', { name: o.fulfil.title });
  await expect(dialog.getByText(o.reroute.warning)).toBeVisible();
  await dialog.getByLabel(o.fulfil.cost).fill('0.80');
  await uploadProof(page);
  await dialog.getByLabel(o.fulfil.reference).fill('OP-5521');
  await dialog.getByLabel(o.decisions.reason).fill('Delivered from the other panel');
  await dialog.getByRole('button', { name: o.fulfil.submit }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(o.attempts.adminFulfil)).toBeVisible();
  await expect(page.getByText('OP-5521')).toBeVisible();
  await expect(page.getByRole('img', { name: o.attempts.proofOpen })).toBeVisible();
  await expect(page.getByText(o.statuses.delivered).first()).toBeVisible();
});

test('the Telegram card link opens the manual fulfil (edge case 10)', async ({ page, admin }) => {
  admin.signedIn = true;
  await page.goto(`/orders/${ORDER_IDS.manual}?decide=fulfil`);
  await expect(page.getByRole('dialog', { name: o.fulfil.title })).toBeVisible();
});

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('live room screenshots', async ({ page, admin }, testInfo) => {
      await openLive(page, admin);
      await expect(cardOf(page, 'VO-SLOW52')).toHaveAttribute('data-slow', 'true');
      await screenshot(page, testInfo, `live-room-${colorScheme}`, { fullPage: true });

      await cardOf(page, 'VO-HELD23').click();
      await expect(page.getByRole('dialog').getByText(o.events.title)).toBeVisible();
      await screenshot(page, testInfo, `live-sheet-${colorScheme}`);

      await page.getByRole('dialog').getByRole('button', { name: o.reroute.open }).click();
      const reroute = page.getByRole('dialog', { name: o.reroute.title });
      await expect(reroute.getByText(o.reroute.eligible).first()).toBeVisible();
      await screenshot(page, testInfo, `live-reroute-${colorScheme}`);
      await page.keyboard.press('Escape');
      await expect(reroute).toBeHidden();
      await page.keyboard.press('Escape');

      await cardOf(page, 'VO-MANU45').click();
      await page.getByRole('dialog').getByRole('button', { name: o.fulfil.open }).click();
      const fulfil = page.getByRole('dialog', { name: o.fulfil.title });
      await fulfil.getByLabel(o.fulfil.cost).fill('11.00');
      await uploadProof(page);
      await expect(fulfil.getByText(o.fulfil.acceptLoss)).toBeVisible();
      await fulfil.getByText(o.fulfil.acceptLoss).scrollIntoViewIfNeeded();
      await screenshot(page, testInfo, `live-fulfil-${colorScheme}`);
    });

    test('order page with a manual fulfil', async ({ page, admin }, testInfo) => {
      admin.signedIn = true;
      await page.goto(`/orders/${ORDER_IDS.held}`);
      await page.getByRole('button', { name: o.fulfil.open }).click();
      const dialog = page.getByRole('dialog', { name: o.fulfil.title });
      await dialog.getByLabel(o.fulfil.cost).fill('0.80');
      await uploadProof(page);
      await dialog.getByLabel(o.fulfil.reference).fill('OP-5521');
      await dialog.getByLabel(o.decisions.reason).fill('Delivered from the other panel');
      await dialog.getByRole('button', { name: o.fulfil.submit }).click();
      await expect(page.getByRole('img', { name: o.attempts.proofOpen })).toBeVisible();
      await screenshot(page, testInfo, `order-admin-fulfil-${colorScheme}`, { fullPage: true });
    });

    test('live room on a phone: the columns become tabs', async ({ page, admin }, testInfo) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openLive(page, admin);
      await page.getByRole('tab', { name: new RegExp(live.columns.at_supplier) }).click();
      await expect(cardOf(page, 'VO-SLOW52')).toBeVisible();
      await expect(cardOf(page, 'VO-HELD23')).toBeHidden();
      await screenshot(page, testInfo, `live-room-phone-${colorScheme}`);
    });
  });
}
