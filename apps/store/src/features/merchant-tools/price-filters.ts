import type { SellingPriceRow } from '@vertex-digital/contracts';

/*
 * The selling-prices table's chips (owner, 2026-10-30): all packs, those priced by the markup,
 * those with their own price, those without a selling price, and those sold below their cost.
 */

export const PRICE_FILTERS = ['all', 'markup', 'product', 'none', 'below'] as const;

export type PriceFilter = (typeof PRICE_FILTERS)[number];

export function matchesFilter(row: SellingPriceRow, filter: PriceFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'below') return row.belowCost;
  return row.source === filter;
}

/** Each chip's count, for the rows as they are now. */
export function filterCounts(rows: readonly SellingPriceRow[]): Record<PriceFilter, number> {
  return Object.fromEntries(
    PRICE_FILTERS.map((filter) => [
      filter,
      rows.filter((row) => matchesFilter(row, filter)).length,
    ]),
  ) as Record<PriceFilter, number>;
}
