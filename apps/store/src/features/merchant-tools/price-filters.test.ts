import type { SellingPriceRow } from '@vertex-digital/contracts';
import { describe, expect, it } from 'vitest';
import { filterCounts, matchesFilter } from './price-filters';

const row = (changes: Partial<SellingPriceRow>): SellingPriceRow => ({
  productId: '0199e200-0000-7000-8000-0000000000a1',
  nameAr: '60 UC',
  available: true,
  purchaseUsdUnits: 1_000_000,
  ownPrice: null,
  sellingUsdUnits: 1_100_000,
  sellingSypUnits: null,
  source: 'markup',
  belowCost: false,
  ...changes,
});

describe('the selling-prices chips (owner, 2026-10-30)', () => {
  it('counts every chip over the same rows', () => {
    const rows = [
      row({}),
      row({ source: 'product', belowCost: true }),
      row({ source: 'none', sellingUsdUnits: null }),
    ];
    expect(filterCounts(rows)).toEqual({ all: 3, markup: 1, product: 1, none: 1, below: 1 });
    expect(matchesFilter(rows[1] as SellingPriceRow, 'below')).toBe(true);
    expect(matchesFilter(rows[0] as SellingPriceRow, 'product')).toBe(false);
  });
});
