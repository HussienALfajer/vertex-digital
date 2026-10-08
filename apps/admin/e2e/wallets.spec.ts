import type { Page } from '@playwright/test';
import ar from '../src/i18n/locales/ar.json' with { type: 'json' };
import {
  type AdminApi,
  CUSTOMER_ID,
  expect,
  PASSWORD,
  screenshot,
  TOTP_CODE,
  test,
  USD,
} from './test';

/*
 * Wallets (S02): the summary and search, a customer's wallet, adjustments with re-authentication,
 * the typed confirmation above $100, and reversals, against the mocked API.
 */

const field = (page: Page, label: string) =>
  page.getByLabel(label, { exact: true }).filter({ visible: true });

async function open(page: Page, admin: AdminApi, path: string) {
  admin.signedIn = true;
  await page.goto(path);
}

/** The keys sent with each adjustment or reversal request, in order. */
const sentKeys = (admin: AdminApi) =>
  admin.requests
    .filter((request) => /\/(adjustments|reverse)$/.test(request.key))
    .map((request) => request.headers['idempotency-key']);

interface Adjust {
  direction?: 'credit' | 'debit';
  amount: string;
  confirm?: string;
  category: keyof typeof ar.wallets.categories;
  method?: keyof typeof ar.wallets.methods;
  reference?: string;
  reason?: string;
  note?: string;
}

/** Fills the open adjust dialog and submits it. */
async function fillAdjust(page: Page, input: Adjust) {
  const dialog = page.getByRole('dialog');
  if (input.direction === 'debit') {
    await dialog.getByRole('button', { name: ar.wallets.directions.debit }).click();
  }
  await field(page, ar.wallets.adjust.amount).fill(input.amount);
  if (input.confirm !== undefined) await field(page, ar.wallets.adjust.confirm).fill(input.confirm);
  await dialog.getByRole('combobox', { name: ar.wallets.adjust.category }).click();
  await page.getByRole('option', { name: ar.wallets.categories[input.category] }).click();
  if (input.method) {
    await dialog.getByRole('combobox', { name: ar.wallets.adjust.method }).click();
    await page.getByRole('option', { name: ar.wallets.methods[input.method] }).click();
    await field(page, ar.wallets.adjust.reference).fill(input.reference ?? '');
  }
  await field(page, ar.wallets.adjust.reason).fill(input.reason ?? 'رصيد لتجربة الشراء');
  if (input.note) await field(page, ar.wallets.adjust.note).fill(input.note);
  await dialog.getByRole('button', { name: ar.wallets.adjust.submit }).click();
}

async function adjust(page: Page, input: Adjust) {
  await page.getByRole('button', { name: ar.wallets.detail.adjust }).click();
  await fillAdjust(page, input);
  await expect(page.getByRole('dialog')).toBeHidden();
}

/** Re-authenticates in the dialog the API's refusal opened (S01 rule D5). */
async function reauthenticate(page: Page) {
  await expect(page.getByRole('heading', { name: ar.reauth.title })).toBeVisible();
  await field(page, ar.reauth.password).fill(PASSWORD);
  await page.getByRole('textbox').filter({ visible: true }).nth(1).pressSequentially(TOTP_CODE);
  await page.getByRole('button', { name: ar.reauth.submit }).click();
}

const rows = (page: Page) => page.getByRole('table').getByRole('row');

test.describe('wallets', () => {
  test('the summary, then a search by name and by phone opens the wallet', async ({
    page,
    admin,
  }) => {
    await open(page, admin, '/');
    await page.getByRole('link', { name: ar.nav.wallets }).first().click();
    await expect(page.getByText(ar.wallets.summary.owedTest)).toBeVisible();
    await expect(page.getByText('$0.00')).toHaveCount(2);

    await page.getByRole('searchbox').fill('سا');
    await page.getByRole('button', { name: ar.wallets.search.submit }).click();
    await expect(page.getByText(ar.wallets.search.tooShort)).toBeVisible();
    expect(admin.calls).not.toContain('GET /api/admin/wallets');

    await page.getByRole('searchbox').fill('سارة');
    await page.getByRole('button', { name: ar.wallets.search.submit }).click();
    await expect(page).toHaveURL(/\/wallets\?q=/);
    await expect(page.getByRole('cell', { name: 'sara@example.com' })).toBeVisible();

    await page.getByRole('searchbox').fill('+96394');
    await page.getByRole('button', { name: ar.wallets.search.submit }).click();
    await expect(page.getByRole('cell', { name: '+963944123456' })).toBeVisible();
    await page.getByRole('searchbox').fill('nobody');
    await page.getByRole('button', { name: ar.wallets.search.submit }).click();
    await expect(page.getByText(ar.wallets.search.emptyTitle)).toBeVisible();

    await page.goBack();
    await page.getByRole('cell', { name: '+963944123456' }).click();
    await expect(page).toHaveURL(`/wallets/${CUSTOMER_ID}`);
    await expect(page.getByRole('heading', { name: 'سارة الأحمد' })).toBeVisible();
    await expect(page.getByText(ar.wallets.detail.emptyTitle)).toBeVisible();
  });

  test('a test credit asks for re-authentication, then retries with the same key', async ({
    page,
    admin,
  }) => {
    admin.reauthenticationRequired = true;
    await open(page, admin, `/wallets/${CUSTOMER_ID}`);
    await page.getByRole('button', { name: ar.wallets.detail.adjust }).click();
    await fillAdjust(page, {
      amount: '25',
      category: 'test_funds',
      reason: 'رصيد لتجربة الشراء',
      note: 'رصيد للتجربة',
    });
    await reauthenticate(page);
    await expect(page.getByRole('dialog')).toBeHidden();

    await expect(rows(page).nth(1)).toContainText(ar.wallets.categories.test_funds);
    await expect(rows(page).nth(1)).toContainText('+$25.00');
    await expect(rows(page).nth(1)).toContainText('رصيد لتجربة الشراء');
    const keys = sentKeys(admin);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(admin.lastBody(`POST /api/admin/wallets/${CUSTOMER_ID}/adjustments`)).toEqual({
      direction: 'credit',
      amountUnits: 25 * USD,
      category: 'test_funds',
      reason: 'رصيد لتجربة الشراء',
      customerNote: 'رصيد للتجربة',
    });
  });

  test('above $100 the amount is typed twice; a debit beyond the balance is refused', async ({
    page,
    admin,
  }) => {
    await open(page, admin, `/wallets/${CUSTOMER_ID}`);
    await adjust(page, { amount: '25', category: 'test_funds' });

    await page.getByRole('button', { name: ar.wallets.detail.adjust }).click();
    // Exactly $100 needs no confirmation (edge case 9).
    await field(page, ar.wallets.adjust.amount).fill('100');
    await expect(field(page, ar.wallets.adjust.confirm)).toHaveCount(0);
    await fillAdjust(page, { amount: '250', confirm: '205', category: 'compensation' });
    await expect(page.getByText(ar.wallets.adjust.errors.confirm)).toBeVisible();
    expect(sentKeys(admin)).toHaveLength(1);
    await field(page, ar.wallets.adjust.confirm).fill('250');
    await page.getByRole('dialog').getByRole('button', { name: ar.wallets.adjust.submit }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(rows(page).nth(1)).toContainText('+$250.00');
    expect(admin.lastBody(`POST /api/admin/wallets/${CUSTOMER_ID}/adjustments`)).toMatchObject({
      amountUnits: 250 * USD,
      amountConfirmationUnits: 250 * USD,
    });

    await page.getByRole('button', { name: ar.wallets.detail.adjust }).click();
    await fillAdjust(page, {
      direction: 'debit',
      amount: '1000',
      confirm: '1000',
      category: 'cash_refund',
    });
    await expect(
      page.getByText(ar.wallets.adjust.insufficient.replace('{{balance}}', '$275.00')),
    ).toBeVisible();
  });

  test('reverses an adjustment once and links the two', async ({ page, admin }) => {
    await open(page, admin, `/wallets/${CUSTOMER_ID}`);
    await adjust(page, { amount: '250', confirm: '250', category: 'compensation' });

    await page
      .getByRole('button', {
        name: ar.wallets.detail.reverseLabel.replace('{{amount}}', '$250.00'),
      })
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText(ar.wallets.categories.compensation);
    await field(page, ar.wallets.adjust.confirm).fill('250');
    await field(page, ar.wallets.adjust.reason).fill('تعويض مكرر بالخطأ');
    await dialog.getByRole('button', { name: ar.wallets.reverse.submit }).click();
    await expect(dialog).toBeHidden();

    await expect(rows(page).nth(1)).toContainText(
      ar.wallets.detail.reversal.replace('{{category}}', ar.wallets.categories.compensation),
    );
    await expect(rows(page).nth(1)).toContainText('−$250.00');
    await expect(rows(page).nth(1).getByRole('link')).toHaveText(ar.wallets.detail.reversalOf);
    await expect(rows(page).nth(2)).toContainText(ar.wallets.detail.reversed);
    await expect(page.getByRole('button', { name: ar.wallets.detail.reverse })).toHaveCount(0);
    expect(
      admin.lastBody(`POST /api/admin/wallet-adjustments/${admin.adjustments[0]?.id}/reverse`),
    ).toEqual({
      reason: 'تعويض مكرر بالخطأ',
      amountConfirmationUnits: 250 * USD,
    });

    await rows(page).nth(1).getByRole('link').click();
    await expect(page).toHaveURL(new RegExp(`#adjustment-${admin.adjustments[0]?.id}$`));
  });

  test('a manual deposit reference is used once; an edited request gets a new key', async ({
    page,
    admin,
  }) => {
    await open(page, admin, `/wallets/${CUSTOMER_ID}`);
    await adjust(page, {
      amount: '10',
      category: 'manual_deposit',
      method: 'sham_cash',
      reference: 'ABC123',
    });
    await expect(rows(page).nth(1)).toContainText('ABC123');

    await page.getByRole('button', { name: ar.wallets.detail.adjust }).click();
    await fillAdjust(page, {
      amount: '10',
      category: 'manual_deposit',
      method: 'sham_cash',
      reference: ' abc123 ',
    });
    await expect(page.getByText(ar.errors.api.EXTERNAL_REFERENCE_TAKEN)).toBeVisible();
    await field(page, ar.wallets.adjust.reference).fill('XYZ789');
    await page.getByRole('dialog').getByRole('button', { name: ar.wallets.adjust.submit }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
    const keys = sentKeys(admin);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
  });

  test('an unknown wallet says so', async ({ page, admin }) => {
    await open(page, admin, '/wallets/0199a000-0000-7000-8000-0000000000ff');
    await expect(page.getByText(ar.errors.api.NOT_FOUND)).toBeVisible();
  });

  test('the audit log filters by wallet adjustment', async ({ page, admin }) => {
    await open(page, admin, '/audit');
    await page.getByRole('combobox', { name: ar.audit.filters.entityType }).click();
    await page.getByRole('option', { name: ar.audit.entityTypes.wallet_adjustment }).click();
    await page.getByRole('button', { name: ar.audit.filters.apply }).click();
    await expect(page).toHaveURL(/entityType=wallet_adjustment/);
  });
});

// RTL screenshots of the S02 screens in both themes: the design review evidence (ADR 0011).
for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test('S02 screenshots', async ({ page, admin }, testInfo) => {
      await open(page, admin, `/wallets/${CUSTOMER_ID}`);
      await adjust(page, { amount: '25', category: 'test_funds', note: 'رصيد للتجربة' });
      await adjust(page, { amount: '250', confirm: '250', category: 'compensation' });
      await adjust(page, {
        amount: '40',
        category: 'manual_deposit',
        method: 'usdt_trc20',
        reference: '7f3a9c0e5b2d4a1f8e6c3b9a0d5e7f1a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d0e',
      });
      await page
        .getByRole('button', {
          name: ar.wallets.detail.reverseLabel.replace('{{amount}}', '$250.00'),
        })
        .click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await screenshot(page, testInfo, `wallet-reverse-${colorScheme}`);
      await field(page, ar.wallets.adjust.confirm).fill('250');
      await field(page, ar.wallets.adjust.reason).fill('تعويض مكرر بالخطأ');
      await page
        .getByRole('dialog')
        .getByRole('button', { name: ar.wallets.reverse.submit })
        .click();
      await expect(page.getByRole('dialog')).toBeHidden();
      await expect(rows(page)).toHaveCount(5);
      await screenshot(page, testInfo, `wallet-${colorScheme}`);

      await page.getByRole('button', { name: ar.wallets.detail.adjust }).click();
      await field(page, ar.wallets.adjust.amount).fill('150');
      await page
        .getByRole('dialog')
        .getByRole('combobox', { name: ar.wallets.adjust.category })
        .click();
      await page.getByRole('option', { name: ar.wallets.categories.compensation }).click();
      await expect(field(page, ar.wallets.adjust.confirm)).toBeVisible();
      await screenshot(page, testInfo, `wallet-adjust-${colorScheme}`);
      await page.keyboard.press('Escape');

      await page.goto('/wallets?q=%D8%B3%D8%A7%D8%B1%D8%A9');
      await expect(page.getByRole('cell', { name: 'sara@example.com' })).toBeVisible();
      await page.getByRole('button', { name: ar.wallets.summary.systemAccounts }).click();
      await expect(page.getByText('adjustments:compensation')).toBeVisible();
      await screenshot(page, testInfo, `wallets-${colorScheme}`);
    });
  });
}
