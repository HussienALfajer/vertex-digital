import type { SaleCurrency, SellingPriceRow } from '@vertex-digital/contracts';

/*
 * S21 PS1a: what a pack's card shows in the sale mode, from the integer amounts the API sends.
 * Nothing here converts: the selling price comes in both currencies from the selling-prices read,
 * the purchase price's SYP from the merchant's own prices of the game, both at the rate in force.
 * USD leads everywhere (owner, 2026-10-30): "بيعك $5.08 ≈ 730 ل.س".
 */

export interface Amount {
  currency: SaleCurrency;
  units: number;
}

/** A USD figure and its SYP equivalent after "≈" when there is one. */
export interface SalePrice {
  usdUnits: number;
  sypUnits: number | null;
}

export interface SaleFigures {
  selling: SalePrice | null;
  purchase: SalePrice | null;
  /** Per unit, negative below cost; null without both prices. */
  profit: SalePrice | null;
}

const sign = (units: number) => Math.sign(units);

/**
 * The selling and purchase prices in USD with their SYP after "≈", and the profit per unit: one
 * integer subtraction of the USD units, the exact comparison the below-cost warning rests on. Its
 * SYP is the subtraction of the two SYP figures on the card, shown only when both exist and their
 * rounding agrees with the USD sign: never "+$0.01 ≈ -50 ل.س".
 */
export function saleFigures(row: SellingPriceRow, purchaseSypUnits: number | null): SaleFigures {
  const { purchaseUsdUnits, sellingUsdUnits, sellingSypUnits } = row;
  const selling =
    sellingUsdUnits === null ? null : { usdUnits: sellingUsdUnits, sypUnits: sellingSypUnits };
  const purchase =
    purchaseUsdUnits === null ? null : { usdUnits: purchaseUsdUnits, sypUnits: purchaseSypUnits };
  if (selling === null || purchase === null) return { selling, purchase, profit: null };
  const usdUnits = selling.usdUnits - purchase.usdUnits;
  const sypUnits =
    selling.sypUnits !== null && purchase.sypUnits !== null
      ? selling.sypUnits - purchase.sypUnits
      : null;
  return {
    selling,
    purchase,
    profit: {
      usdUnits,
      sypUnits: sypUnits !== null && sign(sypUnits) === sign(usdUnits) ? sypUnits : null,
    },
  };
}
