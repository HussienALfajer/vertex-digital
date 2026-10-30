import type { SaleCurrency, SellingPriceRow } from '@vertex-digital/contracts';

/*
 * S21 PS3: what a pack's card shows in the sale mode, from the integer amounts the API sends. Nothing
 * here converts: the selling price comes in both currencies from the selling-prices read, the
 * purchase price's SYP from the merchant's own prices of the game, both at the rate in force.
 */

export interface Amount {
  currency: SaleCurrency;
  units: number;
}

/** A price in the currency the card leads with, and its equivalent after "≈" when there is one. */
export interface SalePrice {
  main: Amount;
  approx: Amount | null;
}

export interface SaleFigures {
  selling: SalePrice | null;
  purchase: SalePrice | null;
  /** Per unit, negative below cost; null without both prices. */
  profit: Amount | null;
}

function priceIn(currency: SaleCurrency, usdUnits: number, sypUnits: number | null): SalePrice {
  const usd: Amount = { currency: 'usd', units: usdUnits };
  if (sypUnits === null) return { main: usd, approx: null };
  const syp: Amount = { currency: 'syp', units: sypUnits };
  return currency === 'syp' ? { main: syp, approx: usd } : { main: usd, approx: syp };
}

/**
 * The card leads with the currency the selling price was set in (a markup's is rounded in SYP), and
 * the purchase price follows it, so the two lines read side by side. The profit is one subtraction
 * in that currency, the figures on the card, unless their rounding says other than the exact USD
 * comparison the below-cost warning rests on: then the USD figures, never a contradiction.
 */
export function saleFigures(row: SellingPriceRow, purchaseSypUnits: number | null): SaleFigures {
  const { purchaseUsdUnits, sellingUsdUnits, sellingSypUnits } = row;
  const currency: SaleCurrency =
    row.ownPrice?.currency === 'usd' || sellingSypUnits === null ? 'usd' : 'syp';
  const selling =
    sellingUsdUnits === null ? null : priceIn(currency, sellingUsdUnits, sellingSypUnits);
  const purchase =
    purchaseUsdUnits === null ? null : priceIn(currency, purchaseUsdUnits, purchaseSypUnits);
  if (sellingUsdUnits === null || purchaseUsdUnits === null) {
    return { selling, purchase, profit: null };
  }
  if (currency === 'syp' && sellingSypUnits !== null && purchaseSypUnits !== null) {
    const units = sellingSypUnits - purchaseSypUnits;
    if (units < 0 === row.belowCost) {
      return { selling, purchase, profit: { currency: 'syp', units } };
    }
  }
  return {
    selling,
    purchase,
    profit: { currency: 'usd', units: sellingUsdUnits - purchaseUsdUnits },
  };
}
