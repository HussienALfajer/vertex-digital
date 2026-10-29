import { describe, expect, it } from 'vitest';
import {
  costChangeBasisPoints,
  createPriceListSchema,
  decideReviewsSchema,
  effectivePriceListId,
  isProfitable,
  listChain,
  accountPriceKind,
  listPrice,
  parentCappedPrice,
  type MarginRuleValues,
  marginBasisPoints,
  marginRuleListQuerySchema,
  matrixCellWarnings,
  needsReview,
  PRICE_LIST_MAX_DEPTH,
  priceFromCost,
  priceKindOf,
  priceMatrixQuerySchema,
  priceReviewListQuerySchema,
  pricingPreviewRequestSchema,
  ROOT_PRICE_LIST_IDS,
  renamePriceListSchema,
  resolveListEntry,
  resolveMarginRule,
  savings,
  savingsWarning,
  setFixedPriceSchema,
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

  it('warns above 50% of the official price exactly, not by the percent shown (edge case 7)', () => {
    // $2.50 off $4.99 is 50.10%, shown as 50%.
    expect(savings(usd(2.49), usd(4.99))?.percent).toBe(50);
    expect(savingsWarning(usd(2.49), usd(4.99))).toBe(true);
    expect(savingsWarning(usd(2.5), usd(5))).toBe(false);
    expect(savingsWarning(usd(1.25), usd(4.99))).toBe(true);
    expect(savingsWarning(usd(4.85), usd(4.99))).toBe(false);
    expect(savingsWarning(usd(1), null)).toBe(false);
    expect(savingsWarning(usd(5), usd(4.99))).toBe(false);
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

describe('needsReview (S07 rule P3)', () => {
  it('holds a change above 10% either way and applies exactly 10% at once', () => {
    expect(needsReview(usd(1), usd(1.1), 1000)).toBe(false);
    expect(needsReview(usd(1), usd(1.1) + 1, 1000)).toBe(true);
    expect(needsReview(usd(1), usd(0.9), 1000)).toBe(false);
    expect(needsReview(usd(1), usd(0.9) - 1, 1000)).toBe(true);
    expect(needsReview(usd(0.88), usd(0.92), 1000)).toBe(false);
    // The acceptance's $0.88 → $1.10 (+25%).
    expect(needsReview(usd(0.88), usd(1.1), 1000)).toBe(true);
    expect(needsReview(usd(1), usd(1), 100)).toBe(false);
  });

  it('measures the change in signed basis points of the cost before', () => {
    expect(costChangeBasisPoints(usd(0.88), usd(1.1))).toBe(2500);
    expect(costChangeBasisPoints(usd(1), usd(0.9))).toBe(-1000);
    // Rounded toward zero.
    expect(costChangeBasisPoints(3, 4)).toBe(3333);
    expect(costChangeBasisPoints(3, 2)).toBe(-3333);
    expect(() => costChangeBasisPoints(0, 1)).toThrow(RangeError);
    // A cent to $10,000: far beyond a 32-bit integer, hence a bigint column.
    expect(costChangeBasisPoints(usd(0.01), usd(10_000))).toBe(9_999_990_000);
  });
});

describe('review schemas (rule P4)', () => {
  const id = '0199a000-0000-7000-8000-000000000001';

  it('lists open reviews by default', () => {
    expect(priceReviewListQuerySchema.parse({})).toEqual({ page: 1, pageSize: 50, status: 'open' });
  });

  it('decides 1–100 reviews, each once', () => {
    const decision = { reviewId: id, action: 'accept' as const, expectedPriceUsdUnits: 990_000 };
    expect(decideReviewsSchema.safeParse({ decisions: [decision] }).success).toBe(true);
    expect(decideReviewsSchema.safeParse({ decisions: [] }).success).toBe(false);
    expect(decideReviewsSchema.safeParse({ decisions: [decision, decision] }).success).toBe(false);
  });
});

describe('priceKindOf (S20 AT4)', () => {
  it('names retail and wholesale, and every other list special', () => {
    expect(priceKindOf('retail')).toBe('retail');
    expect(priceKindOf('wholesale')).toBe('wholesale');
    expect(priceKindOf('cost')).toBe('special');
    expect(priceKindOf('custom')).toBe('special');
  });
});

describe('effectivePriceListId (S20 AT1)', () => {
  it('takes the assigned list, else the type default', () => {
    expect(effectivePriceListId({ accountType: 'customer', priceListId: null })).toBe(
      ROOT_PRICE_LIST_IDS.retail,
    );
    expect(effectivePriceListId({ accountType: 'merchant', priceListId: null })).toBe(
      ROOT_PRICE_LIST_IDS.wholesale,
    );
    expect(effectivePriceListId({ accountType: 'customer', priceListId: 'vip' })).toBe('vip');
    expect(effectivePriceListId({ accountType: 'merchant', priceListId: 'vip' })).toBe('vip');
  });

  it("takes a merchant's level list below the assigned list (S21 LV5)", () => {
    const merchant = { accountType: 'merchant', levelListId: 'silver' } as const;
    expect(effectivePriceListId({ ...merchant, priceListId: null })).toBe('silver');
    expect(effectivePriceListId({ ...merchant, priceListId: 'vip' })).toBe('vip');
    expect(effectivePriceListId({ ...merchant, priceListId: null, levelListId: null })).toBe(
      ROOT_PRICE_LIST_IDS.wholesale,
    );
    expect(
      effectivePriceListId({ accountType: 'customer', priceListId: null, levelListId: 'silver' }),
    ).toBe(ROOT_PRICE_LIST_IDS.retail);
  });
});

describe('listChain (S20 LS3)', () => {
  const lists = [
    { id: 'retail', parentListId: null },
    { id: 'wholesale', parentListId: null },
    { id: 'vip', parentListId: 'wholesale' },
    { id: 'gold', parentListId: 'vip' },
  ];

  it('walks from the list to its root', () => {
    expect(listChain(lists, 'retail')).toEqual(['retail']);
    expect(listChain(lists, 'gold')).toEqual(['gold', 'vip', 'wholesale']);
  });

  it('refuses an unknown list, a missing parent and a chain past the depth', () => {
    expect(() => listChain(lists, 'nope')).toThrow(/Unknown/);
    expect(() => listChain([{ id: 'a', parentListId: 'gone' }], 'a')).toThrow(/Unknown/);
    const deep = Array.from({ length: PRICE_LIST_MAX_DEPTH + 1 }, (_, index) => ({
      id: `l${index}`,
      parentListId: index === 0 ? null : `l${index - 1}`,
    }));
    expect(listChain(deep, `l${PRICE_LIST_MAX_DEPTH - 1}`)).toHaveLength(PRICE_LIST_MAX_DEPTH);
    expect(() => listChain(deep, `l${PRICE_LIST_MAX_DEPTH}`)).toThrow(/deeper/);
    // A cycle can never form (parents are fixed), but it still ends.
    const cycle = [
      { id: 'x', parentListId: 'y' },
      { id: 'y', parentListId: 'x' },
    ];
    expect(() => listChain(cycle, 'x')).toThrow(/deeper/);
  });
});

describe('resolveListEntry (S20 LS4)', () => {
  const path = { productId: 'p1', gameId: 'g1', categoryId: 'c1' };
  const rule = (priceListId: string, scope: 'global' | 'category' | 'game' | 'product') => ({
    priceListId,
    scope,
    targetId:
      scope === 'global' ? null : ({ category: 'c1', game: 'g1', product: 'p1' } as const)[scope],
    name: `${priceListId}:${scope}`,
  });
  const fixed = (priceListId: string, productId = 'p1') => ({
    priceListId,
    productId,
    name: `${priceListId}:fixed`,
  });
  const chain = ['vip', 'wholesale'];

  it('takes the own most specific rule of the list', () => {
    const found = resolveListEntry(
      chain,
      {
        rules: [rule('vip', 'global'), rule('vip', 'game'), rule('wholesale', 'product')],
        fixedPrices: [],
      },
      path,
    );
    expect(found).toEqual({ fixed: null, rule: rule('vip', 'game'), listId: 'vip' });
  });

  it('falls to the parent only where the list has no entry', () => {
    const found = resolveListEntry(
      chain,
      { rules: [rule('wholesale', 'global'), rule('wholesale', 'category')], fixedPrices: [] },
      path,
    );
    expect(found.rule.name).toBe('wholesale:category');
    expect(found.listId).toBe('wholesale');
  });

  it('puts a fixed price before the rules of its list, with the guarding rule', () => {
    const found = resolveListEntry(
      chain,
      {
        rules: [rule('vip', 'product'), rule('wholesale', 'global')],
        fixedPrices: [fixed('vip'), fixed('vip', 'p2')],
      },
      path,
    );
    expect(found).toEqual({ fixed: fixed('vip'), rule: rule('vip', 'product'), listId: 'vip' });
  });

  it('guards a fixed price with the rule of the parent when its list has none', () => {
    const found = resolveListEntry(
      chain,
      { rules: [rule('wholesale', 'global')], fixedPrices: [fixed('vip')] },
      path,
    );
    expect(found.fixed?.name).toBe('vip:fixed');
    expect(found.rule.name).toBe('wholesale:global');
  });

  it('lets a nearer rule beat a fixed price of the parent, which applies otherwise', () => {
    expect(
      resolveListEntry(
        chain,
        {
          rules: [rule('vip', 'global'), rule('wholesale', 'global')],
          fixedPrices: [fixed('wholesale')],
        },
        path,
      ).rule.name,
    ).toBe('vip:global');
    const inherited = resolveListEntry(
      chain,
      { rules: [rule('wholesale', 'global')], fixedPrices: [fixed('wholesale')] },
      path,
    );
    expect(inherited).toMatchObject({ listId: 'wholesale', fixed: { name: 'wholesale:fixed' } });
  });

  it('throws without a global rule on the root', () => {
    expect(() => resolveListEntry(chain, { rules: [], fixedPrices: [] }, path)).toThrow(/global/);
    expect(() => resolveListEntry(chain, { rules: [], fixedPrices: [fixed('vip')] }, path)).toThrow(
      /global/,
    );
  });
});

describe('listPrice (S20 LP1–LP4)', () => {
  /** The wholesale rule seeded by S20 (decision 2): 5%, $0 fixed, $0.05 minimum. */
  const wholesale: MarginRuleValues = {
    percentBp: 500,
    fixedUsdUnits: 0,
    minMarginUsdUnits: 50_000,
  };
  const retail = { priceUsdUnits: usd(1.1), minMarginUsdUnits: 100_000 };

  it('prices by the rule, rounded up to the cent', () => {
    expect(listPrice(usd(1), { fixedPriceUsdUnits: null, rule: wholesale }, null)).toEqual({
      priceUsdUnits: usd(1.05),
      source: 'rule',
      minMarginUsdUnits: 50_000,
    });
    // $0.333 + 5% = $0.34965, below the $0.05 minimum: $0.383 rounded up to $0.39.
    expect(
      listPrice(333_000, { fixedPriceUsdUnits: null, rule: wholesale }, null).priceUsdUnits,
    ).toBe(usd(0.39));
  });

  it('keeps a fixed price covering the minimum margin, exactly too', () => {
    expect(listPrice(usd(1), { fixedPriceUsdUnits: usd(1.05), rule: wholesale }, retail)).toEqual({
      priceUsdUnits: usd(1.05),
      source: 'fixed',
      minMarginUsdUnits: 50_000,
    });
  });

  it('falls back to the guarding rule below the minimum margin (decision 6)', () => {
    expect(listPrice(usd(1), { fixedPriceUsdUnits: usd(1.04), rule: wholesale }, retail)).toEqual({
      priceUsdUnits: usd(1.05),
      source: 'fixed_fallback',
      minMarginUsdUnits: 50_000,
    });
  });

  it('caps every list but retail at the retail price (decision 3, edge cases 5 and 6)', () => {
    const capped = { priceUsdUnits: usd(0.99), minMarginUsdUnits: 10_000 };
    expect(listPrice(usd(0.95), { fixedPriceUsdUnits: null, rule: wholesale }, capped)).toEqual({
      priceUsdUnits: usd(0.99),
      source: 'retail_cap',
      minMarginUsdUnits: 10_000,
    });
    expect(
      listPrice(
        usd(1),
        { fixedPriceUsdUnits: null, rule: wholesale },
        {
          priceUsdUnits: usd(1.05),
          minMarginUsdUnits: 100_000,
        },
      ).source,
    ).toBe('rule');
    expect(
      listPrice(usd(1), { fixedPriceUsdUnits: usd(2), rule: wholesale }, retail),
    ).toMatchObject({ priceUsdUnits: usd(1.1), source: 'retail_cap' });
  });
});

describe('the parent cap (S23 PX2)', () => {
  const rule = (percentBp: number, minMarginUsdUnits: number): MarginRuleValues => ({
    percentBp,
    fixedUsdUnits: 0,
    minMarginUsdUnits,
  });
  const retail = { priceUsdUnits: usd(0.97), minMarginUsdUnits: 50_000 };

  it('prices the ladder a cent apart on 60 UC (acceptance 1)', () => {
    const cost = 887_000;
    const prices = [
      rule(500, 50_000),
      rule(400, 40_000),
      rule(300, 30_000),
      rule(200, 20_000),
    ].map((values) => listPrice(cost, { fixedPriceUsdUnits: null, rule: values }, retail));
    expect(prices.map((price) => price.priceUsdUnits)).toEqual([
      usd(0.94),
      usd(0.93),
      usd(0.92),
      usd(0.91),
    ]);
  });

  it('takes the parent price when its own is above it, guarded by the parent minimum', () => {
    const parent = { priceUsdUnits: usd(1.03), minMarginUsdUnits: 30_000 };
    expect(
      listPrice(usd(1), { fixedPriceUsdUnits: usd(1.06), rule: rule(200, 20_000) }, retail, parent),
    ).toEqual({ priceUsdUnits: usd(0.97), source: 'retail_cap', minMarginUsdUnits: 50_000 });
    expect(
      listPrice(
        usd(1),
        { fixedPriceUsdUnits: usd(1.06), rule: rule(200, 20_000) },
        { priceUsdUnits: usd(2), minMarginUsdUnits: 10_000 },
        parent,
      ),
    ).toEqual({ priceUsdUnits: usd(1.03), source: 'parent_cap', minMarginUsdUnits: 30_000 });
  });

  it('keeps its own price at or below the parent, and with no parent price', () => {
    const own = { priceUsdUnits: usd(1.02), source: 'rule' as const, minMarginUsdUnits: 20_000 };
    expect(parentCappedPrice(own, { priceUsdUnits: usd(1.02), minMarginUsdUnits: 30_000 })).toBe(
      own,
    );
    expect(parentCappedPrice(own, null)).toBe(own);
  });

  it('reads a tier list as wholesale (PX6)', () => {
    expect(accountPriceKind('custom', true)).toBe('wholesale');
    expect(accountPriceKind('custom', false)).toBe('special');
    expect(accountPriceKind('retail', false)).toBe('retail');
  });

  it('warns on a parent-capped cell', () => {
    expect(
      matrixCellWarnings({
        source: 'parent_cap',
        priceUsdUnits: usd(1),
        parentPriceUsdUnits: usd(1),
        held: false,
        available: true,
      }),
    ).toEqual(['capped']);
  });
});

describe('list schemas (S20 PR 2)', () => {
  const id = ROOT_PRICE_LIST_IDS.wholesale;

  it('trims names to 2–60 characters', () => {
    expect(createPriceListSchema.parse({ name: '  VIP  ', parentListId: id }).name).toBe('VIP');
    expect(createPriceListSchema.safeParse({ name: ' a ', parentListId: id }).success).toBe(false);
    expect(renamePriceListSchema.safeParse({ name: 'x'.repeat(61) }).success).toBe(false);
  });

  it('takes whole-cent fixed prices from $0.01 to $10,000', () => {
    expect(setFixedPriceSchema.safeParse({ priceUsdUnits: usd(0.99) }).success).toBe(true);
    expect(setFixedPriceSchema.safeParse({ priceUsdUnits: 0 }).success).toBe(false);
    expect(setFixedPriceSchema.safeParse({ priceUsdUnits: 990_001 }).success).toBe(false);
    expect(setFixedPriceSchema.safeParse({ priceUsdUnits: usd(10_000.01) }).success).toBe(false);
  });

  it('reads a list filter on rules', () => {
    expect(marginRuleListQuerySchema.parse({})).toEqual({});
    expect(marginRuleListQuerySchema.parse({ priceListId: id })).toEqual({ priceListId: id });
  });

  it('reads the matrix query: a game or a search, up to 8 comma-separated lists', () => {
    expect(
      priceMatrixQuerySchema.parse({ gameId: id, listIds: `${id},${ROOT_PRICE_LIST_IDS.cost}` }),
    ).toEqual({ gameId: id, listIds: [id, ROOT_PRICE_LIST_IDS.cost] });
    expect(priceMatrixQuerySchema.parse({ q: ' شدة ', warnings: 'true' })).toEqual({
      q: 'شدة',
      warnings: true,
    });
    expect(priceMatrixQuerySchema.parse({ q: 'x', listIds: [id] }).listIds).toEqual([id]);
    expect(priceMatrixQuerySchema.safeParse({}).success).toBe(false);
    expect(priceMatrixQuerySchema.safeParse({ gameId: id, q: 'x' }).success).toBe(false);
    expect(
      priceMatrixQuerySchema.safeParse({ q: 'x', listIds: Array(9).fill(id).join(',') }).success,
    ).toBe(false);
  });
});

describe('matrixCellWarnings (S20 screens)', () => {
  const base = {
    source: 'rule' as const,
    priceUsdUnits: usd(1),
    parentPriceUsdUnits: usd(1),
    held: false,
    available: true,
  };

  it('has none for a plain rule price', () => {
    expect(matrixCellWarnings(base)).toEqual([]);
    expect(matrixCellWarnings({ ...base, parentPriceUsdUnits: null })).toEqual([]);
  });

  it('names the fallback, the cap, a price above its parent and a hold', () => {
    expect(matrixCellWarnings({ ...base, source: 'fixed_fallback' })).toEqual(['fallback']);
    expect(matrixCellWarnings({ ...base, source: 'retail_cap' })).toEqual(['capped']);
    expect(matrixCellWarnings({ ...base, parentPriceUsdUnits: usd(0.99) })).toEqual([
      'above_parent',
    ]);
    expect(matrixCellWarnings({ ...base, held: true, available: false })).toEqual([
      'held',
      'unavailable',
    ]);
  });

  it('names a missing row rather than its unavailability', () => {
    expect(
      matrixCellWarnings({ ...base, source: null, priceUsdUnits: null, available: false }),
    ).toEqual(['no_row']);
  });
});
