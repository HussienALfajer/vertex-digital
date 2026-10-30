import { z } from 'zod';
import {
  damascusMonth,
  monthSchema,
  previousMonth,
  type SellingPriceRow,
} from './merchant-tools.js';
import { amountUnitsSchema, sypDisplayPrice } from './money.js';
import { levelTierSchema, merchantTierSchema } from './price-kinds.js';
import { JOURNAL_KINDS, journalKindSchema, walletEntrySchema } from './wallet.js';

/*
 * The merchant's documents (S21 F36, F38), owned by the api `merchant-tools` module: the price
 * list (PL1–PL3) and the monthly statement (ST1–ST4). Apart from `merchant-tools.ts`, which the
 * notifications import, so the pages that ship those never ship these schemas or the wallet's.
 * The statement reads the ledger (S02) and never writes it.
 */

/* Price list (F36, PL1–PL3) ------------------------------------------------------------------ */

/** PL1: the merchant's selling prices (default), or their own purchase prices. */
export const PRICE_LIST_MODES = ['selling', 'purchase'] as const;

export type PriceListMode = (typeof PRICE_LIST_MODES)[number];

/** PL1: SYP (default), USD, or both. */
export const PRICE_LIST_CURRENCIES = ['syp', 'usd', 'both'] as const;

export type PriceListCurrency = (typeof PRICE_LIST_CURRENCIES)[number];

/** PL3: at most 60 packs per image; `page` reads the next ones. */
export const PRICE_LIST_IMAGE_ROWS = 60;

/** PL3: 20 images an hour per merchant. */
export const PRICE_LIST_IMAGES_PER_HOUR = 20;

/** The games a price list may name at most (the store has far fewer). */
export const PRICE_LIST_GAMES_MAX = 100;

const gameIdsSchema = z.preprocess(
  (value) =>
    typeof value === 'string' ? value.split(',').filter((part) => part.length > 0) : value,
  z.array(z.uuid()).min(1).max(PRICE_LIST_GAMES_MAX),
);

/**
 * `GET /api/merchant/price-list` and `.png` (PL1): the games (comma-separated; default the
 * followed games, else all), the prices, the currency, whether to list unavailable packs, and the
 * image's page.
 */
export const merchantPriceListQuerySchema = z
  .object({
    gameIds: gameIdsSchema.optional(),
    mode: z.enum(PRICE_LIST_MODES).default('selling'),
    currency: z.enum(PRICE_LIST_CURRENCIES).default('syp'),
    unavailable: z.stringbool().default(false),
    page: z.coerce.number().int().min(1).max(100).default(1),
  })
  .meta({ id: 'MerchantPriceListQuery' });

export type MerchantPriceListQuery = z.infer<typeof merchantPriceListQuerySchema>;

/** A pack as the price list reads it: its selling price row (SP3). */
export type PriceListSource = Pick<
  SellingPriceRow,
  'available' | 'purchaseUsdUnits' | 'sellingUsdUnits' | 'sellingSypUnits'
>;

export type PriceListLine =
  | { kind: 'price'; usdUnits: number; sypUnits: number | null }
  | { kind: 'unavailable' }
  /** An unavailable pack the merchant chose not to list. */
  | { kind: 'hidden' }
  /** PL2: a pack without a selling price in `selling` mode, counted for the merchant only. */
  | { kind: 'omitted' };

/**
 * PL1, PL2: one pack's line. Selling mode prints the selling price (USD and its SYP); purchase
 * mode the merchant's own list price, its SYP at the store's display rounding. An unavailable
 * pack is "غير متوفر" when asked for, else hidden; without a rate the SYP is null.
 */
export function priceListLine(
  row: PriceListSource,
  query: Pick<MerchantPriceListQuery, 'mode' | 'unavailable'>,
  rate: string | null,
  storeStepUnits: number,
): PriceListLine {
  if (!row.available || row.purchaseUsdUnits === null) {
    return query.unavailable ? { kind: 'unavailable' } : { kind: 'hidden' };
  }
  if (query.mode === 'purchase') {
    const usdUnits = row.purchaseUsdUnits;
    return {
      kind: 'price',
      usdUnits,
      sypUnits: rate === null ? null : sypDisplayPrice(usdUnits, rate, storeStepUnits),
    };
  }
  if (row.sellingUsdUnits === null) return { kind: 'omitted' };
  return { kind: 'price', usdUnits: row.sellingUsdUnits, sypUnits: row.sellingSypUnits };
}

export const merchantPriceListRowSchema = z
  .object({
    productId: z.uuid(),
    nameAr: z.string(),
    available: z.boolean(),
    /** Null for "غير متوفر". */
    usdUnits: amountUnitsSchema.nullable(),
    /** Null for "غير متوفر", and without a rate. */
    sypUnits: amountUnitsSchema.nullable(),
  })
  .meta({ id: 'MerchantPriceListRow' });

export type MerchantPriceListRow = z.infer<typeof merchantPriceListRowSchema>;

export const merchantPriceListGameSchema = z
  .object({ gameId: z.uuid(), nameAr: z.string(), rows: z.array(merchantPriceListRowSchema) })
  .meta({ id: 'MerchantPriceListGame' });

export type MerchantPriceListGame = z.infer<typeof merchantPriceListGameSchema>;

/** `GET /api/merchant/price-list` (PL2): what the print page and the image show. */
export const merchantPriceListSchema = z
  .object({
    tradeName: z.string(),
    logoFileId: z.uuid().nullable(),
    /** S23 ID6: the merchant's effective tier, for the header's line and badge. */
    tier: merchantTierSchema,
    /** S23 RC2: the logo at twice the size. */
    largeLogo: z.boolean(),
    generatedAt: z.iso.datetime(),
    mode: z.enum(PRICE_LIST_MODES),
    currency: z.enum(PRICE_LIST_CURRENCIES),
    /** The games asked for, else the followed ones, else all (PL1). */
    gameIds: z.array(z.uuid()),
    /** In the store's order, packs in the store's order; a game without a line is left out. */
    games: z.array(merchantPriceListGameSchema),
    /** PL2: packs left out for want of a selling price (shown to the merchant, never printed). */
    omittedCount: z.int().nonnegative(),
    /** PL3: the images the list takes at 60 packs each (at least 1). */
    imagePages: z.int().positive(),
  })
  .meta({ id: 'MerchantPriceList' });

export type MerchantPriceList = z.infer<typeof merchantPriceListSchema>;

/** PL3: the packs of one image, 60 a page, each under its game's name. */
export function priceListPage(
  games: readonly MerchantPriceListGame[],
  page: number,
): MerchantPriceListGame[] {
  const first = (page - 1) * PRICE_LIST_IMAGE_ROWS;
  const result: MerchantPriceListGame[] = [];
  let index = 0;
  for (const game of games) {
    const start = Math.max(first - index, 0);
    const end = Math.min(first + PRICE_LIST_IMAGE_ROWS - index, game.rows.length);
    if (start < end) result.push({ ...game, rows: game.rows.slice(start, end) });
    index += game.rows.length;
  }
  return result;
}

/** PL3: how many images the packs take. */
export function priceListPages(games: readonly MerchantPriceListGame[]): number {
  const rows = games.reduce((total, game) => total + game.rows.length, 0);
  return Math.max(1, Math.ceil(rows / PRICE_LIST_IMAGE_ROWS));
}

/* Statement (F38, ST1–ST4) ------------------------------------------------------------------- */

/** ST3: 20 Excel files an hour per merchant. */
export const STATEMENT_EXPORTS_PER_HOUR = 20;

/** `GET /api/merchant/statements` (ST1): newest first; this month is `current`. */
export const statementMonthsSchema = z
  .object({ items: z.array(z.object({ month: monthSchema, current: z.boolean() })) })
  .meta({ id: 'StatementMonths' });

export type StatementMonths = z.infer<typeof statementMonthsSchema>;

/** ST1: the Damascus months from `createdAt`'s to `now`'s, newest first. */
export function statementMonths(createdAt: Date, now: Date): string[] {
  const first = damascusMonth(createdAt);
  const months: string[] = [];
  for (let month = damascusMonth(now); month >= first; month = previousMonth(month)) {
    months.push(month);
  }
  return months;
}

/** ST2: the order of a purchase or refund entry, with its quantity and the full player ID. */
export const statementOrderSchema = z
  .object({
    id: z.uuid(),
    number: z.string(),
    gameNameAr: z.string(),
    productNameAr: z.string(),
    quantity: z.int().positive(),
    fields: z.array(z.object({ labelAr: z.string(), value: z.string() })),
  })
  .meta({ id: 'StatementOrder' });

export type StatementOrder = z.infer<typeof statementOrderSchema>;

/** ST2: one wallet entry of the month, in write order, with what the customer's timeline shows. */
export const statementEntrySchema = walletEntrySchema
  .pick({
    occurredAt: true,
    kind: true,
    amountUnits: true,
    balanceAfterUnits: true,
    deposit: true,
    adjustment: true,
  })
  .extend({
    order: statementOrderSchema.nullable(),
    checkout: z.object({ id: z.uuid(), orders: z.array(statementOrderSchema) }).nullable(),
  })
  .meta({ id: 'StatementEntry' });

export type StatementEntry = z.infer<typeof statementEntrySchema>;

export const statementTotalSchema = z
  .object({ kind: journalKindSchema, count: z.int().positive(), amountUnits: z.int() })
  .meta({ id: 'StatementTotal' });

export type StatementTotal = z.infer<typeof statementTotalSchema>;

/**
 * S23 ID9: the tier held at the month's end (now for this month), the month's net purchases, the
 * savings (PG6; null unless priced by a tier's list) and the next tier with what was missing.
 */
export const statementTierSchema = z
  .object({
    tier: merchantTierSchema,
    netPurchasesUsdUnits: z.int(),
    savingsUsdUnits: amountUnitsSchema.nullable(),
    next: z.object({ tier: levelTierSchema, missingUsdUnits: amountUnitsSchema }).nullable(),
  })
  .meta({ id: 'StatementTier' });

export type StatementTier = z.infer<typeof statementTierSchema>;

/** `GET /api/merchant/statements/:month` (ST2). */
export const statementSchema = z
  .object({
    month: monthSchema,
    /** This month: "حتى تاريخه", as of `generatedAt` (edge case 20). */
    current: z.boolean(),
    generatedAt: z.iso.datetime(),
    tradeName: z.string(),
    email: z.string(),
    openingUsdUnits: z.int(),
    closingUsdUnits: z.int(),
    entries: z.array(statementEntrySchema),
    totals: z.array(statementTotalSchema),
    /** S23 ID9: "فئتك هذا الشهر"; null for a month before the tier history starts. */
    tier: statementTierSchema.nullable(),
  })
  .meta({ id: 'Statement' });

export type Statement = z.infer<typeof statementSchema>;

/** ST2: each kind's count and sum, in the journal kinds' order; kinds without entries left out. */
export function statementTotals(
  entries: readonly Pick<StatementEntry, 'kind' | 'amountUnits'>[],
): StatementTotal[] {
  return JOURNAL_KINDS.flatMap((kind) => {
    const own = entries.filter((entry) => entry.kind === kind);
    if (own.length === 0) return [];
    const amountUnits = own.reduce((sum, entry) => sum + entry.amountUnits, 0);
    return [{ kind, count: own.length, amountUnits }];
  });
}

/** ST2: opening + the sum of the entries = closing. */
export function statementBalances(
  openingUsdUnits: number,
  entries: readonly Pick<StatementEntry, 'amountUnits'>[],
  closingUsdUnits: number,
): boolean {
  const sum = entries.reduce((total, entry) => total + entry.amountUnits, 0);
  return openingUsdUnits + sum === closingUsdUnits;
}
