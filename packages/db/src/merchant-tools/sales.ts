import {
  NO_SELLING_SETTINGS,
  rateFromNumeric,
  type SaleSource,
  type SellingPriceInput,
  type SellingSettings,
  saleUnitUsd,
  sellingPrice,
  sellingPriceTooHigh,
} from '@vertex-digital/contracts';
import { and, desc, eq } from 'drizzle-orm';
import type { Executor, Transaction } from '../client.js';
import {
  exchangeRates,
  merchantOrderSales,
  merchantSellingPrices,
  merchantSellingSettings,
} from '../schema/index.js';

/*
 * Selling prices (S21 F31, SP1–SP6): the merchant's own prices and the sale row each merchant order
 * gets in its purchase transaction. Bookkeeping only: no ledger posting, the order unchanged.
 */

export interface RateRow {
  id: string;
  sypPerUsd: string;
  displayStepSypUnits: number;
}

/** The newest rate (the one in force), or null before the first. */
export async function rateInForce(db: Executor): Promise<RateRow | null> {
  const [rate] = await db
    .select({
      id: exchangeRates.id,
      sypPerUsd: exchangeRates.sypPerUsd,
      displayStepSypUnits: exchangeRates.displayStepSypUnits,
    })
    .from(exchangeRates)
    .orderBy(desc(exchangeRates.createdAt), desc(exchangeRates.id))
    .limit(1);
  return rate ?? null;
}

async function rateById(db: Executor, rateId: string | null): Promise<RateRow | null> {
  if (rateId === null) return null;
  const [rate] = await db
    .select({
      id: exchangeRates.id,
      sypPerUsd: exchangeRates.sypPerUsd,
      displayStepSypUnits: exchangeRates.displayStepSypUnits,
    })
    .from(exchangeRates)
    .where(eq(exchangeRates.id, rateId));
  return rate ?? null;
}

/** SP1: the merchant's settings; none set is no markup and the store's step. */
export async function sellingSettingsOf(
  db: Executor,
  customerId: string,
): Promise<SellingSettings> {
  const [row] = await db
    .select({
      markupBp: merchantSellingSettings.markupBp,
      sypStepUnits: merchantSellingSettings.sypStepUnits,
    })
    .from(merchantSellingSettings)
    .where(eq(merchantSellingSettings.customerId, customerId));
  return row ? (row as SellingSettings) : NO_SELLING_SETTINGS;
}

/** SP2: the merchant's own price of a product, or null. */
export async function ownSellingPrice(
  db: Executor,
  customerId: string,
  productId: string,
): Promise<SellingPriceInput | null> {
  const [row] = await db
    .select({
      currency: merchantSellingPrices.currency,
      amountUnits: merchantSellingPrices.amountUnits,
    })
    .from(merchantSellingPrices)
    .where(
      and(
        eq(merchantSellingPrices.customerId, customerId),
        eq(merchantSellingPrices.productId, productId),
      ),
    );
  return row ?? null;
}

export interface SaleValues {
  currency: 'usd' | 'syp';
  unitAmountUnits: number;
  rateId: string | null;
  unitUsdUnits: number;
  source: SaleSource;
}

/**
 * SP4: the sale row of a merchant's order at the rate it was shown with (`displayRateId`, the rate
 * in force at purchase): the product's own price, else the markup over the unit price paid; null
 * when the product has no selling price. A SYP price keeps its pounds; markup and USD prices are
 * USD sales.
 */
export async function saleFor(
  db: Executor,
  order: {
    customerId: string;
    productId: string;
    unitPriceUsdUnits: number;
    displayRateId: string | null;
  },
): Promise<SaleValues | null> {
  const rate = await rateById(db, order.displayRateId);
  const settings = await sellingSettingsOf(db, order.customerId);
  const own = await ownSellingPrice(db, order.customerId, order.productId);
  const price = sellingPrice(
    order.unitPriceUsdUnits,
    settings,
    own,
    rate ? rateFromNumeric(rate.sypPerUsd) : null,
    rate?.displayStepSypUnits ?? 1,
  );
  if (price === null) return null;
  if (own?.currency === 'syp') {
    return {
      currency: 'syp',
      unitAmountUnits: own.amountUnits,
      rateId: rate?.id ?? null,
      unitUsdUnits: price.usdUnits,
      source: 'product',
    };
  }
  return {
    currency: 'usd',
    unitAmountUnits: price.usdUnits,
    rateId: rate?.id ?? null,
    unitUsdUnits: price.usdUnits,
    source: price.source,
  };
}

/** SP4: writes the sale row of a merchant's new order, in its purchase transaction, when it has one. */
export async function recordMerchantSale(
  tx: Transaction,
  order: {
    id: string;
    customerId: string | null;
    productId: string;
    unitPriceUsdUnits: number;
    displayRateId: string | null;
  },
): Promise<void> {
  if (order.customerId === null) return;
  const sale = await saleFor(tx, { ...order, customerId: order.customerId });
  if (sale === null) return;
  await tx
    .insert(merchantOrderSales)
    .values({ orderId: order.id, customerId: order.customerId, ...sale });
}

/** Why `setOrderSale` wrote nothing: no rate to convert a SYP price at, or above $10,000 at it. */
export type OrderSaleRefusal = 'no_rate' | 'too_high';

/**
 * SP5: the merchant's own sale price of an order, set or changed later (`manual`), converted at the
 * sale's rate, else the order's display rate. The $10,000 limit is checked at that same rate (audit
 * A06-35), so a stored sale is never above it.
 */
export async function setOrderSale(
  tx: Transaction,
  order: { id: string; customerId: string; displayRateId: string | null },
  input: SellingPriceInput,
): Promise<{ ok: true; sale: SaleValues } | { ok: false; reason: OrderSaleRefusal }> {
  const [current] = await tx
    .select({ rateId: merchantOrderSales.rateId })
    .from(merchantOrderSales)
    .where(eq(merchantOrderSales.orderId, order.id))
    .for('update');
  const rate = await rateById(tx, current?.rateId ?? order.displayRateId);
  if (input.currency === 'syp' && rate === null) return { ok: false, reason: 'no_rate' };
  if (sellingPriceTooHigh(input, rate ? rateFromNumeric(rate.sypPerUsd) : '1')) {
    return { ok: false, reason: 'too_high' };
  }
  const sale: SaleValues = {
    currency: input.currency,
    unitAmountUnits: input.amountUnits,
    rateId: rate?.id ?? null,
    unitUsdUnits: saleUnitUsd(
      input.currency,
      input.amountUnits,
      rate ? rateFromNumeric(rate.sypPerUsd) : '1',
    ),
    source: 'manual',
  };
  await tx
    .insert(merchantOrderSales)
    .values({ orderId: order.id, customerId: order.customerId, ...sale })
    .onConflictDoUpdate({ target: merchantOrderSales.orderId, set: sale });
  return { ok: true, sale };
}
