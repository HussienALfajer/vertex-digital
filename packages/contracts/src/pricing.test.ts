import { describe, expect, it } from 'vitest';
import {
  isProfitable,
  type MarginRuleValues,
  marginBasisPoints,
  priceFromCost,
  pricingPreviewRequestSchema,
  resolveMarginRule,
  savings,
  setMarginRuleSchema,
} from './pricing.js';

const usd = (dollars: number) => Math.round(dollars * 1_000_000);

/** The global rule seeded by S06 (Q7): 10%, $0 fixed, $0.10 minimum. */
const global: MarginRuleValues = { percentBp: 1000, fixedUsdUnits: 0, minMarginUsdUnits: 100_000 };

describe('priceFromCost (rule PR3)', () => {
  it('matches the spec examples with the global rule', () => {
    expect(priceFromCost(usd(0.89), global)).toBe(usd(0.99));
    expect(priceFromCost(usd(8.5), global)).toBe(usd(9.35));
    expect(priceFromCost(887_500, global)).toBe(usd(0.99));
    // Edge case 11: one unit, the minimum margin governs, rounded up to whole cents.
    expect(priceFromCost(1, global)).toBe(usd(0.11));
  });

  it('uses the percent when it beats the minimum, and the minimum otherwise', () => {
    // $1.00 at 10% is $1.10; the minimum would give $1.10 too: either way $1.10.
    expect(priceFromCost(usd(1), global)).toBe(usd(1.1));
    // $2.00 at 10% gives $0.20 > $0.10.
    expect(priceFromCost(usd(2), global)).toBe(usd(2.2));
    // $0.50 at 10% gives $0.05 < $0.10.
    expect(priceFromCost(usd(0.5), global)).toBe(usd(0.6));
  });

  it('rounds the markup and the price only upward', () => {
    // 10% of 1,234,567 units is 123,456.7 → 123,457; total 1,358,024 → $1.36.
    expect(priceFromCost(1_234_567, global)).toBe(usd(1.36));
    // An exact cent result stays as it is.
    expect(priceFromCost(usd(3), global)).toBe(usd(3.3));
  });

  it('adds the fixed amount, and handles 0% and 100%', () => {
    const fixed = { percentBp: 500, fixedUsdUnits: usd(0.25), minMarginUsdUnits: 10_000 };
    expect(priceFromCost(usd(10), fixed)).toBe(usd(10.75));
    const zero = { percentBp: 0, fixedUsdUnits: 0, minMarginUsdUnits: 10_000 };
    // Edge case 12: never at cost.
    expect(priceFromCost(usd(5), zero)).toBe(usd(5.01));
    const full = { percentBp: 10_000, fixedUsdUnits: 0, minMarginUsdUnits: 10_000 };
    expect(priceFromCost(usd(5), full)).toBe(usd(10));
  });

  it('handles the largest costs and refuses non-positive or unsafe ones', () => {
    expect(priceFromCost(usd(10_000), global)).toBe(usd(11_000));
    expect(() => priceFromCost(0, global)).toThrow(RangeError);
    expect(() => priceFromCost(-1, global)).toThrow(RangeError);
    expect(() => priceFromCost(1.5, global)).toThrow(RangeError);
    expect(() => priceFromCost(Number.MAX_SAFE_INTEGER, global)).toThrow(RangeError);
  });

  it('always leaves at least the minimum margin (rule PR4)', () => {
    for (const cost of [1, 99, 9_999, 10_000, 10_001, 887_500, 1_234_567, usd(42.42)]) {
      const price = priceFromCost(cost, global);
      expect(price % 10_000).toBe(0);
      expect(isProfitable(price, cost, global)).toBe(true);
    }
  });
});

describe('isProfitable (rule PR5)', () => {
  it('is profitable from exactly the minimum margin (ADR 0020)', () => {
    expect(isProfitable(usd(0.99), usd(0.89), global)).toBe(true);
    expect(isProfitable(usd(0.99), usd(0.89) + 1, global)).toBe(false);
    expect(isProfitable(usd(0.99), usd(1), global)).toBe(false);
  });
});

describe('marginBasisPoints', () => {
  it('is the margin in basis points of the price, rounded down', () => {
    expect(marginBasisPoints(usd(0.99), usd(0.89))).toBe(1010);
    expect(marginBasisPoints(usd(1.1), usd(1))).toBe(909);
    expect(marginBasisPoints(usd(1), usd(1))).toBe(0);
    expect(marginBasisPoints(usd(1), usd(2))).toBe(0);
    expect(() => marginBasisPoints(0, 1)).toThrow(RangeError);
  });
});

describe('resolveMarginRule (rule PR2)', () => {
  const rules = [
    { scope: 'global' as const, targetId: null, name: 'global' },
    { scope: 'category' as const, targetId: 'c1', name: 'category' },
    { scope: 'game' as const, targetId: 'g1', name: 'game' },
    { scope: 'product' as const, targetId: 'p1', name: 'product' },
  ];

  it('takes the most specific live rule, then its parents', () => {
    const path = { productId: 'p1', gameId: 'g1', categoryId: 'c1' };
    expect(resolveMarginRule(rules, path).name).toBe('product');
    expect(resolveMarginRule(rules, { ...path, productId: 'p2' }).name).toBe('game');
    expect(resolveMarginRule(rules, { productId: 'p2', gameId: 'g2', categoryId: 'c1' }).name).toBe(
      'category',
    );
    expect(resolveMarginRule(rules, { productId: 'p2', gameId: 'g2', categoryId: 'c2' }).name).toBe(
      'global',
    );
    expect(resolveMarginRule(rules, { gameId: 'g1', categoryId: 'c1' }).name).toBe('game');
    expect(resolveMarginRule(rules, { categoryId: 'c1' }).name).toBe('category');
    expect(resolveMarginRule(rules, {}).name).toBe('global');
  });

  it('never matches a rule of another scope with the same id', () => {
    const tricky = [
      { scope: 'global' as const, targetId: null, name: 'global' },
      { scope: 'game' as const, targetId: 'p1', name: 'game' },
    ];
    expect(resolveMarginRule(tricky, { productId: 'p1' }).name).toBe('global');
  });

  it('fails without a global rule', () => {
    expect(() => resolveMarginRule([], {})).toThrow(/global/);
  });
});

describe('savings (rule PR7)', () => {
  it('shows only when the official price is known and above the price', () => {
    expect(savings(usd(0.94), usd(0.99))).toEqual({ amountUsdUnits: usd(0.05), percent: 5 });
    expect(savings(usd(1.04), usd(0.99))).toBeNull();
    expect(savings(usd(0.99), usd(0.99))).toBeNull();
    expect(savings(usd(0.99), null)).toBeNull();
  });

  it('rounds the percent down and hides it below 1%', () => {
    expect(savings(usd(99.5), usd(100))).toEqual({ amountUsdUnits: usd(0.5), percent: null });
    expect(savings(usd(99), usd(100))).toEqual({ amountUsdUnits: usd(1), percent: 1 });
    expect(savings(usd(0.66), usd(1))?.percent).toBe(34);
    expect(savings(usd(0.01), usd(10_000))?.percent).toBe(99);
  });
});

describe('rule schemas (rule PR1)', () => {
  const values = { percentBp: 1200, fixedUsdUnits: 0, minMarginUsdUnits: 150_000 };
  const id = '0199a000-0000-7000-8000-000000000001';

  it('bounds the values: percent 0–100%, fixed $0–$50, minimum $0.01–$50, whole cents', () => {
    expect(setMarginRuleSchema.safeParse({ scope: 'global', ...values }).success).toBe(true);
    for (const wrong of [
      { percentBp: 10_001 },
      { percentBp: -1 },
      { fixedUsdUnits: usd(50.01) },
      { fixedUsdUnits: 5000 },
      { minMarginUsdUnits: 0 },
      { minMarginUsdUnits: usd(50.01) },
    ]) {
      expect(setMarginRuleSchema.safeParse({ scope: 'global', ...values, ...wrong }).success).toBe(
        false,
      );
    }
  });

  it('needs a target for every scope but global, and none for global', () => {
    expect(setMarginRuleSchema.safeParse({ scope: 'game', targetId: id, ...values }).success).toBe(
      true,
    );
    expect(setMarginRuleSchema.safeParse({ scope: 'game', ...values }).success).toBe(false);
    expect(
      setMarginRuleSchema.safeParse({ scope: 'global', targetId: id, ...values }).success,
    ).toBe(false);
  });

  it('bounds the preview cost to 1 unit–$10,000', () => {
    const request = { target: { scope: 'product', targetId: id }, costUsdUnits: 1 };
    expect(pricingPreviewRequestSchema.safeParse(request).success).toBe(true);
    expect(
      pricingPreviewRequestSchema.safeParse({ ...request, costUsdUnits: usd(10_000) + 1 }).success,
    ).toBe(false);
    expect(pricingPreviewRequestSchema.safeParse({ ...request, costUsdUnits: 0 }).success).toBe(
      false,
    );
    expect(
      pricingPreviewRequestSchema.safeParse({ ...request, target: { scope: 'product' } }).success,
    ).toBe(false);
  });
});
