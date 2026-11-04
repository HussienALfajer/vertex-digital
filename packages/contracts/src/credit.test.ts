import { describe, expect, it } from 'vitest';
import { createProductSchema, inputFieldShapeSchema, updateProductSchema } from './catalog.js';
import {
  amountOfQuantity,
  CREDIT_POLICY_DEFAULTS,
  type CreditLimitFacts,
  cashApprovalInputSchema,
  cashEligibleBalance,
  cashHoldExpiresAt,
  cashNeedsApproval,
  cashTelegramDecides,
  creditLimitRefusal,
  creditPolicySchema,
  creditRemaining,
  groupRecipient,
  inCreditSection,
  maskRecipient,
  normalizeSyrianMobile,
  quantityOfAmount,
  recipientNeedsAlert,
  recipientNumberSchema,
  syrianOperatorOf,
  WRONG_OPERATOR,
} from './credit.js';
import { USD_CENT } from './money.js';
import { orderFieldValuesSchema } from './orders.js';

const usd = (dollars: number) => Math.round(dollars * 100) * USD_CENT;

describe('recipient numbers (RN1)', () => {
  it.each([
    ['0933123456'],
    ['933123456'],
    ['+963933123456'],
    ['00963933123456'],
    ['963933123456'],
    ['0933 123 456'],
    ['+963 933-123-456'],
    ['٠٩٣٣١٢٣٤٥٦'],
    ['۰۹۳۳۱۲۳۴۵۶'],
  ])('normalises %s to 0933123456', (typed) => {
    expect(normalizeSyrianMobile(typed)).toBe('0933123456');
  });

  it.each([['0833123456'], ['093312345'], ['09331234567'], ['+962933123456'], ['abc'], ['']])(
    'refuses %s',
    (typed) => {
      expect(normalizeSyrianMobile(typed)).toBeNull();
    },
  );

  it('names the operator by its prefix', () => {
    for (const prefix of ['093', '098', '099'])
      expect(syrianOperatorOf(`${prefix}1234567`)).toBe('syriatel');
    for (const prefix of ['094', '095', '096'])
      expect(syrianOperatorOf(`${prefix}1234567`)).toBe('mtn');
    expect(syrianOperatorOf('0911234567')).toBeNull();
  });

  it('accepts its operator and names the other one on a refusal', () => {
    const syriatel = recipientNumberSchema('syriatel');
    expect(syriatel.parse('+963 988 123 456')).toBe('0988123456');
    const wrong = syriatel.safeParse('0944123456');
    expect(wrong.success).toBe(false);
    expect(wrong.error?.issues[0]).toMatchObject({
      params: { reason: WRONG_OPERATOR, operator: 'mtn' },
    });
    const unknown = recipientNumberSchema('mtn').safeParse('0911234567');
    expect(unknown.success).toBe(false);
    expect(unknown.error?.issues[0]).not.toHaveProperty('params');
    expect(recipientNumberSchema('mtn').safeParse('0'.repeat(33)).success).toBe(false);
    expect(recipientNumberSchema('mtn').safeParse('abc').success).toBe(false);
  });

  it('reads the number through the order fields (RN3)', () => {
    const schema = orderFieldValuesSchema([
      {
        key: 'recipient',
        type: 'mtn_number',
        required: true,
        minLength: null,
        maxLength: null,
        options: null,
      },
    ]);
    expect(schema.parse({ recipient: '0955 123 456' })).toEqual({ recipient: '0955123456' });
    expect(schema.safeParse({ recipient: '0933123456' }).success).toBe(false);
    const syriatel = orderFieldValuesSchema([
      {
        key: 'line',
        type: 'syriatel_number',
        required: true,
        minLength: null,
        maxLength: null,
        options: null,
      },
    ]);
    expect(syriatel.parse({ line: '963999123456' })).toEqual({ line: '0999123456' });
  });

  it('allows the types without bounds or options', () => {
    expect(inputFieldShapeSchema.parse({ type: 'syriatel_number' })).toMatchObject({
      type: 'syriatel_number',
      options: null,
    });
    expect(inputFieldShapeSchema.safeParse({ type: 'mtn_number', minLength: 3 }).success).toBe(
      false,
    );
  });

  it('groups for reading and masks for alerts', () => {
    expect(groupRecipient('0933123456')).toBe('093 312 3456');
    expect(maskRecipient('0933123456')).toBe('09X XXX XX56');
  });
});

describe('free amounts (AM1)', () => {
  it('converts between amounts and quantities', () => {
    expect(amountOfQuantity(73)).toBe(7_300);
    expect(amountOfQuantity(2, 50)).toBe(100);
    const bounds = { minQuantity: 10, maxQuantity: 1_000 };
    expect(quantityOfAmount(7_300, bounds)).toBe(73);
    expect(quantityOfAmount(1_000, bounds)).toBe(10);
    expect(quantityOfAmount(100_000, bounds)).toBe(1_000);
    expect(quantityOfAmount(900, bounds)).toBeNull();
    expect(quantityOfAmount(100_100, bounds)).toBeNull();
    expect(quantityOfAmount(7_350, bounds)).toBeNull();
    expect(quantityOfAmount(7_300.5, bounds)).toBeNull();
    expect(quantityOfAmount(150, { minQuantity: 1, maxQuantity: 10, step: 50 })).toBe(3);
  });

  it('creates an amount product with its defaults and bounds', () => {
    expect(createProductSchema.parse({ kind: 'amount', nameAr: 'فاتورة' })).toMatchObject({
      minQuantity: 1,
      maxQuantity: 1_000,
      amountUnitAr: 'ل.س',
    });
    expect(
      createProductSchema.safeParse({
        kind: 'amount',
        nameAr: 'فاتورة',
        minQuantity: 20,
        maxQuantity: 10,
      }).success,
    ).toBe(false);
    expect(
      createProductSchema.safeParse({ kind: 'amount', nameAr: 'فاتورة', maxQuantity: 1_001 })
        .success,
    ).toBe(false);
    expect(updateProductSchema.safeParse({ minQuantity: 5, maxQuantity: 4 }).success).toBe(false);
    expect(updateProductSchema.parse({ minQuantity: 5 })).toEqual({ minQuantity: 5 });
  });
});

describe('service classes (CL1)', () => {
  it('puts credit and cash in the section', () => {
    expect(inCreditSection('none')).toBe(false);
    expect(inCreditSection('credit')).toBe(true);
    expect(inCreditSection('cash')).toBe(true);
  });
});

describe('credit policy', () => {
  it('accepts the defaults and refuses out-of-range values', () => {
    expect(creditPolicySchema.parse(CREDIT_POLICY_DEFAULTS)).toEqual(CREDIT_POLICY_DEFAULTS);
    expect(
      creditPolicySchema.safeParse({ ...CREDIT_POLICY_DEFAULTS, cashBalanceAgeHours: 721 }).success,
    ).toBe(false);
    expect(
      creditPolicySchema.safeParse({ ...CREDIT_POLICY_DEFAULTS, retailDailyUsdUnits: -1 }).success,
    ).toBe(false);
    expect(
      creditPolicySchema.safeParse({ ...CREDIT_POLICY_DEFAULTS, retailDailyUsdUnits: 1 }).success,
    ).toBe(false);
  });
});

describe('limits (CL2, CL3, CS1, CS2)', () => {
  const facts = (overrides: Partial<CreditLimitFacts> = {}): CreditLimitFacts => ({
    policy: CREDIT_POLICY_DEFAULTS,
    merchant: false,
    spent: { sectionUsdUnits: 0, cashUsdUnits: 0 },
    adding: { sectionUsdUnits: usd(5), cashUsdUnits: 0 },
    recipients: [{ recipient: '0933123456', existing: 0, adding: 1 }],
    cashEligibleUsdUnits: 0,
    ...overrides,
  });

  it('passes an order within every limit', () => {
    expect(creditLimitRefusal(facts())).toBeNull();
  });

  it('counts a number across accounts up to the kind limit (CL3)', () => {
    expect(
      creditLimitRefusal(
        facts({ recipients: [{ recipient: '0933123456', existing: 4, adding: 1 }] }),
      ),
    ).toBeNull();
    expect(
      creditLimitRefusal(
        facts({ recipients: [{ recipient: '0933123456', existing: 5, adding: 1 }] }),
      ),
    ).toEqual({ code: 'RECIPIENT_DAILY_LIMIT', recipient: '0933123456', limit: 5 });
    expect(
      creditLimitRefusal(
        facts({
          merchant: true,
          recipients: [{ recipient: '0933123456', existing: 19, adding: 1 }],
        }),
      ),
    ).toBeNull();
  });

  it('caps the section per kind (CL2)', () => {
    expect(
      creditLimitRefusal(facts({ spent: { sectionUsdUnits: usd(46), cashUsdUnits: 0 } })),
    ).toEqual({ code: 'CREDIT_DAILY_LIMIT', remainingUsdUnits: usd(4) });
    expect(
      creditLimitRefusal(facts({ spent: { sectionUsdUnits: usd(45), cashUsdUnits: 0 } })),
    ).toBeNull();
    expect(
      creditLimitRefusal(facts({ spent: { sectionUsdUnits: usd(60), cashUsdUnits: 0 } })),
    ).toEqual({ code: 'CREDIT_DAILY_LIMIT', remainingUsdUnits: 0 });
    expect(
      creditLimitRefusal(
        facts({ merchant: true, spent: { sectionUsdUnits: usd(400), cashUsdUnits: 0 } }),
      ),
    ).toBeNull();
  });

  it('caps cash, then asks for old balance (CS1, CS2)', () => {
    const cash = (spent: number, eligible: number) =>
      creditLimitRefusal(
        facts({
          spent: { sectionUsdUnits: usd(spent), cashUsdUnits: usd(spent) },
          adding: { sectionUsdUnits: usd(5), cashUsdUnits: usd(5) },
          cashEligibleUsdUnits: usd(eligible),
        }),
      );
    expect(cash(16, 100)).toEqual({ code: 'CASH_DAILY_LIMIT', remainingUsdUnits: usd(4) });
    expect(cash(15, 4)).toEqual({
      code: 'CASH_BALANCE_TOO_RECENT',
      eligibleUsdUnits: usd(4),
    });
    expect(cash(15, 5)).toBeNull();
  });

  it('reads the eligible balance and the remaining amounts', () => {
    expect(cashEligibleBalance(usd(30), usd(10))).toBe(usd(20));
    expect(cashEligibleBalance(usd(10), usd(30))).toBe(0);
    expect(
      creditRemaining(CREDIT_POLICY_DEFAULTS, false, {
        sectionUsdUnits: usd(45),
        cashUsdUnits: usd(0),
      }),
    ).toEqual({ sectionUsdUnits: usd(5), cashUsdUnits: usd(5) });
    expect(
      creditRemaining(CREDIT_POLICY_DEFAULTS, true, {
        sectionUsdUnits: usd(100),
        cashUsdUnits: usd(30),
      }),
    ).toEqual({ sectionUsdUnits: usd(400), cashUsdUnits: usd(70) });
  });
});

describe('cash hold (CS3–CS5)', () => {
  it('holds above the kind threshold', () => {
    expect(cashNeedsApproval(CREDIT_POLICY_DEFAULTS, false, usd(10))).toBe(false);
    expect(cashNeedsApproval(CREDIT_POLICY_DEFAULTS, false, usd(10.01))).toBe(true);
    expect(cashNeedsApproval(CREDIT_POLICY_DEFAULTS, true, usd(50))).toBe(false);
    expect(cashNeedsApproval(CREDIT_POLICY_DEFAULTS, true, usd(50.01))).toBe(true);
  });

  it('lets Telegram decide up to the ceiling', () => {
    expect(cashTelegramDecides(CREDIT_POLICY_DEFAULTS, usd(50))).toBe(true);
    expect(cashTelegramDecides(CREDIT_POLICY_DEFAULTS, usd(50.01))).toBe(false);
  });

  it('expires after the hold hours', () => {
    expect(
      cashHoldExpiresAt(new Date('2026-11-04T10:00:00Z'), CREDIT_POLICY_DEFAULTS).toISOString(),
    ).toBe('2026-11-05T10:00:00.000Z');
  });

  it('reads a decision with an optional reason', () => {
    expect(cashApprovalInputSchema.parse({ decision: 'reject', reason: ' مشبوه ' })).toEqual({
      decision: 'reject',
      reason: 'مشبوه',
    });
    expect(cashApprovalInputSchema.safeParse({ decision: 'hold' }).success).toBe(false);
  });

  it('alerts from the third account (CL4)', () => {
    expect(recipientNeedsAlert(CREDIT_POLICY_DEFAULTS, 2)).toBe(false);
    expect(recipientNeedsAlert(CREDIT_POLICY_DEFAULTS, 3)).toBe(true);
  });
});
