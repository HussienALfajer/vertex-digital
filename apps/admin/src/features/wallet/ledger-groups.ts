import {
  ADJUSTMENT_CATEGORIES,
  type AdjustmentCategory,
  type Currency,
  type LedgerAccountKind,
  type LedgerSummary,
  SUPPLIER_CODES,
  type SupplierCode,
} from '@vertex-digital/contracts';

/*
 * The ledger summary as the owner reads it: each account in a group, with a name and an amount
 * from the store's side, instead of the ledger's raw codes and credit-positive signs (ADR 0003).
 * Display only: every figure here is a sum or a negation of the summary's balances.
 */

/**
 * What the store holds, what it owes, how it did, the owner's money, the conversion pair while
 * pounds wait to be converted, and the test customers' money (not real: outside the result and
 * what is owed).
 */
export const LEDGER_GROUPS = [
  'assets',
  'liabilities',
  'result',
  'capital',
  'exchange',
  'test',
] as const;

export type LedgerGroup = (typeof LEDGER_GROUPS)[number];

/** The name and hint keys of a row (`wallets.ledger.accounts.<key>`, `wallets.ledger.hints.<key>`). */
export type LedgerRowKey =
  | 'sham_cash_receipts_SYP'
  | 'sham_cash_receipts_USD'
  | 'usdt_receipts'
  | 'supplier_prepaid'
  | 'customer_wallets'
  | 'test_customer_wallets'
  | 'sales_revenue'
  | 'refunds'
  | 'cost_of_goods'
  | `adjustments_${Exclude<AdjustmentCategory, 'manual_deposit' | 'cash_refund'>}`
  | 'adjustments_other'
  | 'transfer_fees'
  | 'deposit_rounding'
  | 'supplier_corrections'
  | 'outside_funds'
  | 'owner_drawings'
  | 'adjustments_manual_deposit'
  | 'adjustments_cash_refund'
  | 'currency_exchange_SYP'
  | 'currency_exchange_USD'
  | 'currency_exchange_result'
  | 'test_funds_spent';

export interface LedgerRow {
  key: LedgerRowKey;
  /** The account's code, for whoever needs it; null for the customer wallets' totals. */
  code: string | null;
  currency: Currency;
  /**
   * The amount shown. Held, owed and exchange rows: the store's side of the balance, positive in
   * the normal case. Result and capital rows: the size of the row's effect, never negative.
   */
  units: number;
  /** Result and capital rows: whether the row adds to the total or takes from it. */
  effect: 'add' | 'subtract' | null;
  /** Interpolation for the name: the supplier or the USDT network. */
  params: { supplier?: string; network?: string };
}

export interface LedgerTotal {
  currency: Currency;
  units: number;
}

export interface LedgerGroupView {
  group: LedgerGroup;
  rows: LedgerRow[];
  /**
   * Per currency: held and owed are sums of the rows; result and capital are the net effect
   * (negative is a loss, or money the owner holds out of the store). None for exchange.
   */
  totals: LedgerTotal[];
}

export interface LedgerOverview {
  groups: LedgerGroupView[];
  /** Sales, less refunds and the cost of goods (USD); null before any of the three moved. */
  grossProfitUnits: number | null;
  /** Per currency, the postings' sum where it is not zero: empty when the books balance. */
  imbalances: LedgerTotal[];
}

type SystemAccount = LedgerSummary['systemAccounts'][number];

interface Placement {
  group: LedgerGroup;
  key: LedgerRowKey;
  params?: LedgerRow['params'];
}

/** The part of a code after its kind: `wdgzone` in `supplier_prepaid:wdgzone`. */
const suffixOf = (code: string) => code.slice(code.indexOf(':') + 1);

const isCategory = (value: string): value is AdjustmentCategory =>
  (ADJUSTMENT_CATEGORIES as readonly string[]).includes(value);

const isSupplier = (value: string): value is SupplierCode =>
  (SUPPLIER_CODES as readonly string[]).includes(value);

/**
 * Where each system account kind sits. A manual deposit is money the customer paid the owner
 * outside the store's places, and a cash refund money the owner paid back from outside: both move
 * the owner's money, not the result. The other adjustments are the result's.
 */
const PLACEMENT: Record<
  Exclude<LedgerAccountKind, 'customer_wallet'>,
  (account: SystemAccount) => Placement
> = {
  sham_cash_receipts: ({ currency }) => ({
    group: 'assets',
    key: currency === 'SYP' ? 'sham_cash_receipts_SYP' : 'sham_cash_receipts_USD',
  }),
  usdt_receipts: ({ code }) => ({
    group: 'assets',
    key: 'usdt_receipts',
    params: {
      network: suffixOf(code)
        .replace(/^usdt_/, '')
        .toUpperCase(),
    },
  }),
  supplier_prepaid: ({ code }) => ({
    group: 'assets',
    key: 'supplier_prepaid',
    params: { supplier: suffixOf(code) },
  }),
  sales_revenue: () => ({ group: 'result', key: 'sales_revenue' }),
  refunds: () => ({ group: 'result', key: 'refunds' }),
  cost_of_goods: () => ({ group: 'result', key: 'cost_of_goods' }),
  adjustments: ({ code }) => {
    const category = suffixOf(code);
    if (!isCategory(category)) return { group: 'result', key: 'adjustments_other' };
    // Test funds go to test customers only (rule J4): play money, kept out of the result.
    if (category === 'test_funds') return { group: 'test', key: 'adjustments_test_funds' };
    if (category === 'manual_deposit' || category === 'cash_refund') {
      return { group: 'capital', key: `adjustments_${category}` };
    }
    return { group: 'result', key: `adjustments_${category}` };
  },
  transfer_fees: () => ({ group: 'result', key: 'transfer_fees' }),
  deposit_rounding: () => ({ group: 'result', key: 'deposit_rounding' }),
  supplier_corrections: () => ({ group: 'result', key: 'supplier_corrections' }),
  outside_funds: () => ({ group: 'capital', key: 'outside_funds' }),
  owner_drawings: () => ({ group: 'capital', key: 'owner_drawings' }),
  currency_exchange: ({ currency }) => ({
    group: 'exchange',
    key: currency === 'SYP' ? 'currency_exchange_SYP' : 'currency_exchange_USD',
  }),
};

/** The order rows are shown in, within their group. */
const ROW_ORDER: readonly LedgerRowKey[] = [
  'sham_cash_receipts_SYP',
  'sham_cash_receipts_USD',
  'usdt_receipts',
  'supplier_prepaid',
  'customer_wallets',
  'test_customer_wallets',
  'sales_revenue',
  'refunds',
  'cost_of_goods',
  'adjustments_compensation',
  'adjustments_correction',
  'adjustments_other',
  'transfer_fees',
  'currency_exchange_result',
  'test_funds_spent',
  'deposit_rounding',
  'supplier_corrections',
  'outside_funds',
  'owner_drawings',
  'adjustments_manual_deposit',
  'adjustments_cash_refund',
  'currency_exchange_SYP',
  'currency_exchange_USD',
  'adjustments_test_funds',
];

/** The keys whose rows come before the gross profit line: sales, refunds and the cost of goods. */
export const GROSS_PROFIT_KEYS: readonly LedgerRowKey[] = [
  'sales_revenue',
  'refunds',
  'cost_of_goods',
];

/**
 * A system account as a row. Held money is posted negative (a debit), so it is shown negated, as
 * are test funds (given to test customers). The conversion pair shows the pounds not yet converted
 * (stored positive) and the dollars against them (stored negative). Result and capital rows show
 * the size of their balance, with whether it adds (credit) or takes (debit).
 */
export function systemAccountRow(account: SystemAccount): LedgerRow & { group: LedgerGroup } {
  if (account.kind === 'customer_wallet') {
    throw new Error('A customer wallet is not a system account');
  }
  const { group, key, params = {} } = PLACEMENT[account.kind](account);
  const raw = account.balanceUnits;
  const base = { group, key, params, code: account.code, currency: account.currency };
  switch (group) {
    case 'result':
    case 'capital':
      return { ...base, units: Math.abs(raw), effect: raw < 0 ? 'subtract' : 'add' };
    case 'exchange':
      return { ...base, units: (account.currency === 'SYP' ? raw : -raw) || 0, effect: null };
    default:
      return { ...base, units: -raw || 0, effect: null };
  }
}

/** Sums per currency, USD first. */
function totalsOf(amounts: { currency: Currency; units: number }[]): LedgerTotal[] {
  const sums = new Map<Currency, number>();
  for (const { currency, units } of amounts) sums.set(currency, (sums.get(currency) ?? 0) + units);
  return [...sums]
    .map(([currency, units]) => ({ currency, units }))
    .sort((a, b) => (a.currency === b.currency ? 0 : a.currency === 'USD' ? -1 : 1));
}

const signed = (row: LedgerRow) => (row.effect === 'subtract' ? -row.units : row.units);

/**
 * The conversion pair once no pound waits in it: deposits post pounds +received against dollars
 * −credited, and a treasury conversion takes the pounds out with the dollars they fetched
 * (rules M2, M3). With the pounds side at zero, the dollars side is the conversions' gain
 * (positive) or loss, so it joins the result; the zero pounds side is left out.
 */
function settledExchangeRow(account: SystemAccount): (LedgerRow & { group: LedgerGroup }) | null {
  if (account.currency === 'SYP') return null;
  const raw = account.balanceUnits;
  return {
    group: 'result',
    key: 'currency_exchange_result',
    code: account.code,
    currency: account.currency,
    units: Math.abs(raw),
    effect: raw < 0 ? 'subtract' : 'add',
    params: {},
  };
}

/** The whole summary in groups, with the gross profit and the balance check (ADR 0003). */
export function ledgerOverview(summary: LedgerSummary): LedgerOverview {
  const poundsWaiting = summary.systemAccounts.some(
    (account) =>
      account.kind === 'currency_exchange' &&
      account.currency === 'SYP' &&
      account.balanceUnits !== 0,
  );
  const placed = summary.systemAccounts.flatMap((account) => {
    if (account.kind !== 'currency_exchange' || poundsWaiting) return [systemAccountRow(account)];
    return settledExchangeRow(account) ?? [];
  });
  const wallets = (group: 'liabilities' | 'test', key: LedgerRowKey, units: number) => ({
    group,
    key,
    code: null,
    currency: 'USD' as const,
    units,
    effect: null,
    params: {},
  });
  placed.push(
    wallets('liabilities', 'customer_wallets', summary.owedToCustomersUnits),
    wallets('test', 'test_customer_wallets', summary.owedToTestCustomersUnits),
  );
  // What test customers spent of their play money sits in the sales like real money, while its
  // cost was real: taken back out of the result. Test funds given less what test wallets still
  // hold; nothing when the test wallets got other money too and hold more than they were given.
  const testFundsGiven = -summary.systemAccounts
    .filter((account) => account.code === 'adjustments:test_funds')
    .reduce((sum, account) => sum + account.balanceUnits, 0);
  const testFundsSpent = testFundsGiven - summary.owedToTestCustomersUnits;
  if (testFundsSpent > 0) {
    placed.push({
      group: 'result',
      key: 'test_funds_spent',
      code: null,
      currency: 'USD',
      units: testFundsSpent,
      effect: 'subtract',
      params: {},
    });
  }
  const rank = (row: LedgerRow) => ROW_ORDER.indexOf(row.key);
  const groups = LEDGER_GROUPS.map((group): LedgerGroupView => {
    const rows = placed
      .filter((row) => row.group === group)
      .map(({ group: _, ...row }) => row)
      .sort((a, b) => rank(a) - rank(b) || (a.code ?? '').localeCompare(b.code ?? ''));
    const totals =
      group === 'exchange' || group === 'test'
        ? []
        : group === 'result' || group === 'capital'
          ? totalsOf(rows.map((row) => ({ currency: row.currency, units: signed(row) })))
          : totalsOf(rows);
    return { group, rows, totals };
  });
  const gross = (groups.find((view) => view.group === 'result')?.rows ?? []).filter(
    (row) => GROSS_PROFIT_KEYS.includes(row.key) && row.currency === 'USD',
  );
  const postings = [
    ...summary.systemAccounts.map(({ currency, balanceUnits }) => ({
      currency,
      units: balanceUnits,
    })),
    { currency: 'USD' as const, units: summary.owedToCustomersUnits },
    { currency: 'USD' as const, units: summary.owedToTestCustomersUnits },
  ];
  return {
    groups,
    grossProfitUnits: gross.length === 0 ? null : gross.reduce((sum, row) => sum + signed(row), 0),
    imbalances: totalsOf(postings).filter((total) => total.units !== 0),
  };
}

/** The supplier's name key when the code names a known supplier; else the code as stored. */
export const supplierNameOf = (supplier: string): SupplierCode | null =>
  isSupplier(supplier) ? supplier : null;
