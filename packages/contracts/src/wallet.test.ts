import { describe, expect, it } from 'vitest';
import { CURRENCY_SCALE } from './money.js';
import {
  ADJUSTMENT_CATEGORIES,
  ADJUSTMENT_CATEGORY_DIRECTIONS,
  ADJUSTMENT_CONFIRMATION_THRESHOLD_USD_UNITS,
  ADJUSTMENT_DIRECTIONS,
  adminWalletEntrySchema,
  amountConfirmationError,
  createAdjustmentSchema,
  isAllowedAdjustment,
  JOURNAL_KINDS,
  journalKindSchema,
  LEDGER_ACCOUNT_KINDS,
  ledgerAccountKindSchema,
  MANUAL_DEPOSIT_METHODS,
  reverseAdjustmentSchema,
  walletEntryQuerySchema,
  walletEntrySchema,
  walletSearchQuerySchema,
} from './wallet.js';

const USD = CURRENCY_SCALE.USD;

describe('ledger kinds', () => {
  it('are snake_case, as the database enums that reuse them', () => {
    for (const kind of [
      ...LEDGER_ACCOUNT_KINDS,
      ...JOURNAL_KINDS,
      ...ADJUSTMENT_DIRECTIONS,
      ...ADJUSTMENT_CATEGORIES,
      ...MANUAL_DEPOSIT_METHODS,
    ]) {
      expect(kind).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*$/);
    }
  });

  it('accept only known kinds', () => {
    expect(ledgerAccountKindSchema.safeParse('customer_wallet').success).toBe(true);
    expect(ledgerAccountKindSchema.safeParse('savings').success).toBe(false);
    expect(journalKindSchema.safeParse('purchase').success).toBe(true);
    expect(journalKindSchema.safeParse('withdrawal').success).toBe(false);
  });
});

describe('adjustment categories (rule J1)', () => {
  it('allow exactly the directions of the spec table', () => {
    const table = Object.fromEntries(
      ADJUSTMENT_CATEGORIES.map((category) => [
        category,
        ADJUSTMENT_DIRECTIONS.filter((direction) => isAllowedAdjustment(category, direction)),
      ]),
    );
    expect(table).toEqual({
      compensation: ['credit'],
      correction: ['credit', 'debit'],
      cash_refund: ['debit'],
      manual_deposit: ['credit'],
      test_funds: ['credit', 'debit'],
    });
    expect(Object.keys(ADJUSTMENT_CATEGORY_DIRECTIONS).sort()).toEqual(
      [...ADJUSTMENT_CATEGORIES].sort(),
    );
  });
});

describe('amount confirmation (rule J6)', () => {
  const threshold = ADJUSTMENT_CONFIRMATION_THRESHOLD_USD_UNITS;

  it('is $100, and exactly $100 needs none', () => {
    expect(threshold).toBe(100 * USD);
    expect(amountConfirmationError(threshold, undefined)).toBeNull();
  });

  it('is required one cent above, and must equal the amount', () => {
    const above = threshold + 10_000;
    expect(amountConfirmationError(above, undefined)).toBe('AMOUNT_CONFIRMATION_REQUIRED');
    expect(amountConfirmationError(above, above)).toBeNull();
    expect(amountConfirmationError(above, threshold)).toBe('AMOUNT_CONFIRMATION_MISMATCH');
  });

  it('below the threshold, is ignored when equal and refused when different (edge case 10)', () => {
    expect(amountConfirmationError(25 * USD, 25 * USD)).toBeNull();
    expect(amountConfirmationError(25 * USD, 26 * USD)).toBe('AMOUNT_CONFIRMATION_MISMATCH');
  });
});

describe('createAdjustmentSchema', () => {
  const valid = {
    direction: 'credit',
    amountUnits: 25 * USD,
    category: 'compensation',
    reason: 'Late delivery on order 42',
  } as const;

  it('takes whole cents above zero (rule J10)', () => {
    expect(createAdjustmentSchema.safeParse(valid).success).toBe(true);
    for (const amountUnits of [0, -USD, 10_001, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(createAdjustmentSchema.safeParse({ ...valid, amountUnits }).success).toBe(false);
    }
  });

  it('refuses a direction its category does not allow (rule J1)', () => {
    const result = createAdjustmentSchema.safeParse({ ...valid, direction: 'debit' });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([['direction']]);
  });

  it('trims the reason and note, and bounds them', () => {
    const parsed = createAdjustmentSchema.parse({
      ...valid,
      reason: '  Late delivery  ',
      customerNote: ' Sorry for the wait ',
    });
    expect(parsed).toMatchObject({ reason: 'Late delivery', customerNote: 'Sorry for the wait' });
    expect(createAdjustmentSchema.safeParse({ ...valid, reason: '   abcd ' }).success).toBe(false);
    expect(createAdjustmentSchema.safeParse({ ...valid, reason: 'x'.repeat(501) }).success).toBe(
      false,
    );
    expect(createAdjustmentSchema.safeParse({ ...valid, customerNote: '  ' }).success).toBe(false);
    expect(
      createAdjustmentSchema.safeParse({ ...valid, customerNote: 'x'.repeat(201) }).success,
    ).toBe(false);
  });

  it('needs a method and a reference for a manual deposit, and only then (rule J8)', () => {
    const manual = { ...valid, category: 'manual_deposit' } as const;
    expect(createAdjustmentSchema.safeParse(manual).error?.issues.map((i) => i.path)).toEqual([
      ['depositMethod'],
      ['externalReference'],
    ]);
    expect(
      createAdjustmentSchema.parse({
        ...manual,
        depositMethod: 'sham_cash',
        externalReference: ' abc123 ',
      }).externalReference,
    ).toBe('abc123');
    expect(
      createAdjustmentSchema
        .safeParse({ ...valid, depositMethod: 'usdt_trc20', externalReference: 'x' })
        .error?.issues.map((issue) => issue.path),
    ).toEqual([['depositMethod'], ['externalReference']]);
    expect(
      createAdjustmentSchema.safeParse({
        ...manual,
        depositMethod: 'sham_cash',
        externalReference: 'x'.repeat(101),
      }).success,
    ).toBe(false);
  });

  it('carries the typed confirmation as units', () => {
    const input = { ...valid, amountUnits: 250 * USD, amountConfirmationUnits: 250 * USD };
    expect(createAdjustmentSchema.parse(input).amountConfirmationUnits).toBe(250 * USD);
  });
});

describe('reverseAdjustmentSchema', () => {
  it('needs only an internal reason', () => {
    expect(reverseAdjustmentSchema.safeParse({ reason: 'Wrong customer' }).success).toBe(true);
    expect(reverseAdjustmentSchema.safeParse({}).success).toBe(false);
  });
});

describe('timeline entries (rules W5, W6)', () => {
  it('never show the customer the reason, the admin, journal ids or accounts', () => {
    const keys = [
      ...Object.keys(walletEntrySchema.shape),
      ...Object.keys(walletEntrySchema.shape.adjustment.unwrap().shape),
    ];
    for (const hidden of [
      'reason',
      'adminName',
      'adminId',
      'journalId',
      'accountId',
      'code',
      'externalReference',
    ]) {
      expect(keys).not.toContain(hidden);
    }
    expect(Object.keys(adminWalletEntrySchema.shape.adjustment.unwrap().shape)).toEqual(
      expect.arrayContaining(['reason', 'adminName', 'reversedByAdjustmentId']),
    );
  });

  it('default to pages of 30 (rule W7)', () => {
    expect(walletEntryQuerySchema.parse({})).toEqual({ limit: 30 });
  });
});

describe('walletSearchQuerySchema', () => {
  it('needs 3 characters after trimming', () => {
    expect(walletSearchQuerySchema.parse({ q: ' abc ' })).toEqual({ q: 'abc', limit: 50 });
    expect(walletSearchQuerySchema.safeParse({ q: ' ab ' }).success).toBe(false);
    expect(walletSearchQuerySchema.safeParse({ q: 'x'.repeat(101) }).success).toBe(false);
  });
});
