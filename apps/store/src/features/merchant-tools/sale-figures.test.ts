import type { SellingPriceRow } from '@vertex-digital/contracts';
import { describe, expect, it } from 'vitest';
import { saleFigures } from './sale-figures';

const row = (changes: Partial<SellingPriceRow> = {}): SellingPriceRow => ({
  productId: '0199e200-0000-7000-8000-0000000000a1',
  nameAr: '60 UC',
  available: true,
  purchaseUsdUnits: 930_000,
  ownPrice: null,
  sellingUsdUnits: 1_030_000,
  sellingSypUnits: 15_000,
  source: 'markup',
  belowCost: false,
  ...changes,
});

describe('saleFigures (S21 PS3)', () => {
  it('leads with SYP for a markup and subtracts the figures on the card', () => {
    expect(saleFigures(row(), 13_500)).toEqual({
      selling: {
        main: { currency: 'syp', units: 15_000 },
        approx: { currency: 'usd', units: 1_030_000 },
      },
      purchase: {
        main: { currency: 'syp', units: 13_500 },
        approx: { currency: 'usd', units: 930_000 },
      },
      profit: { currency: 'syp', units: 1_500 },
    });
  });

  it('leads with USD for a price set in USD, and counts the profit in USD', () => {
    const figures = saleFigures(
      row({ ownPrice: { currency: 'usd', amountUnits: 1_030_000 }, source: 'product' }),
      13_500,
    );
    expect(figures.selling?.main).toEqual({ currency: 'usd', units: 1_030_000 });
    expect(figures.selling?.approx).toEqual({ currency: 'syp', units: 15_000 });
    expect(figures.purchase?.main).toEqual({ currency: 'usd', units: 930_000 });
    expect(figures.profit).toEqual({ currency: 'usd', units: 100_000 });
  });

  it('shows USD alone without a rate', () => {
    const figures = saleFigures(row({ sellingSypUnits: null }), null);
    expect(figures.selling).toEqual({ main: { currency: 'usd', units: 1_030_000 }, approx: null });
    expect(figures.purchase).toEqual({ main: { currency: 'usd', units: 930_000 }, approx: null });
    expect(figures.profit).toEqual({ currency: 'usd', units: 100_000 });
  });

  it('counts in USD when the purchase has no SYP figure', () => {
    expect(saleFigures(row(), null).profit).toEqual({ currency: 'usd', units: 100_000 });
  });

  it('is negative below cost', () => {
    const figures = saleFigures(
      row({ sellingUsdUnits: 900_000, sellingSypUnits: 13_000, belowCost: true }),
      13_500,
    );
    expect(figures.profit).toEqual({ currency: 'syp', units: -500 });
  });

  it('never contradicts the below-cost warning when SYP rounding says otherwise', () => {
    // USD says below cost, the rounded SYP figures say level.
    const below = saleFigures(
      row({ sellingUsdUnits: 920_000, sellingSypUnits: 13_500, belowCost: true }),
      13_500,
    );
    expect(below.profit).toEqual({ currency: 'usd', units: -10_000 });
    // USD says at or above cost, the rounded SYP figures say below it.
    const above = saleFigures(
      row({ sellingUsdUnits: 930_000, sellingSypUnits: 13_000, belowCost: false }),
      13_500,
    );
    expect(above.profit).toEqual({ currency: 'usd', units: 0 });
  });

  it('has no profit without a selling price', () => {
    const figures = saleFigures(row({ sellingUsdUnits: null, sellingSypUnits: null }), 13_500);
    expect(figures.selling).toBeNull();
    expect(figures.profit).toBeNull();
  });
});
