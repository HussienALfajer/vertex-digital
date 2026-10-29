import {
  ADJUSTMENT_CATEGORIES,
  CURRENCY_SCALE,
  LEDGER_ACCOUNT_KINDS,
  type LedgerSummary,
} from '@vertex-digital/contracts';
import { describe, expect, it } from 'vitest';
import ar from '../../i18n/locales/ar.json';
import { ledgerOverview, systemAccountRow } from './ledger-groups';

const DOLLAR = CURRENCY_SCALE.USD;
const units = (dollars: number) => Math.round(dollars * DOLLAR);

type Account = LedgerSummary['systemAccounts'][number];

const account = (code: string, balanceUnits: number, currency: Account['currency'] = 'USD') =>
  ({ kind: code.split(':')[0] as Account['kind'], code, currency, balanceUnits }) satisfies Account;

const summary = (systemAccounts: Account[], owed = 0, owedTest = 0): LedgerSummary => ({
  owedToCustomersUnits: owed,
  owedToTestCustomersUnits: owedTest,
  walletsWithBalance: 0,
  systemAccounts,
});

/** Production's books on 2026-10-29: what the owner found confusing. */
const production = summary([
  account('supplier_prepaid:wdgzone', -units(0.284)),
  account('sales_revenue:USD', units(4.8)),
  account('cost_of_goods:USD', -units(4.568)),
  account('adjustments:compensation', -units(1.8)),
  account('adjustments:correction', -units(3)),
  account('outside_funds:USD', units(4.86)),
  account('transfer_fees:USD', -units(0.008)),
]);

const group = (overview: ReturnType<typeof ledgerOverview>, name: string) =>
  overview.groups.find((view) => view.group === name);

describe('ledgerOverview', () => {
  it("reads production's books from the store's side", () => {
    const overview = ledgerOverview(production);
    expect(group(overview, 'assets')).toEqual({
      group: 'assets',
      rows: [
        {
          key: 'supplier_prepaid',
          code: 'supplier_prepaid:wdgzone',
          currency: 'USD',
          units: units(0.284),
          effect: null,
          params: { supplier: 'wdgzone' },
        },
      ],
      totals: [{ currency: 'USD', units: units(0.284) }],
    });
    const result = group(overview, 'result');
    expect(result?.rows.map((row) => [row.key, row.units, row.effect])).toEqual([
      ['sales_revenue', units(4.8), 'add'],
      ['cost_of_goods', units(4.568), 'subtract'],
      ['adjustments_compensation', units(1.8), 'subtract'],
      ['adjustments_correction', units(3), 'subtract'],
      ['transfer_fees', units(0.008), 'subtract'],
    ]);
    expect(overview.grossProfitUnits).toBe(units(0.232));
    expect(result?.totals).toEqual([{ currency: 'USD', units: -units(4.576) }]);
    expect(group(overview, 'capital')?.totals).toEqual([{ currency: 'USD', units: units(4.86) }]);
    expect(group(overview, 'liabilities')?.rows.map((row) => [row.key, row.units])).toEqual([
      ['customer_wallets', 0],
    ]);
    expect(overview.imbalances).toEqual([]);
  });

  it('balances when what the store holds equals what it owes, its result and the owner money', () => {
    // A $10 Sham Cash deposit in pounds, a $5 sale delivered at $4, $1 of fees on a $20 transfer.
    const books = summary(
      [
        account('sham_cash_receipts:SYP', -150_000 * CURRENCY_SCALE.SYP, 'SYP'),
        account('currency_exchange:SYP', 150_000 * CURRENCY_SCALE.SYP, 'SYP'),
        account('currency_exchange:USD', -units(10)),
        account('sales_revenue:USD', units(5)),
        account('cost_of_goods:USD', -units(4)),
        account('supplier_prepaid:wdgzone', -units(15)),
        account('outside_funds:USD', units(20)),
        account('transfer_fees:USD', -units(1)),
      ],
      units(5),
    );
    const overview = ledgerOverview(books);
    expect(overview.imbalances).toEqual([]);
    expect(group(overview, 'assets')?.totals).toEqual([
      { currency: 'USD', units: units(15) },
      { currency: 'SYP', units: 150_000 * CURRENCY_SCALE.SYP },
    ]);
    expect(group(overview, 'exchange')?.rows.map((row) => [row.key, row.units])).toEqual([
      ['currency_exchange_SYP', 150_000 * CURRENCY_SCALE.SYP],
      ['currency_exchange_USD', units(10)],
    ]);
    expect(group(overview, 'exchange')?.totals).toEqual([]);
    expect(group(overview, 'result')?.totals).toEqual([{ currency: 'USD', units: 0 }]);
  });

  it('reports each currency whose postings do not sum to zero', () => {
    const overview = ledgerOverview(
      summary([account('sales_revenue:USD', units(5))], units(1), units(2)),
    );
    expect(overview.imbalances).toEqual([{ currency: 'USD', units: units(8) }]);
    const syp = ledgerOverview(summary([account('transfer_fees:SYP', -7, 'SYP')]));
    expect(syp.imbalances).toEqual([{ currency: 'SYP', units: -7 }]);
  });

  it('keeps test money out of the result and of what is owed', () => {
    // $25 of test funds to a test customer, who spent $5 of it on a sale that cost $4.
    const overview = ledgerOverview(
      summary(
        [
          account('adjustments:test_funds', -units(25)),
          account('sales_revenue:USD', units(5)),
          account('cost_of_goods:USD', -units(4)),
          account('supplier_prepaid:wdgzone', units(4)),
        ],
        0,
        units(20),
      ),
    );
    expect(overview.imbalances).toEqual([]);
    // The $5 sale was play money; the $4 cost was real.
    expect(group(overview, 'result')?.rows.at(-1)).toMatchObject({
      key: 'test_funds_spent',
      units: units(5),
      effect: 'subtract',
    });
    expect(group(overview, 'result')?.totals).toEqual([{ currency: 'USD', units: -units(4) }]);
    expect(group(overview, 'liabilities')?.totals).toEqual([{ currency: 'USD', units: 0 }]);
    expect(group(overview, 'test')).toEqual({
      group: 'test',
      rows: [
        expect.objectContaining({ key: 'test_customer_wallets', units: units(20) }),
        expect.objectContaining({ key: 'adjustments_test_funds', units: units(25) }),
      ],
      totals: [],
    });
    // Test wallets holding more than their test funds (a compensation too): nothing taken back.
    const more = ledgerOverview(
      summary(
        [
          account('adjustments:test_funds', -units(5)),
          account('adjustments:compensation', -units(5)),
        ],
        0,
        units(10),
      ),
    );
    expect(group(more, 'result')?.rows.map((row) => row.key)).toEqual(['adjustments_compensation']);
  });

  it('shows the conversion pair while pounds wait, and its gain or loss in the result after', () => {
    const SYP = CURRENCY_SCALE.SYP;
    // 1,500,000 ل.س credited $100, then all converted to $97 on USDT: a $3 loss.
    const converted = summary(
      [
        account('currency_exchange:SYP', 0, 'SYP'),
        account('currency_exchange:USD', -units(3)),
        account('usdt_receipts:usdt_trc20', -units(97)),
        account('sham_cash_receipts:SYP', 0, 'SYP'),
      ],
      units(100),
    );
    const settled = ledgerOverview(converted);
    expect(settled.imbalances).toEqual([]);
    expect(group(settled, 'exchange')?.rows).toEqual([]);
    expect(group(settled, 'result')?.rows).toEqual([
      expect.objectContaining({
        key: 'currency_exchange_result',
        code: 'currency_exchange:USD',
        units: units(3),
        effect: 'subtract',
      }),
    ]);
    expect(group(settled, 'result')?.totals).toEqual([{ currency: 'USD', units: -units(3) }]);

    // Half converted: the pair stays apart and the result does not move.
    const half = ledgerOverview(
      summary(
        [
          account('currency_exchange:SYP', 750_000 * SYP, 'SYP'),
          account('currency_exchange:USD', -units(51.5)),
          account('usdt_receipts:usdt_trc20', -units(48.5)),
          account('sham_cash_receipts:SYP', -750_000 * SYP, 'SYP'),
        ],
        units(100),
      ),
    );
    expect(half.imbalances).toEqual([]);
    expect(group(half, 'exchange')?.rows.map((row) => [row.key, row.units])).toEqual([
      ['currency_exchange_SYP', 750_000 * SYP],
      ['currency_exchange_USD', units(51.5)],
    ]);
    expect(group(half, 'result')?.rows).toEqual([]);
  });

  it('has no gross profit before a sale, refund or cost moved', () => {
    expect(ledgerOverview(summary([])).grossProfitUnits).toBeNull();
    const refunded = summary([
      account('sales_revenue:USD', units(10)),
      account('refunds:USD', -units(3)),
      account('cost_of_goods:USD', -units(6)),
    ]);
    expect(ledgerOverview(refunded).grossProfitUnits).toBe(units(1));
  });
});

describe('systemAccountRow', () => {
  it('places every system account kind, each with a name and a hint', () => {
    const groups = new Set<string>();
    for (const kind of LEDGER_ACCOUNT_KINDS) {
      if (kind === 'customer_wallet') continue;
      const row = systemAccountRow({
        kind,
        code: `${kind}:USD`,
        currency: 'USD',
        balanceUnits: -1,
      });
      groups.add(row.group);
      expect(ar.wallets.ledger.accounts[row.key], kind).toBeTruthy();
      expect(ar.wallets.ledger.hints[row.key], kind).toBeTruthy();
    }
    expect([...groups].sort()).toEqual(['assets', 'capital', 'exchange', 'result']);
  });

  it('splits the adjustments by category, the owner money ones into capital', () => {
    const placed = ADJUSTMENT_CATEGORIES.map((category) => {
      const row = systemAccountRow(account(`adjustments:${category}`, -units(1)));
      return [category, row.group, row.key];
    });
    expect(placed).toEqual([
      ['compensation', 'result', 'adjustments_compensation'],
      ['correction', 'result', 'adjustments_correction'],
      ['cash_refund', 'capital', 'adjustments_cash_refund'],
      ['manual_deposit', 'capital', 'adjustments_manual_deposit'],
      ['test_funds', 'test', 'adjustments_test_funds'],
    ]);
    expect(systemAccountRow(account('adjustments:later', 1)).key).toBe('adjustments_other');
  });

  it('shows held money positive, and an overdrawn place negative', () => {
    expect(systemAccountRow(account('usdt_receipts:usdt_trc20', -units(2)))).toMatchObject({
      group: 'assets',
      units: units(2),
      params: { network: 'TRC20' },
    });
    expect(systemAccountRow(account('supplier_prepaid:fake', units(1))).units).toBe(-units(1));
    expect(systemAccountRow(account('sham_cash_receipts:USD', 0)).units).toBe(0);
    expect(Object.is(systemAccountRow(account('sham_cash_receipts:USD', 0)).units, -0)).toBe(false);
  });

  it('shows a result or capital row by its size and its direction', () => {
    expect(systemAccountRow(account('adjustments:correction', units(2)))).toMatchObject({
      units: units(2),
      effect: 'add',
    });
    expect(systemAccountRow(account('owner_drawings:USD', -units(3)))).toMatchObject({
      group: 'capital',
      units: units(3),
      effect: 'subtract',
    });
  });

  it('refuses a customer wallet', () => {
    expect(() =>
      systemAccountRow({ kind: 'customer_wallet', code: 'x', currency: 'USD', balanceUnits: 0 }),
    ).toThrow();
  });
});
