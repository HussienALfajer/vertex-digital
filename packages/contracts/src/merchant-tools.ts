import { z } from 'zod';
import { phoneSchema } from './auth.js';
import type { ProductKind } from './catalog.js';
import { zoneDate, zoneDayStart, zoneMonthStart, zoneYearMonth } from './deposits.js';
import { cursorPageSchema, cursorQuerySchema } from './lists.js';
import { TIER_GRANT_MAX_DAYS, TIER_QUANTITY_CEILING } from './merchant-tiers.js';
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
import {
  CART_LINES_MAX,
  type PlayerCheck,
  playerCheckSchema,
  SAVED_PLAYERS_MAX,
  SAVED_PLAYERS_PER_GAME,
  type SaleCurrency,
} from './orders.js';
import type { AccountType } from './price-kinds.js';

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

/** Where a selling price comes from (SP3, SP4): the product's own price, the markup, or none. */
export const SELLING_PRICE_SOURCES = ['product', 'markup', 'none'] as const;

export type SellingPriceSource = (typeof SELLING_PRICE_SOURCES)[number];

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
  .object({
    id: z.uuid(),
    slug: z.string(),
    nameAr: z.string(),
    /** PS1: the merchant's units of the game bought in the last 30 days, net of refunds. */
    recentUnits: z.int().nonnegative(),
  })
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

/**
 * S23 MG1: the end of a manual tier grant ending on the Damascus day `endsOn` (`YYYY-MM-DD`): the
 * start of the next Damascus day. Null unless `endsOn` is 1 to 90 days after today in Damascus.
 */
export function tierGrantEndsAt(endsOn: string, now: Date): Date | null {
  const day = (date: string) =>
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  const days = (day(endsOn) - day(zoneDate(now))) / 86_400_000;
  if (days < 1 || days > TIER_GRANT_MAX_DAYS) return null;
  return zoneDayStart(now, -(days + 1));
}

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

/** LV1, amended by S23: one live level per tier above Bronze. */
export const MERCHANT_LEVELS_MAX = 3;

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

/**
 * S21 LV1: a level's values as the `merchant_level.*` audit entries of S21 recorded them (S23
 * replaced the routes with the tiers' own, `merchant-tiers.ts`).
 */
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

/* Counter tools (F32–F35, PR 2) -------------------------------------------------------------- */

/**
 * QT1: a merchant's order of a code pack may carry up to 50 units, whatever the pack's limit;
 * S23 TS5: the merchant's tier sets it (Bronze's default), at most `TIER_QUANTITY_CEILING`.
 */
export const MERCHANT_CODE_QUANTITY_MAX = 50;

/** BK1, BK3: a bulk list (and a merchant's checkout) holds at most 50 lines; S23 TS5: per tier. */
export const BULK_LINES_MAX = 50;

/** S23 TS5: a merchant tier's quantities, from its settings in force. */
export interface TierQuantities {
  orderUnitsMax: number;
  bulkLinesMax: number;
}

/** BK1: a pasted list or CSV file is at most 100 KB. */
export const BULK_TEXT_MAX_BYTES = 100 * 1024;

/** PS2: the last 20 distinct ids per game, from the merchant's orders of the last 90 days. */
export const RECENT_PLAYERS_PER_GAME = 20;
export const RECENT_PLAYERS_DAYS = 90;

/** Decision 10: a merchant saves 50 ids per game and 300 per account. */
export const MERCHANT_SAVED_PLAYERS_PER_GAME = 50;
export const MERCHANT_SAVED_PLAYERS_MAX = 300;

/** CR3: a merchant's code releases (and single reveals) per 10 minutes. */
export const MERCHANT_CODE_RELEASES_PER_TEN_MINUTES = 20;

/** `GET /api/merchant/recent-players?gameId` (PS2). */
export const recentPlayersQuerySchema = z
  .object({ gameId: z.uuid() })
  .meta({ id: 'RecentPlayersQuery' });

export type RecentPlayersQuery = z.infer<typeof recentPlayersQuerySchema>;

export const recentPlayersSchema = z
  .object({
    items: z.array(
      z.object({
        fields: z.record(z.string(), z.string()),
        /** The name of the newest validated order with these fields. */
        playerName: z.string().nullable(),
        lastUsedAt: z.iso.datetime(),
      }),
    ),
  })
  .meta({ id: 'RecentPlayers' });

export type RecentPlayers = z.infer<typeof recentPlayersSchema>;

/* Bulk orders (F33, BK1–BK5) ----------------------------------------------------------------- */

/** Why a bulk line cannot be paid as parsed (BK1, BK2). */
export const BULK_LINE_ERRORS = [
  /** Not the game's fields, then the pack, then an optional quantity. */
  'columns',
  'pack_unknown',
  /** Two packs of the game share this amount: name the pack instead. */
  'pack_ambiguous',
  'quantity_invalid',
  /** Above the pack's limit for this account (QT1). */
  'quantity_above_max',
  /** The pack is not available on the merchant's list now. */
  'pack_unavailable',
  /** A field fails the game's rules (S06 CT7); the field's key is in `field`. */
  'field_invalid',
] as const;

export const bulkLineErrorSchema = z.enum(BULK_LINE_ERRORS).meta({ id: 'BulkLineError' });

export type BulkLineError = z.infer<typeof bulkLineErrorSchema>;

/** What `parseBulkLines` needs of a game: its field keys in order and its packs. */
export interface BulkGame {
  fieldKeys: readonly string[];
  packs: readonly { id: string; nameAr: string; gameAmount: number | null }[];
}

export interface ParsedBulkLine {
  /** The line's number in the text, from 1. */
  line: number;
  fields: Record<string, string>;
  productId: string | null;
  quantity: number | null;
  errors: BulkLineError[];
}

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;

function latinDigits(text: string): string {
  return text.replace(ARABIC_DIGITS, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code - (code >= 0x06f0 ? 0x06f0 : 0x0660));
  });
}

/** One CSV-like line into cells: the separator is a tab, else `;`, else `,`; `"` quotes a cell. */
function splitCells(line: string): string[] {
  const separator = line.includes('\t') ? '\t' : line.includes(';') ? ';' : ',';
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line.charAt(index);
    if (quoted) {
      if (character !== '"') cell += character;
      else if (line.charAt(index + 1) === '"') {
        cell += '"';
        index += 1;
      } else quoted = false;
    } else if (character === '"' && cell.trim() === '') {
      cell = '';
      quoted = true;
    } else if (character === separator) {
      cells.push(cell.trim());
      cell = '';
    } else cell += character;
  }
  cells.push(cell.trim());
  return cells;
}

function matchPack(
  cell: string,
  packs: BulkGame['packs'],
): { productId: string } | { error: 'pack_unknown' | 'pack_ambiguous' } {
  const typed = latinDigits(cell).normalize('NFKC').trim();
  if (/^\d+$/.test(typed)) {
    const amount = Number(typed);
    const matches = packs.filter((pack) => pack.gameAmount === amount);
    if (matches.length > 1) return { error: 'pack_ambiguous' };
    const [match] = matches;
    if (match) return { productId: match.id };
  }
  const named = packs.find((pack) => pack.nameAr.normalize('NFKC').trim() === typed);
  return named ? { productId: named.id } : { error: 'pack_unknown' };
}

/**
 * BK1: the lines of a pasted list or CSV, each the game's fields in order, then the pack (its
 * `game_amount` or its exact Arabic name), then an optional quantity (default 1). Empty lines,
 * and lines starting with `#` (the template's header), are skipped. Field values are checked
 * against the game's rules by the API, not here.
 */
export function parseBulkLines(text: string, game: BulkGame): ParsedBulkLine[] {
  const lines: ParsedBulkLine[] = [];
  const rows = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  for (const [index, row] of rows.entries()) {
    if (row.trim() === '' || row.trimStart().startsWith('#')) continue;
    const cells = splitCells(row);
    const count = game.fieldKeys.length;
    const parsed: ParsedBulkLine = {
      line: index + 1,
      fields: {},
      productId: null,
      quantity: null,
      errors: [],
    };
    lines.push(parsed);
    if (cells.length !== count + 1 && cells.length !== count + 2) {
      parsed.errors.push('columns');
      continue;
    }
    for (const [position, key] of game.fieldKeys.entries()) {
      // The column count was checked: every field has its cell.
      parsed.fields[key] = String(cells[position]);
    }
    const pack = matchPack(String(cells[count]), game.packs);
    if ('productId' in pack) parsed.productId = pack.productId;
    else parsed.errors.push(pack.error);
    const quantityCell = latinDigits(cells[count + 1] ?? '1');
    const quantity = /^\d{1,3}$/.test(quantityCell) ? Number(quantityCell) : 0;
    // The tier's own limit is checked with the pack (QT1, TS5).
    if (quantity >= 1 && quantity <= TIER_QUANTITY_CEILING) parsed.quantity = quantity;
    else parsed.errors.push('quantity_invalid');
  }
  return lines;
}

/** `POST /api/merchant/bulk/check` (BK2): the game and the pasted text or the CSV's content. */
export const bulkCheckRequestSchema = z
  .object({
    gameId: z.uuid(),
    text: z
      .string()
      .min(1)
      .refine(
        (text) => new TextEncoder().encode(text).byteLength <= BULK_TEXT_MAX_BYTES,
        'Expected at most 100 KB',
      ),
  })
  .meta({ id: 'BulkCheckRequest' });

export type BulkCheckRequest = z.infer<typeof bulkCheckRequestSchema>;

/**
 * QT1, QT2, S23 TS5: the most units one order (or cart line) of a pack may carry: the merchant
 * tier's code quantity for a merchant's code pack, the pack's own limit otherwise (direct top-ups,
 * and every pack for customers). `tier` is the merchant's tier quantities, null for a customer.
 */
export function orderQuantityMax(
  product: { kind: ProductKind; maxQuantity: number },
  accountType: AccountType,
  tier: TierQuantities | null,
): number {
  return accountType === 'merchant' && product.kind === 'code'
    ? (tier?.orderUnitsMax ?? MERCHANT_CODE_QUANTITY_MAX)
    : product.maxQuantity;
}

/** Decision 10, S10 SP1: the saved-id limits of an account type. */
export function savedPlayerLimits(accountType: AccountType): { perGame: number; total: number } {
  return accountType === 'merchant'
    ? { perGame: MERCHANT_SAVED_PLAYERS_PER_GAME, total: MERCHANT_SAVED_PLAYERS_MAX }
    : { perGame: SAVED_PLAYERS_PER_GAME, total: SAVED_PLAYERS_MAX };
}

/** BK3, edge case 21, S23 TS5: the tier's lines for a merchant's checkout, 10 for a customer. */
export function checkoutLinesMax(accountType: AccountType, tier: TierQuantities | null): number {
  return accountType === 'merchant' ? (tier?.bulkLinesMax ?? BULK_LINES_MAX) : CART_LINES_MAX;
}

/**
 * BK2: a checked line. `check` is the player check of its fields (null when the line has errors
 * or the game checks no ids); `needsConfirmation` asks the merchant's tick before paying (BK3).
 */
export const bulkCheckLineSchema = z
  .object({
    line: z.int().positive(),
    fields: z.record(z.string(), z.string()),
    product: z.object({ id: z.uuid(), nameAr: z.string() }).nullable(),
    quantity: z.int().positive().nullable(),
    unitPriceUsdUnits: amountUnitsSchema.nullable(),
    totalUsdUnits: amountUnitsSchema.nullable(),
    check: playerCheckSchema.nullable(),
    needsConfirmation: z.boolean(),
    errors: z.array(z.object({ code: bulkLineErrorSchema, field: z.string().nullable() })),
  })
  .meta({ id: 'BulkCheckLine' });

export type BulkCheckLine = z.infer<typeof bulkCheckLineSchema>;

export const bulkCheckResultSchema = z
  .object({
    lines: z.array(bulkCheckLineSchema),
    /** The lines without errors, in USD units. */
    totalUsdUnits: amountUnitsSchema,
    balanceUsdUnits: z.int(),
  })
  .meta({ id: 'BulkCheckResult' });

export type BulkCheckResult = z.infer<typeof bulkCheckResultSchema>;

/** BK3, S09 PV8: a line needs the merchant's confirmation unless its id is known valid. */
export function bulkNeedsConfirmation(check: PlayerCheck | null): boolean {
  return check !== null && check.result !== 'valid' && check.result !== 'not_supported';
}

/* Receipt settings and branding (F35, BR1–BR3) ----------------------------------------------- */

/** The logo of a merchant's receipts: PNG, JPEG or WebP up to 1 MB, kept as a 512 px WebP. */
export const MERCHANT_LOGO_MAX_BYTES = 1024 * 1024;
export const MERCHANT_LOGO_SIZE = 512;

/** `GET /api/merchant/receipt-settings` (BR3): the trade name is the admin-approved one. */
export const receiptSettingsSchema = z
  .object({
    tradeName: z.string(),
    showWhatsapp: z.boolean(),
    /** E.164; the merchant application's number until the merchant changes it. */
    whatsapp: z.string().nullable(),
    logoFileId: z.uuid().nullable(),
  })
  .meta({ id: 'ReceiptSettings' });

export type ReceiptSettings = z.infer<typeof receiptSettingsSchema>;

/** `PUT /api/merchant/receipt-settings`: a shown number must exist; a logo of the merchant's own. */
export const updateReceiptSettingsSchema = z
  .object({
    showWhatsapp: z.boolean(),
    whatsapp: phoneSchema.nullable(),
    logoFileId: z.uuid().nullable(),
  })
  .refine((value) => !value.showWhatsapp || value.whatsapp !== null, {
    path: ['whatsapp'],
    message: 'A shown WhatsApp number is required',
  })
  .meta({ id: 'UpdateReceiptSettings' });

export type UpdateReceiptSettings = z.infer<typeof updateReceiptSettingsSchema>;

/** `POST /api/merchant/logo`. */
export const uploadedLogoSchema = z.object({ fileId: z.uuid() }).meta({ id: 'UploadedLogo' });

export type UploadedLogo = z.infer<typeof uploadedLogoSchema>;

/** `DELETE /api/admin/customers/:id/merchant/logo` (BR3). */
export const removeMerchantLogoSchema = z
  .object({ reason: z.string().trim().min(3).max(500) })
  .meta({ id: 'RemoveMerchantLogo' });

export type RemoveMerchantLogo = z.infer<typeof removeMerchantLogoSchema>;
