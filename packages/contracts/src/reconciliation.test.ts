import { describe, expect, it } from 'vitest';
import {
  correctionEndpoints,
  createSupplierCorrectionSchema,
  createTreasuryMovementSchema,
  isInternalCheck,
  isOutsidePlace,
  isWarningResult,
  JOURNAL_ACCOUNT_KINDS,
  placeAmountValid,
  RECONCILIATION_CHECKS,
  reconciliationSettingsSchema,
  shamCashCountSchema,
  supplierOfPlace,
  supplierPlace,
  sypTolerance,
  TREASURY_ACCOUNTS,
  TREASURY_ENDPOINTS,
  TREASURY_PLACES,
  treasuryConfirmationError,
  treasuryEndpointOf,
  treasuryMovementError,
  treasuryPostings,
} from './reconciliation.js';
import { SUPPLIER_CODES } from './suppliers.js';
import { JOURNAL_KINDS, LEDGER_ACCOUNT_KINDS } from './wallet.js';

const USD = 1_000_000;

describe('places (rule T1)', () => {
  it('has a place per supplier and maps each endpoint to one account', () => {
    for (const code of SUPPLIER_CODES) {
      expect(TREASURY_PLACES).toContain(supplierPlace(code));
      expect(supplierOfPlace(supplierPlace(code))).toBe(code);
    }
    expect(TREASURY_ACCOUNTS.sham_cash_syp).toEqual({
      code: 'sham_cash_receipts:SYP',
      kind: 'sham_cash_receipts',
      currency: 'SYP',
    });
    expect(TREASURY_ACCOUNTS.usdt_bep20.code).toBe('usdt_receipts:usdt_bep20');
    expect(TREASURY_ACCOUNTS['supplier:wdgzone'].code).toBe('supplier_prepaid:wdgzone');
    expect(TREASURY_ACCOUNTS['supplier:fazercards'].code).toBe('supplier_prepaid:fazercards');
    expect(TREASURY_ACCOUNTS.outside_syp).toMatchObject({ kind: 'outside_funds', currency: 'SYP' });
    const codes = TREASURY_ENDPOINTS.map((endpoint) => TREASURY_ACCOUNTS[endpoint].code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const endpoint of TREASURY_ENDPOINTS) {
      expect(treasuryEndpointOf(TREASURY_ACCOUNTS[endpoint].code)).toBe(endpoint);
    }
    expect(treasuryEndpointOf('sales_revenue:USD')).toBeNull();
    expect(supplierOfPlace('usdt_trc20')).toBeNull();
    expect(isOutsidePlace('outside_usd')).toBe(true);
    expect(isOutsidePlace('sham_cash_usd')).toBe(false);
  });

  it('wants whole cents in USD places but a supplier place (rule T3)', () => {
    expect(placeAmountValid('usdt_trc20', 25 * USD)).toBe(true);
    expect(placeAmountValid('usdt_trc20', 25 * USD + 1)).toBe(false);
    expect(placeAmountValid('supplier:fake', 1)).toBe(true);
    expect(placeAmountValid('sham_cash_syp', 1)).toBe(true);
    expect(placeAmountValid('sham_cash_usd', 0)).toBe(false);
    expect(placeAmountValid('outside_usd', 1.5)).toBe(false);
  });

  it('allows each journal kind its accounts (rule C4)', () => {
    expect(Object.keys(JOURNAL_ACCOUNT_KINDS).sort()).toEqual([...JOURNAL_KINDS].sort());
    for (const kinds of Object.values(JOURNAL_ACCOUNT_KINDS)) {
      for (const kind of kinds) expect(LEDGER_ACCOUNT_KINDS).toContain(kind);
    }
    for (const endpoint of TREASURY_ENDPOINTS) {
      expect(JOURNAL_ACCOUNT_KINDS.treasury).toContain(TREASURY_ACCOUNTS[endpoint].kind);
    }
  });
});

describe('movements', () => {
  it('refuses the same place, outside to outside and more received than sent (T2, T3)', () => {
    const base = { sentUnits: 10 * USD, receivedUnits: 10 * USD };
    expect(treasuryMovementError({ ...base, from: 'usdt_trc20', to: 'usdt_trc20' })).toBe(
      'TREASURY_PLACES_INVALID',
    );
    expect(treasuryMovementError({ ...base, from: 'outside_usd', to: 'outside_syp' })).toBe(
      'TREASURY_PLACES_INVALID',
    );
    expect(
      treasuryMovementError({
        ...base,
        from: 'usdt_trc20',
        to: 'supplier:fake',
        receivedUnits: 11 * USD,
      }),
    ).toBe('MOVEMENT_RECEIVED_EXCEEDS_SENT');
    // Two currencies: received is in another unit, never compared.
    expect(
      treasuryMovementError({
        from: 'sham_cash_syp',
        to: 'usdt_trc20',
        sentUnits: 100,
        receivedUnits: USD,
      }),
    ).toBeNull();
    expect(treasuryMovementError({ ...base, from: 'outside_usd', to: 'usdt_trc20' })).toBeNull();
  });

  it('posts a same-currency transfer with its fee (rule M1)', () => {
    const postings = treasuryPostings({
      from: 'usdt_trc20',
      to: 'supplier:wdgzone',
      sentUnits: 500 * USD,
      receivedUnits: 499 * USD,
      reversal: false,
    });
    expect(postings.map((posting) => [posting.code, posting.amountUnits])).toEqual([
      ['usdt_receipts:usdt_trc20', 500 * USD],
      ['supplier_prepaid:wdgzone', -499 * USD],
      ['transfer_fees:USD', -1 * USD],
    ]);
    const noFee = treasuryPostings({
      from: 'outside_usd',
      to: 'supplier:fake',
      sentUnits: 200 * USD,
      receivedUnits: 200 * USD,
      reversal: false,
    });
    expect(noFee).toHaveLength(2);
    expect(() =>
      treasuryPostings({
        from: 'usdt_trc20',
        to: 'supplier:fake',
        sentUnits: 1,
        receivedUnits: 2,
        reversal: false,
      }),
    ).toThrow(RangeError);
  });

  it('posts two currencies through the exchange account (rule M2) and balances per currency', () => {
    const postings = treasuryPostings({
      from: 'sham_cash_syp',
      to: 'usdt_trc20',
      sentUnits: 1_300_000_00,
      receivedUnits: 100 * USD,
      reversal: false,
    });
    expect(postings.map((posting) => [posting.code, posting.amountUnits])).toEqual([
      ['sham_cash_receipts:SYP', 1_300_000_00],
      ['currency_exchange:SYP', -1_300_000_00],
      ['currency_exchange:USD', 100 * USD],
      ['usdt_receipts:usdt_trc20', -100 * USD],
    ]);
    for (const currency of ['USD', 'SYP'] as const) {
      const sum = postings
        .filter((posting) => posting.currency === currency)
        .reduce((total, posting) => total + posting.amountUnits, 0);
      expect(sum).toBe(0);
    }
  });

  it('mirrors every sign on a reversal (rule M4)', () => {
    const movement = {
      from: 'usdt_trc20',
      to: 'outside_usd',
      sentUnits: 5 * USD,
      receivedUnits: 5 * USD,
    } as const;
    const original = treasuryPostings({ ...movement, reversal: false });
    const reversal = treasuryPostings({ ...movement, reversal: true });
    expect(reversal.map((posting) => posting.amountUnits)).toEqual(
      original.map((posting) => -posting.amountUnits),
    );
  });

  it('turns a supplier correction into endpoints (rules T5, M3)', () => {
    expect(correctionEndpoints('fake', 'increase')).toEqual({
      from: 'supplier_corrections',
      to: 'supplier:fake',
    });
    const decrease = correctionEndpoints('fake', 'decrease');
    expect(decrease).toEqual({ from: 'supplier:fake', to: 'supplier_corrections' });
    const postings = treasuryPostings({
      ...decrease,
      sentUnits: 3,
      receivedUnits: 3,
      reversal: false,
    });
    expect(postings.map((posting) => [posting.code, posting.amountUnits])).toEqual([
      ['supplier_prepaid:fake', 3],
      ['supplier_corrections:USD', -3],
    ]);
  });

  it('asks for the amount again above $100 of value (rule T7)', () => {
    expect(treasuryConfirmationError(100 * USD, 100 * USD, undefined)).toBeNull();
    expect(treasuryConfirmationError(101 * USD, 101 * USD, undefined)).toBe(
      'AMOUNT_CONFIRMATION_REQUIRED',
    );
    expect(treasuryConfirmationError(500, null, undefined)).toBe('AMOUNT_CONFIRMATION_REQUIRED');
    expect(treasuryConfirmationError(101 * USD, 101 * USD, 101 * USD)).toBeNull();
    expect(treasuryConfirmationError(5 * USD, 5 * USD, 6 * USD)).toBe(
      'AMOUNT_CONFIRMATION_MISMATCH',
    );
  });

  it('validates a movement request (rules T3, T4, T6)', () => {
    const base = {
      from: 'usdt_trc20',
      to: 'supplier:fake',
      sentUnits: 20 * USD,
      receivedUnits: 19 * USD,
      reason: 'Funding the fake supplier',
    } as const;
    expect(createTreasuryMovementSchema.parse(base).openingBalance).toBe(false);
    const paths = (input: object) =>
      createTreasuryMovementSchema.safeParse(input).error?.issues.map((issue) => issue.path[0]);
    expect(paths({ ...base, sentUnits: 20 * USD + 1 })).toEqual(['sentUnits']);
    expect(paths({ ...base, to: 'usdt_bep20', receivedUnits: 1 })).toEqual(['receivedUnits']);
    expect(paths({ ...base, outsideCategory: 'owner' })).toEqual(['outsideCategory']);
    expect(paths({ ...base, to: 'outside_usd', receivedUnits: 20 * USD })).toEqual([
      'outsideCategory',
    ]);
    expect(paths({ ...base, openingBalance: true })).toEqual(['openingBalance']);
    expect(
      paths({ ...base, from: 'outside_usd', outsideCategory: 'other', openingBalance: true }),
    ).toEqual(['openingBalance']);
    expect(
      paths({ ...base, from: 'outside_usd', outsideCategory: 'owner', openingBalance: true }),
    ).toBeUndefined();
    expect(paths({ ...base, reason: 'no' })).toEqual(['reason']);
    // A reference compares as deposit claims do: marks, spaces and Arabic-Indic digits cleaned (A09-3).
    const unclaimed = {
      ...base,
      from: 'outside_syp',
      to: 'sham_cash_syp',
      sentUnits: 10_000 * 100,
      receivedUnits: 10_000 * 100,
      outsideCategory: 'unclaimed_receipt',
    } as const;
    expect(
      createTreasuryMovementSchema.parse({ ...unclaimed, externalReference: '\u200f١٢٣ ٤٥٦٧٨' })
        .externalReference,
    ).toBe('12345678');
    // An unclaimed USDT receipt names its TXID, as a hash or an explorer link.
    const usdt = {
      ...unclaimed,
      from: 'outside_usd',
      to: 'usdt_trc20',
      sentUnits: 5 * USD,
      receivedUnits: 5 * USD,
    } as const;
    expect(paths({ ...usdt, externalReference: 'NOT-A-TXID' })).toEqual(['externalReference']);
    expect(paths({ ...usdt, externalReference: `0x${'ab'.repeat(32)}` })).toBeUndefined();
  });

  it('validates a supplier correction and normalizes its order number', () => {
    const parsed = createSupplierCorrectionSchema.parse({
      supplier: 'fake',
      direction: 'decrease',
      amountUnits: 1,
      orderNumber: 'vo7kq2mx',
      reason: 'Double delivery charged',
    });
    expect(parsed.orderNumber).toBe('VO-7KQ2MX');
    expect(createSupplierCorrectionSchema.safeParse({ ...parsed, amountUnits: 0 }).success).toBe(
      false,
    );
  });
});

describe('reconciliation', () => {
  it('splits the checks and counts skipped results as warnings (rule E5)', () => {
    expect(new Set(RECONCILIATION_CHECKS).size).toBe(RECONCILIATION_CHECKS.length);
    expect(isInternalCheck('journal_balance')).toBe(true);
    expect(isInternalCheck('supplier_balance')).toBe(false);
    expect(isWarningResult({ status: 'warning', reason: null })).toBe(true);
    expect(isWarningResult({ status: 'skipped', reason: 'opening_missing' })).toBe(true);
    expect(isWarningResult({ status: 'skipped', reason: 'currency_unsupported' })).toBe(false);
    expect(isWarningResult({ status: 'mismatch', reason: null })).toBe(false);
  });

  it('converts the tolerance to whole pounds, rounded up (rule E1)', () => {
    expect(sypTolerance(USD, '13000')).toBe(13_000_00);
    expect(sypTolerance(USD, '118.5')).toBe(119_00);
    expect(sypTolerance(USD, null)).toBe(0);
  });

  it('bounds the settings and the counts', () => {
    expect(
      reconciliationSettingsSchema.safeParse({ toleranceUsdUnits: USD, countStaleDays: 7 }).success,
    ).toBe(true);
    expect(
      reconciliationSettingsSchema.safeParse({ toleranceUsdUnits: 101 * USD, countStaleDays: 7 })
        .success,
    ).toBe(false);
    expect(
      reconciliationSettingsSchema.safeParse({ toleranceUsdUnits: 1, countStaleDays: 7 }).success,
    ).toBe(false);
    expect(
      reconciliationSettingsSchema.safeParse({ toleranceUsdUnits: 0, countStaleDays: 61 }).success,
    ).toBe(false);
    expect(shamCashCountSchema.safeParse({ currency: 'USD', countedUnits: 1 }).success).toBe(false);
    expect(shamCashCountSchema.safeParse({ currency: 'SYP', countedUnits: 1 }).success).toBe(true);
    expect(shamCashCountSchema.safeParse({ currency: 'USD', countedUnits: 0 }).success).toBe(true);
  });
});
