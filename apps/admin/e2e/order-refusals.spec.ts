import type { Page } from '@playwright/test';
import type { AdminOrder } from '@vertex-digital/contracts';
import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import { CUSTOMER_IDS } from './customers-mock';
import { ORDER_IDS } from './orders-mock';
import { type AdminApi, expect, test } from './test';

/*
 * Audit A04-18: a held order confirmed delivered (units, then codes) or failed; the refusals of
 * "/orders/new", of the reroute and of the manual fulfil's proof, against the mocked API.
 */

const o = ar.orders;
const b = ar.orders.buy;
const d = ar.orders.decisions;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function openHeld(page: Page, admin: AdminApi) {
  admin.signedIn = true;
  await page.goto(`/orders/${ORDER_IDS.held}`);
  await expect(page.getByText(d.heldHelp)).toBeVisible();
}

test('a held top-up confirmed delivered, its units checked first', async ({ page, admin }) => {
  await openHeld(page, admin);
  await page.getByRole('button', { name: d.delivered.open }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(d.delivered.quantity).fill('5');
  await dialog.getByLabel(d.reason).fill('The supplier confirmed it');
  await dialog.getByRole('button', { name: d.delivered.submit }).click();
  await expect(
    dialog.getByText(new RegExp(d.delivered.quantityError.split('{{')[0] as string)),
  ).toBeVisible();
  await dialog.getByLabel(d.delivered.quantity).fill('1');
  await dialog.getByRole('button', { name: d.delivered.submit }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(o.statuses.delivered, { exact: true }).first()).toBeVisible();
  expect(admin.bodies.findLast((item) => item.key.endsWith('/resolve'))?.body).toMatchObject({
    outcome: 'delivered',
    quantity: 1,
    codes: [],
  });
});

test('a held code order takes one code per unit', async ({ page, admin }) => {
  const held = admin.orders.orders.find((row) => row.id === ORDER_IDS.held) as AdminOrder;
  held.product = { ...held.product, kind: 'code' };
  await openHeld(page, admin);
  await page.getByRole('button', { name: d.delivered.open }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(d.reason).fill('Codes sent by the supplier');
  await dialog.getByRole('button', { name: d.delivered.submit }).click();
  await expect(dialog.getByText(d.delivered.codesError)).toBeVisible();
  await dialog.getByLabel(d.delivered.codes).fill('CODE-AAAA-1111');
  await dialog.getByRole('button', { name: d.delivered.submit }).click();
  await expect(dialog).toBeHidden();
  expect(admin.bodies.findLast((item) => item.key.endsWith('/resolve'))?.body).toMatchObject({
    outcome: 'delivered',
    codes: ['CODE-AAAA-1111'],
  });
});

test('a held order confirmed failed goes back to the wallet', async ({ page, admin }) => {
  await openHeld(page, admin);
  await page.getByRole('button', { name: d.failed.open }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(d.reason).fill('The supplier says it failed');
  await dialog.getByRole('button', { name: d.failed.submit }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(o.statuses.refunded, { exact: true }).first()).toBeVisible();
  expect(admin.bodies.findLast((item) => item.key.endsWith('/resolve'))?.body).toMatchObject({
    outcome: 'failed',
  });
});

test('a refused reroute reads the routes again and clears the choice', async ({ page, admin }) => {
  await openHeld(page, admin);
  await page.route(`**/api/admin/orders/${ORDER_IDS.held}/reroute`, (route) =>
    route.fulfill({ status: 409, json: { code: 'ROUTE_NOT_ELIGIBLE' } }),
  );
  await page.getByRole('button', { name: o.reroute.open }).click();
  const dialog = page.getByRole('dialog', { name: o.reroute.title });
  const choice = dialog.getByRole('radio', { name: /مورد تجريبي/ });
  await choice.check();
  await dialog.getByLabel(d.reason).fill('No answer after the hard limit');
  await dialog.getByRole('button', { name: o.reroute.submit }).click();
  await expect(dialog.getByText(ar.errors.api.ROUTE_NOT_ELIGIBLE)).toBeVisible();
  await expect(choice).not.toBeChecked();
});

test('a refused proof keeps the fulfil dialog open and says to upload again', async ({
  page,
  admin,
}) => {
  await openHeld(page, admin);
  await page.route(`**/api/admin/orders/${ORDER_IDS.held}/fulfil`, (route) =>
    route.fulfill({ status: 400, json: { code: 'PROOF_INVALID' } }),
  );
  await page.getByRole('button', { name: o.fulfil.open }).click();
  const dialog = page.getByRole('dialog', { name: o.fulfil.title });
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: 'proof.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByRole('img', { name: o.fulfil.proofAlt })).toBeVisible();
  await dialog.getByLabel(o.fulfil.cost).fill('0.80');
  await dialog.getByLabel(o.fulfil.reference).fill('OP-5521');
  await dialog.getByLabel(d.reason).fill('Bought at the other shop');
  await dialog.getByRole('button', { name: o.fulfil.submit }).click();
  await expect(dialog.getByText(ar.errors.api.PROOF_INVALID)).toBeVisible();
});

test.describe('"/orders/new" refusals', () => {
  /** On behalf of Sara, the form filled: `refuse` answers the purchase once. */
  async function filled(page: Page, admin: AdminApi, code: string, details: object = {}) {
    const game = admin.catalog.addGame({
      categorySlug: 'games',
      slug: 'pubg-mobile',
      nameAr: 'ببجي موبايل',
      nameEn: 'PUBG Mobile',
      status: 'active',
      cover: true,
    });
    admin.catalog.addField(game.id, { key: 'player_id', labelAr: 'معرّف اللاعب' });
    const pack = admin.catalog.addProduct(game.id, { nameAr: '60 UC', gameAmount: 60 });
    admin.suppliers.connectFake();
    admin.suppliers.map(pack.id, 'fake', 'fake-uc-60', { playerId: 'player_id' });
    admin.signedIn = true;
    await page.route('**/api/admin/orders', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 409, json: { code, details } })
        : route.fallback(),
    );
    await page.goto(`/orders/new?purpose=on_behalf&customerId=${CUSTOMER_IDS.sara}`);
    await page.getByRole('combobox', { name: b.picker.search }).fill('pubg');
    await page.getByRole('combobox', { name: b.picker.search }).press('Enter');
    await page.getByRole('radio', { name: '60 UC' }).check();
    await page.getByRole('textbox', { name: 'معرّف اللاعب' }).fill('5123456789');
    await page.getByRole('textbox', { name: b.reason }).fill('Asked on WhatsApp');
    await page.getByRole('button', { name: b.confirm }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: new RegExp(`^${b.confirmAction.split(' ')[0]}`) })
      .click();
  }

  const refusals = [
    ['INSUFFICIENT_BALANCE', ar.errors.api.INSUFFICIENT_BALANCE],
    ['EMAIL_NOT_VERIFIED', ar.errors.api.EMAIL_NOT_VERIFIED],
    ['PLAYER_NOT_CONFIRMED', ar.errors.api.PLAYER_NOT_CONFIRMED],
  ] as const;
  for (const [code, text] of refusals) {
    test(`${code} stays on the page and says why`, async ({ page, admin }) => {
      await filled(page, admin, code);
      await expect(page.getByText(text)).toBeVisible();
      await expect(page).toHaveURL(/\/orders\/new/);
    });
  }

  test('PRICE_CHANGED names the new price', async ({ page, admin }) => {
    await filled(page, admin, 'PRICE_CHANGED', { unitPriceUsdUnits: 1_090_000 });
    await expect(page.getByText(b.priceChanged.replace('{{price}}', '⁦$1.09⁩'))).toBeVisible();
    await expect(page).toHaveURL(/\/orders\/new/);
  });
});
