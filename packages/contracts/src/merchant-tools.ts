import { z } from 'zod';
import { zoneMonthStart, zoneYearMonth } from './deposits.js';
import { cursorPageSchema, cursorQuerySchema } from './lists.js';
import { merchantLevelRefSchema } from './merchants.js';
import {
  amountUnitsSchema,
  CURRENCY_SCALE,
  ceilToStep,
  floorToWholeCents,
  isWholeCents,
  sypToUsd,
  USD_CENT,
  usdToSyp,
} from './money.js';
import { priceKindSchema } from './price-kinds.js';

/*
 * The merchant area (S21, F30–F39, ADR 0036), owned by the api `merchant-tools` module; the volume
 * levels (F39) belong to `merchants`. Money is USD units or SYP units (ADR 0003). Selling prices,
 * sale rows, follows and alerts are the merchant's own bookkeeping: they never move money.
 */

/* Selling prices (F31, SP1–SP6) -------------------------------------------------------------- */

const BASIS_POINTS = 10_000;

/** SP1: the SYP rounding steps a merchant may choose, in SYP units (5 to 1,000 SYP). */
export const SYP_STEPS = [500, 1_000, 5_000, 10_000, 50_000, 100_000] as const;

export const sypStepSchema = z.literal(SYP_STEPS).meta({ id: 'SypStep' });

/** SP2: a selling price is at most $10,000, or its SYP equivalent at the time of saving. */
export const SELLING_PRICE_MAX_USD_UNITS = 10_000 * CURRENCY_SCALE.USD;

export const SALE_CURRENCIES = ['usd', 'syp'] as const;

export const saleCurrencySchema = z.enum(SALE_CURRENCIES).meta({ id: 'SaleCurrency' });

export type SaleCurrency = z.infer<typeof saleCurrencySchema>;

/** Where a selling price comes from (SP3, SP4): the product's own price, the markup, or none. */
export const SELLING_PRICE_SOURCES = ['product', 'markup', 'none'] as const;

export type SellingPriceSource = (typeof SELLING_PRICE_SOURCES)[number];

/** Where an order's sale row comes from (SP4, SP5). */
export const SALE_SOURCES = ['product', 'markup', 'manual'] as const;

export const saleSourceSchema = z.enum(SALE_SOURCES).meta({ id: 'SaleSource' });

export type SaleSource = z.infer<typeof saleSourceSchema>;

/** `GET` and `PUT /api/merchant/selling-settings` (SP1): null markup is none, null step the store's. */
export const sellingSettingsSchema = z
  .object({
    markupBp: z.int().min(0).max(BASIS_POINTS).nullable(),
    sypStepUnits: sypStepSchema.nullable(),
  })
  .meta({ id: 'SellingSettings' });

export type SellingSettings = z.infer<typeof sellingSettingsSchema>;

export const NO_SELLING_SETTINGS: SellingSettings = { markupBp: null, sypStepUnits: null };

/**
 * `PUT /api/merchant/selling-prices/:productId` (SP2): USD in whole cents, SYP in whole pounds;
 * the SYP maximum needs the rate and is checked by `sellingPriceTooHigh`.
 */
export const sellingPriceInputSchema = z
  .discriminatedUnion('currency', [
    z.object({
      currency: z.literal('usd'),
      amountUnits: z
        .int()
        .min(USD_CENT)
        .max(SELLING_PRICE_MAX_USD_UNITS)
        .refine(isWholeCents, 'Expected whole cents'),
    }),
    z.object({
      currency: z.literal('syp'),
      amountUnits: z
        .int()
        .min(CURRENCY_SCALE.SYP)
        .max(Number.MAX_SAFE_INTEGER)
        .refine((units) => units % CURRENCY_SCALE.SYP === 0, 'Expected whole pounds'),
    }),
  ])
  .meta({ id: 'SellingPriceInput' });

export type SellingPriceInput = z.infer<typeof sellingPriceInputSchema>;

/** SP2: a SYP price above $10,000 at `rate`. */
export function sellingPriceTooHigh(input: SellingPriceInput, rate: string): boolean {
  if (input.currency === 'usd') return input.amountUnits > SELLING_PRICE_MAX_USD_UNITS;
  return input.amountUnits > usdToSyp(SELLING_PRICE_MAX_USD_UNITS, rate, 'down');
}

/** SP3: `purchase × (1 + markup)`, rounded up to whole cents. */
export function markupPrice(purchaseUsdUnits: number, markupBp: number): number {
  const purchase = BigInt(purchaseUsdUnits);
  const scale = BigInt(BASIS_POINTS);
  const raw = (purchase * (scale + BigInt(markupBp)) + scale - 1n) / scale;
  if (raw > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Price exceeds the safe range');
  return ceilToStep(Number(raw), USD_CENT);
}

export interface SellingPrice {
  /** The price in USD units (a SYP price's equivalent, rounded down to whole cents). */
  usdUnits: number;
  /** The price in SYP units: as set, or USD × rate rounded up to the step; null without a rate. */
  sypUnits: number | null;
  source: Exclude<SellingPriceSource, 'none'>;
}

/**
 * SP3: the selling price of a product for a merchant: its own price when set, else the markup over
 * the purchase price, else none (null). `rate` is the rate in force (null when there is none) and
 * `storeStepUnits` the store's display step, used when the merchant chose no step.
 */
export function sellingPrice(
  purchaseUsdUnits: number | null,
  settings: SellingSettings,
  ownPrice: SellingPriceInput | null,
  rate: string | null,
  storeStepUnits: number,
): SellingPrice | null {
  const step = settings.sypStepUnits ?? storeStepUnits;
  const syp = (usdUnits: number) =>
    rate === null ? null : ceilToStep(usdToSyp(usdUnits, rate, 'up'), step);
  if (ownPrice?.currency === 'syp') {
    // Without a rate a SYP price has no USD value to compare or count.
    if (rate === null) return null;
    return {
      usdUnits: floorToWholeCents(sypToUsd(ownPrice.amountUnits, rate, 'down')),
      sypUnits: ownPrice.amountUnits,
      source: 'product',
    };
  }
  if (ownPrice?.currency === 'usd') {
    return {
      usdUnits: ownPrice.amountUnits,
      sypUnits: syp(ownPrice.amountUnits),
      source: 'product',
    };
  }
  if (settings.markupBp === null || purchaseUsdUnits === null) return null;
  const usdUnits = markupPrice(purchaseUsdUnits, settings.markupBp);
  return { usdUnits, sypUnits: syp(usdUnits), source: 'markup' };
}

/**
 * SP4, SP5: the USD equivalent of a unit selling price at `rate`, rounded down to whole cents so a
 * profit is never overstated.
 */
export function saleUnitUsd(currency: SaleCurrency, amountUnits: number, rate: string): number {
  if (currency === 'usd') return amountUnits;
  return floorToWholeCents(sypToUsd(amountUnits, rate, 'down'));
}

/**
 * SP6: the estimated profit of an order: delivered units × (the selling unit price in USD − the
 * unit price paid); refunded units count neither as a sale nor as a cost. Null without a sale.
 */
export function saleProfit(
  order: { deliveredQuantity: number; unitPriceUsdUnits: number },
  sale: { unitUsdUnits: number } | null,
): number | null {
  if (sale === null) return null;
  const profit =
    BigInt(order.deliveredQuantity) * (BigInt(sale.unitUsdUnits) - BigInt(order.unitPriceUsdUnits));
  return Number(profit);
}

/** `GET /api/merchant/selling-prices?gameId` (SP3): one row per active pack of the game. */
export const sellingPriceRowSchema = z
  .object({
    productId: z.uuid(),
    nameAr: z.string(),
    available: z.boolean(),
    /** The merchant's own list price (MA2); null when the pack has none. */
    purchaseUsdUnits: amountUnitsSchema.nullable(),
    ownPrice: sellingPriceInputSchema.nullable(),
    sellingUsdUnits: amountUnitsSchema.nullable(),
    sellingSypUnits: amountUnitsSchema.nullable(),
    source: z.enum(SELLING_PRICE_SOURCES),
    /** SP3: "أقل من سعر شرائك". */
    belowCost: z.boolean(),
  })
  .meta({ id: 'SellingPriceRow' });

export type SellingPriceRow = z.infer<typeof sellingPriceRowSchema>;

export const sellingPriceQuerySchema = z
  .object({ gameId: z.uuid() })
  .meta({ id: 'SellingPriceQuery' });

export type SellingPriceQuery = z.infer<typeof sellingPriceQuerySchema>;

export const sellingPricesSchema = z
  .object({
    settings: sellingSettingsSchema,
    /** The store's display step, the default of the SYP step. */
    storeStepUnits: z.int().positive(),
    products: z.array(sellingPriceRowSchema),
  })
  .meta({ id: 'SellingPrices' });

export type SellingPrices = z.infer<typeof sellingPricesSchema>;

/** The games of the merchant area's game pickers, in the store's order. */
export const merchantGameSchema = z
  .object({ id: z.uuid(), slug: z.string(), nameAr: z.string() })
  .meta({ id: 'MerchantGame' });

export type MerchantGame = z.infer<typeof merchantGameSchema>;

export const merchantGamesSchema = z
  .object({ items: z.array(merchantGameSchema) })
  .meta({ id: 'MerchantGames' });

export type MerchantGames = z.infer<typeof merchantGamesSchema>;

/* Months (DB1, LV2, ST1) --------------------------------------------------------------------- */

/** A Damascus calendar month, `YYYY-MM`. */
export const monthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
  .meta({ id: 'Month' });

/** The `Asia/Damascus` calendar month of `instant`, `YYYY-MM`. */
export function damascusMonth(instant: Date): string {
  const { year, month } = zoneYearMonth(instant);
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** The instants a Damascus month starts and ends (end excluded). */
export function monthRange(month: string): { start: Date; end: Date } {
  const year = Number(month.slice(0, 4));
  const number = Number(month.slice(5, 7));
  return { start: zoneMonthStart(year, number), end: zoneMonthStart(year, number + 1) };
}

/** The month before `month`, `YYYY-MM`. */
export function previousMonth(month: string): string {
  return damascusMonth(new Date(monthRange(month).start.getTime() - 1));
}

/* Volume levels (F39, LV1–LV7) --------------------------------------------------------------- */

/** LV1: at most 10 live levels. */
export const MERCHANT_LEVELS_MAX = 10;

export interface LevelThreshold {
  id: string;
  monthlyThresholdUsdUnits: number;
}

/**
 * LV3: the highest live level whose threshold is at most the larger of the previous and this
 * month's net purchases, or null. `levels` are the live levels only.
 */
export function levelFor<Level extends LevelThreshold>(
  levels: readonly Level[],
  previousMonthUsdUnits: number,
  thisMonthUsdUnits: number,
): Level | null {
  const reached = Math.max(previousMonthUsdUnits, thisMonthUsdUnits);
  let best: Level | null = null;
  for (const level of levels) {
    if (level.monthlyThresholdUsdUnits > reached) continue;
    if (best === null || level.monthlyThresholdUsdUnits > best.monthlyThresholdUsdUnits) {
      best = level;
    }
  }
  return best;
}

/** `POST /api/admin/merchant-levels` and `PATCH /:id` (LV1): a whole-dollar threshold. */
export const merchantLevelInputSchema = z
  .object({
    nameAr: z.string().trim().min(2).max(30),
    monthlyThresholdUsdUnits: z
      .int()
      .min(CURRENCY_SCALE.USD)
      .max(Number.MAX_SAFE_INTEGER)
      .refine((units) => units % CURRENCY_SCALE.USD === 0, 'Expected whole dollars'),
    priceListId: z.uuid(),
  })
  .meta({ id: 'MerchantLevelInput' });

export type MerchantLevelInput = z.infer<typeof merchantLevelInputSchema>;

export const merchantLevelSchema = z
  .object({
    id: z.uuid(),
    nameAr: z.string(),
    monthlyThresholdUsdUnits: amountUnitsSchema,
    priceList: z.object({ id: z.uuid(), name: z.string(), priceKind: priceKindSchema }),
    /** Merchants on this level now. */
    merchantCount: z.int().nonnegative(),
    createdAt: z.iso.datetime(),
    archivedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'MerchantLevel' });

export type MerchantLevel = z.infer<typeof merchantLevelSchema>;

export const merchantLevelListSchema = z
  .object({ items: z.array(merchantLevelSchema) })
  .meta({ id: 'MerchantLevelList' });

export type MerchantLevelList = z.infer<typeof merchantLevelListSchema>;

/* Dashboard (F30, DB1–DB6) ------------------------------------------------------------------- */

export const DASHBOARD_PERIODS = ['today', 'month'] as const;

export const merchantDashboardQuerySchema = z
  .object({ period: z.enum(DASHBOARD_PERIODS).default('today') })
  .meta({ id: 'MerchantDashboardQuery' });

export type MerchantDashboardQuery = z.infer<typeof merchantDashboardQuerySchema>;

/** DB5: the five products sold most in the period. */
export const DASHBOARD_TOP_PRODUCTS = 5;

export const merchantDashboardSchema = z
  .object({
    period: z.enum(DASHBOARD_PERIODS),
    from: z.iso.datetime(),
    /** DB2: delivered units × the selling unit price, orders with a sale row. */
    salesUsdUnits: amountUnitsSchema,
    /** The SYP value at the current rate (rounded down); null without a rate. */
    salesSypUnits: amountUnitsSchema.nullable(),
    /** DB3: purchase debits less refund credits posted in the period (negative after refunds). */
    spendingUsdUnits: z.int(),
    /** DB4: may be negative (a sale below the price paid). */
    profitUsdUnits: z.int(),
    /** DB4: delivered orders of the period without a selling price. */
    ordersWithoutSale: z.int().nonnegative(),
    balanceUsdUnits: z.int(),
    topProducts: z.array(
      z.object({
        productId: z.uuid(),
        gameNameAr: z.string(),
        nameAr: z.string(),
        units: z.int().positive(),
        salesUsdUnits: amountUnitsSchema,
      }),
    ),
    /** DB5: null when no live level exists. */
    level: z
      .object({
        current: merchantLevelRefSchema.nullable(),
        thisMonthUsdUnits: z.int(),
        next: z
          .object({
            nameAr: z.string(),
            monthlyThresholdUsdUnits: amountUnitsSchema,
            missingUsdUnits: amountUnitsSchema,
          })
          .nullable(),
      })
      .nullable(),
    /** The empty state: neither a markup nor a product price is set. */
    sellingConfigured: z.boolean(),
  })
  .meta({ id: 'MerchantDashboard' });

export type MerchantDashboard = z.infer<typeof merchantDashboardSchema>;

/** DB5, LV3: the next level above what is reached and the amount missing to it, or null. */
export function nextLevel<Level extends LevelThreshold>(
  levels: readonly Level[],
  reachedUsdUnits: number,
): { level: Level; missingUsdUnits: number } | null {
  let next: Level | null = null;
  for (const level of levels) {
    if (level.monthlyThresholdUsdUnits <= reachedUsdUnits) continue;
    if (next === null || level.monthlyThresholdUsdUnits < next.monthlyThresholdUsdUnits) {
      next = level;
    }
  }
  if (next === null) return null;
  return {
    level: next,
    missingUsdUnits: next.monthlyThresholdUsdUnits - Math.max(reachedUsdUnits, 0),
  };
}

/* Follows and alerts (F37, AL1–AL7) ---------------------------------------------------------- */

/** AL1: at most 200 follows, games and products together. */
export const WATCHES_MAX = 200;

/** AL1: products bought in the last 30 days are suggested. */
export const WATCH_SUGGESTION_DAYS = 30;

/** Alert events are kept 90 days (the sweep deletes older ones). */
export const ALERT_EVENTS_KEEP_DAYS = 90;

export const ALERT_KINDS = ['price_down', 'price_up', 'back_in_stock', 'out_of_stock'] as const;

export const alertKindSchema = z.enum(ALERT_KINDS).meta({ id: 'MerchantAlertKind' });

export type AlertKind = z.infer<typeof alertKindSchema>;

export interface WatchState {
  priceUsdUnits: number | null;
  available: boolean;
}

/**
 * AL2: the events between what the merchant was last told and the product now: a price change in
 * USD units (to or from no price is not a price change), then a change of availability.
 */
export function watchChanges(told: WatchState, now: WatchState): AlertKind[] {
  const kinds: AlertKind[] = [];
  if (
    told.priceUsdUnits !== null &&
    now.priceUsdUnits !== null &&
    told.priceUsdUnits !== now.priceUsdUnits
  ) {
    kinds.push(now.priceUsdUnits < told.priceUsdUnits ? 'price_down' : 'price_up');
  }
  if (told.available !== now.available) {
    kinds.push(now.available ? 'back_in_stock' : 'out_of_stock');
  }
  return kinds;
}

/** AL3: the center shows at most five lines of a digest. */
export const WATCH_DIGEST_LINES = 5;

export const watchedGameSchema = z.object({ gameId: z.uuid(), nameAr: z.string() });

export const watchedProductSchema = z.object({
  productId: z.uuid(),
  gameId: z.uuid(),
  gameNameAr: z.string(),
  nameAr: z.string(),
});

/** `GET /api/merchant/watches` (AL1): the follows and the suggestions not followed yet. */
export const watchesSchema = z
  .object({
    games: z.array(watchedGameSchema),
    products: z.array(watchedProductSchema),
    suggestions: z.object({
      games: z.array(watchedGameSchema),
      products: z.array(watchedProductSchema),
    }),
  })
  .meta({ id: 'Watches' });

export type Watches = z.infer<typeof watchesSchema>;

/** `PUT /api/merchant/watches`: the whole set of follows (AL1). */
export const updateWatchesSchema = z
  .object({
    gameIds: z.array(z.uuid()).max(WATCHES_MAX),
    productIds: z.array(z.uuid()).max(WATCHES_MAX),
  })
  .refine((value) => new Set(value.gameIds).size === value.gameIds.length, {
    path: ['gameIds'],
    message: 'Duplicate game',
  })
  .refine((value) => new Set(value.productIds).size === value.productIds.length, {
    path: ['productIds'],
    message: 'Duplicate product',
  })
  .meta({ id: 'UpdateWatches' });

export type UpdateWatches = z.infer<typeof updateWatchesSchema>;

const lowBalance = z
  .int()
  .min(CURRENCY_SCALE.USD)
  .max(10_000 * CURRENCY_SCALE.USD)
  .refine(isWholeCents, 'Expected whole cents');

/** `GET` and `PUT /api/merchant/alert-settings` (AL4, AL5): null threshold is off. */
export const alertSettingsSchema = z
  .object({ lowBalanceUsdUnits: lowBalance.nullable(), dailyEmail: z.boolean() })
  .meta({ id: 'AlertSettings' });

export type AlertSettings = z.infer<typeof alertSettingsSchema>;

export const NO_ALERT_SETTINGS: AlertSettings = { lowBalanceUsdUnits: null, dailyEmail: false };

/** AL5: the alert is due when the balance is below the threshold and not sent since it was above. */
export function lowBalanceDue(
  balanceUsdUnits: number,
  settings: { lowBalanceUsdUnits: number | null; alerted: boolean },
): boolean {
  return (
    settings.lowBalanceUsdUnits !== null &&
    !settings.alerted &&
    balanceUsdUnits < settings.lowBalanceUsdUnits
  );
}

/** One alert line: an event, a digest's line and an email's line (AL2–AL4). */
export const alertLineSchema = z.object({
  productId: z.uuid(),
  gameNameAr: z.string(),
  productNameAr: z.string(),
  kind: alertKindSchema,
  oldPriceUsdUnits: amountUnitsSchema.nullable(),
  newPriceUsdUnits: amountUnitsSchema.nullable(),
});

export type AlertLine = z.infer<typeof alertLineSchema>;

/** `GET /api/merchant/alerts`: the events of the last 90 days, newest first. */
export const merchantAlertSchema = alertLineSchema
  .extend({ id: z.uuid(), createdAt: z.iso.datetime() })
  .meta({ id: 'MerchantAlert' });

export type MerchantAlert = z.infer<typeof merchantAlertSchema>;

export const merchantAlertQuerySchema = cursorQuerySchema
  .extend({ limit: z.coerce.number().int().min(1).max(50).default(20) })
  .meta({ id: 'MerchantAlertQuery' });

export type MerchantAlertQuery = z.infer<typeof merchantAlertQuerySchema>;

export const merchantAlertPageSchema = cursorPageSchema(merchantAlertSchema, 'MerchantAlertPage');

export type MerchantAlertPage = z.infer<typeof merchantAlertPageSchema>;

/** The counts of a digest (AL3). */
export function alertCounts(kinds: readonly AlertKind[]): Record<AlertKind, number> {
  const counts = { price_down: 0, price_up: 0, back_in_stock: 0, out_of_stock: 0 };
  for (const kind of kinds) counts[kind] += 1;
  return counts;
}
