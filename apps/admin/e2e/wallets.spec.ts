import type { Page } from '@playwright/test';
import type { LedgerSummary } from '@vertex-digital/contracts';
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
 * Wallets (S02): the books from the owner's side and the search with the wallet lists below it, a
 * customer's wallet, adjustments with re-authentication, the typed confirmation above $100, and
 * reversals, against the mocked API.
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

/** A row of the books' summary, by the account's name. */
const ledgerRow = (page: Page, name: string) => page.getByRole('row').filter({ hasText: name });

/** Production's books on 2026-10-29, which sum to zero with empty customer wallets. */
const PRODUCTION_ACCOUNTS: LedgerSummary['systemAccounts'] = [
  {
    kind: 'supplier_prepaid',
    code: 'supplier_prepaid:wdgzone',
    currency: 'USD',
    balanceUnits: -284_000,
  },
  { kind: 'sales_revenue', code: 'sales_revenue:USD', currency: 'USD', balanceUnits: 4_800_000 },
  { kind: 'cost_of_goods', code: 'cost_of_goods:USD', currency: 'USD', balanceUnits: -4_568_000 },
  {
    kind: 'adjustments',
    code: 'adjustments:compensation',
    currency: 'USD',
    balanceUnits: -1_800_000,
  },
  {
    kind: 'adjustments',
    code: 'adjustments:correction',
    currency: 'USD',
    balanceUnits: -3_000_000,
  },
  { kind: 'outside_funds', code: 'outside_funds:USD', currency: 'USD', balanceUnits: 4_860_000 },
  { kind: 'transfer_fees', code: 'transfer_fees:USD', currency: 'USD', balanceUnits: -8_000 },
];

/** The books of three 700 ل.س deposits at 140 and two USDT deposits (S03 M2, S04 M1). */
const DEPOSIT_ACCOUNTS: LedgerSummary['systemAccounts'] = [
  {
    kind: 'sham_cash_receipts',
    code: 'sham_cash_receipts:SYP',
    currency: 'SYP',
    balanceUnits: -210_000,
  },
  {
    kind: 'currency_exchange',
    code: 'currency_exchange:SYP',
    currency: 'SYP',
    balanceUnits: 210_000,
  },
  {
    kind: 'currency_exchange',
    code: 'currency_exchange:USD',
    currency: 'USD',
    balanceUnits: -15_000_000,
  },
  {
    kind: 'usdt_receipts',
    code: 'usdt_receipts:usdt_trc20',
    currency: 'USD',
    balanceUnits: -5_003_700,
  },
  { kind: 'deposit_rounding', code: 'deposit_rounding:USD', currency: 'USD', balanceUnits: 9_300 },
];

test.describe('wallets', () => {
  test('the summary, then a search by name and by phone opens the wallet', async ({
    page,
    admin,
  }) => {
    await open(page, admin, '/');
    await page.getByRole('link', { name: ar.nav.wallets }).first().click();
    await expect(page.getByText(ar.wallets.summary.balanced)).toBeVisible();
    await expect(ledgerRow(page, ar.wallets.ledger.accounts.customer_wallets)).toContainText(
      '$0.00',
    );
    // No wallet moved yet: the search prompt stands in for the two lists.
    await expect(page.getByText(ar.wallets.search.promptTitle, { exact: true })).toBeVisible();

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

  test('system accounts show each balance in its own currency, from the store side (F6-1)', async ({
    page,
    admin,
  }) => {
    admin.ledgerAccounts = DEPOSIT_ACCOUNTS;
    // The customers the deposits credited: $15.00 for the pounds, $4.9944 for the USDT.
    admin.owedToCustomersUnits = 19_994_400;
    await open(page, admin, '/wallets');
    await expect(page.getByText(ar.wallets.summary.balanced)).toBeVisible();
    const accounts = ar.wallets.ledger.accounts;
    await expect(ledgerRow(page, accounts.sham_cash_receipts_SYP)).toContainText('2,100 ل.س');
    await expect(ledgerRow(page, accounts.sham_cash_receipts_SYP)).not.toContainText('−');
    await expect(ledgerRow(page, accounts.currency_exchange_SYP)).toContainText('2,100 ل.س');
    await expect(ledgerRow(page, accounts.currency_exchange_SYP)).not.toContainText('$');
    await expect(ledgerRow(page, accounts.currency_exchange_USD)).toContainText('$15.00');
    await expect(ledgerRow(page, accounts.currency_exchange_USD)).not.toContainText('-');
    const usdt = accounts.usdt_receipts.replace('{{network}}', 'TRC20');
    await expect(ledgerRow(page, usdt)).toContainText('$5.0037');
    await expect(ledgerRow(page, accounts.deposit_rounding)).toContainText(ar.wallets.summary.add);
    await expect(ledgerRow(page, accounts.deposit_rounding)).toContainText('$0.0093');
    await expect(ledgerRow(page, accounts.customer_wallets)).toContainText('$19.9944');
    // The raw code is only in the row's explanation.
    await expect(page.getByText('usdt_receipts:usdt_trc20')).toBeHidden();
    await page
      .getByRole('button', { name: ar.wallets.summary.about.replace('{{name}}', usdt) })
      .click();
    await expect(
      page.getByRole('dialog').getByText(ar.wallets.ledger.hints.usdt_receipts),
    ).toBeVisible();
    await expect(page.getByRole('dialog').getByText('usdt_receipts:usdt_trc20')).toBeVisible();
  });

  test("production's books read in plain words, with the gross profit and the net", async ({
    page,
    admin,
  }) => {
    admin.ledgerAccounts = PRODUCTION_ACCOUNTS;
    await open(page, admin, '/wallets');
    await expect(page.getByText(ar.wallets.summary.balanced)).toBeVisible();
    const accounts = ar.wallets.ledger.accounts;
    const supplier = accounts.supplier_prepaid.replace('{{supplier}}', 'WDGZone');
    await expect(ledgerRow(page, supplier)).toContainText('$0.284');
    await expect(ledgerRow(page, supplier)).not.toContainText('-');
    await expect(page.getByText('supplier_prepaid:wdgzone')).toBeHidden();
    const { add, subtract } = ar.wallets.summary;
    for (const [name, effect, amount] of [
      [accounts.sales_revenue, add, '$4.80'],
      [accounts.cost_of_goods, subtract, '$4.568'],
      [accounts.adjustments_compensation, subtract, '$1.80'],
      [accounts.adjustments_correction, subtract, '$3.00'],
      [accounts.transfer_fees, subtract, '$0.008'],
      [accounts.outside_funds, add, '$4.86'],
    ] as const) {
      await expect(ledgerRow(page, name), name).toContainText(effect);
      await expect(ledgerRow(page, name), name).toContainText(amount);
    }
    await expect(ledgerRow(page, ar.wallets.ledger.grossProfit)).toContainText(
      ar.wallets.ledger.profit,
    );
    await expect(ledgerRow(page, ar.wallets.ledger.grossProfit)).toContainText('$0.232');
    await expect(ledgerRow(page, ar.wallets.ledger.net)).toContainText(ar.wallets.ledger.loss);
    await expect(ledgerRow(page, ar.wallets.ledger.net)).toContainText('$4.576');
    await expect(ledgerRow(page, ar.wallets.ledger.capitalNet)).toContainText('$4.86');
    // The conversion pair has not moved: its group stays out.
    await expect(
      page.getByRole('heading', { name: ar.wallets.ledger.groups.exchange }),
    ).toBeHidden();
  });

  test('books whose postings do not sum to zero say so, with the difference', async ({
    page,
    admin,
  }) => {
    admin.ledgerAccounts = DEPOSIT_ACCOUNTS;
    await open(page, admin, '/wallets');
    await expect(page.getByText(ar.wallets.summary.unbalanced)).toBeVisible();
    await expect(page.getByText(ar.wallets.summary.balanced)).toBeHidden();
    await expect(page.getByText(ar.wallets.summary.unbalancedTitle)).toBeVisible();
    await expect(page.getByText('-$19.9944')).toBeVisible();
  });

  test('below the search, the wallets with a balance and the last to move open the wallet', async ({
    page,
    admin,
  }) => {
    await open(page, admin, `/wallets/${CUSTOMER_ID}`);
    await adjust(page, { amount: '25', category: 'test_funds' });
    await page.goto('/wallets');
    const withBalance = page.getByRole('region', { name: ar.wallets.search.withBalance });
    const moved = page.getByRole('region', { name: ar.wallets.search.recentlyMoved });
    await expect(withBalance.getByRole('row').filter({ hasText: 'سارة الأحمد' })).toContainText(
      '$25.00',
    );
    await expect(withBalance.getByText(ar.wallets.testBadge)).toBeVisible();
    await expect(moved.getByRole('cell', { name: 'sara@example.com' })).toBeVisible();
    await moved.getByRole('cell', { name: 'sara@example.com' }).click();
    await expect(page).toHaveURL(`/wallets/${CUSTOMER_ID}`);
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
    await expect(page.getByRole('dialog')).toHaveCount(0);

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
      // The amount kept whole in the Arabic sentence (audit A02-39).
      page.getByText(ar.wallets.adjust.insufficient.replace('{{balance}}', '⁦$275.00⁩')),
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

  test('a reversal made elsewhere meanwhile is refused in the dialog, with the amount on its button (A02-16, A02-18)', async ({
    page,
    admin,
  }) => {
    await open(page, admin, `/wallets/${CUSTOMER_ID}`);
    await adjust(page, { amount: '25', category: 'compensation' });
    await page
      .getByRole('button', {
        name: ar.wallets.detail.reverseLabel.replace('{{amount}}', '$25.00'),
      })
      .click();
    const dialog = page.getByRole('dialog');
    await field(page, ar.wallets.adjust.reason).fill('تعويض مكرر بالخطأ');
    // Another tab reversed it meanwhile.
    const [original] = admin.adjustments;
    if (!original) throw new Error('No adjustment');
    admin.adjustments.push({
      ...original,
      id: crypto.randomUUID(),
      direction: 'debit',
      reversesAdjustmentId: original.id,
    });
    await dialog
      .getByRole('button', {
        name: ar.wallets.reverse.submitAmount.replace('{{amount}}', '⁦−$25.00⁩'),
      })
      .click();
    await expect(dialog.getByText(ar.errors.api.ADJUSTMENT_ALREADY_REVERSED)).toBeVisible();
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

      // Production's books with the mock's compensations in place of its own, and $1.80 less
      // brought in from outside to keep them balanced.
      admin.ledgerAccounts = PRODUCTION_ACCOUNTS.filter(
        (item) => item.code !== 'adjustments:compensation',
      ).map((item) =>
        item.kind === 'outside_funds' ? { ...item, balanceUnits: 3_060_000 } : item,
      );
      await page.goto('/wallets');
      await expect(page.getByText(ar.wallets.summary.balanced)).toBeVisible();
      await expect(
        page.getByRole('region', { name: ar.wallets.search.recentlyMoved }).getByRole('row'),
      ).toHaveCount(2);
      await screenshot(page, testInfo, `wallets-${colorScheme}`);
      const fees = ar.wallets.ledger.accounts.transfer_fees;
      await page
        .getByRole('button', { name: ar.wallets.summary.about.replace('{{name}}', fees) })
        .click();
      await expect(page.getByRole('dialog').getByText('transfer_fees:USD')).toBeVisible();
      await screenshot(page, testInfo, `wallets-explanation-${colorScheme}`);
      await page.keyboard.press('Escape');

      await page.goto('/wallets?q=%D8%B3%D8%A7%D8%B1%D8%A9');
      await expect(page.getByRole('cell', { name: 'sara@example.com' })).toBeVisible();
      await screenshot(page, testInfo, `wallets-search-${colorScheme}`);
    });
  });
}
