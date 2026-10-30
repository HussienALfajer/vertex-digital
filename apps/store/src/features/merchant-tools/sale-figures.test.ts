import type { SellingPriceRow } from '@vertex-digital/contracts';
import { describe, expect, it } from 'vitest';
import { saleFigures } from './sale-figures';

const row = (changes: Partial<SellingPriceRow> = {}): SellingPriceRow => ({
  productId: '0199e200-0000-7000-8000-0000000000a1',
  nameAr: '60 UC',
  available: true,
  purchaseUsdUnits: 4_610_000,
  ownPrice: null,
  sellingUsdUnits: 5_080_000,
  sellingSypUnits: 73_000,
  source: 'markup',
  belowCost: false,
  ...changes,
});

describe('saleFigures (S21 PS1a, USD leads)', () => {
  it('leads with USD and follows with SYP, profit from the USD units', () => {
    expect(saleFigures(row(), 66_000)).toEqual({
      selling: { usdUnits: 5_080_000, sypUnits: 73_000 },
      purchase: { usdUnits: 4_610_000, sypUnits: 66_000 },
      profit: { usdUnits: 470_000, sypUnits: 7_000 },
    });
  });

  it('leads with USD for a price set in SYP too', () => {
    const figures = saleFigures(
      row({ ownPrice: { currency: 'syp', amountUnits: 73_000 }, source: 'product' }),
      66_000,
    );
    expect(figures.selling).toEqual({ usdUnits: 5_080_000, sypUnits: 73_000 });
    expect(figures.profit).toEqual({ usdUnits: 470_000, sypUnits: 7_000 });
  });

  it('shows USD alone without a rate', () => {
    expect(saleFigures(row({ sellingSypUnits: null }), null)).toEqual({
      selling: { usdUnits: 5_080_000, sypUnits: null },
      purchase: { usdUnits: 4_610_000, sypUnits: null },
      profit: { usdUnits: 470_000, sypUnits: null },
    });
  });

  it('has no SYP profit when the purchase has no SYP figure', () => {
    expect(saleFigures(row(), null).profit).toEqual({ usdUnits: 470_000, sypUnits: null });
  });

  it('is negative below cost, in both currencies', () => {
    const figures = saleFigures(
      row({ sellingUsdUnits: 4_500_000, sellingSypUnits: 65_000, belowCost: true }),
      66_000,
    );
    expect(figures.profit).toEqual({ usdUnits: -110_000, sypUnits: -1_000 });
  });

  it('drops the SYP profit when its rounding says other than the USD units', () => {
    // USD says below cost, the rounded SYP figures say level.
    expect(
      saleFigures(row({ sellingUsdUnits: 4_600_000, sellingSypUnits: 66_000 }), 66_000).profit,
    ).toEqual({ usdUnits: -10_000, sypUnits: null });
    // USD says level, the rounded SYP figures say below.
    expect(
      saleFigures(row({ sellingUsdUnits: 4_610_000, sellingSypUnits: 65_000 }), 66_000).profit,
    ).toEqual({ usdUnits: 0, sypUnits: null });
    // Level in both.
    expect(
      saleFigures(row({ sellingUsdUnits: 4_610_000, sellingSypUnits: 66_000 }), 66_000).profit,
    ).toEqual({ usdUnits: 0, sypUnits: 0 });
  });

  it('has no profit without a selling price', () => {
    const figures = saleFigures(row({ sellingUsdUnits: null, sellingSypUnits: null }), 66_000);
    expect(figures.selling).toBeNull();
    expect(figures.profit).toBeNull();
  });
});
