import { z } from 'zod';
import { pagedListSchema, pageQuerySchema } from './lists.js';
import { CURRENCY_SCALE, usdCentsSchema } from './money.js';

/*
 * The catalog (S06, F08), owned by the api `catalog` module: categories, games and apps, their
 * input fields and their products (packs). Rows are archived, never deleted (rule CT1). Text is
 * plain text, trimmed, rendered as text: never HTML or Markdown.
 */

export const CATALOG_STATUSES = ['active', 'paused'] as const;

export const catalogStatusSchema = z.enum(CATALOG_STATUSES).meta({ id: 'CatalogStatus' });

export type CatalogStatus = z.infer<typeof catalogStatusSchema>;

/** `direct`: topped up to a player id; `code`: a code the customer redeems (rule CT8). */
export const PRODUCT_KINDS = ['direct', 'code'] as const;

export const productKindSchema = z.enum(PRODUCT_KINDS).meta({ id: 'ProductKind' });

export type ProductKind = z.infer<typeof productKindSchema>;

/** Fixed field types with fixed value rules (rule CT7): no admin-defined patterns. */
export const INPUT_FIELD_TYPES = ['digits', 'text', 'select', 'phone'] as const;

export const inputFieldTypeSchema = z.enum(INPUT_FIELD_TYPES).meta({ id: 'InputFieldType' });

export type InputFieldType = z.infer<typeof inputFieldTypeSchema>;

/** A product's availability (rule CT9, ADR 0020), derived in this order, never stored. */
export const PRODUCT_AVAILABILITIES = [
  'hidden',
  'paused',
  'paused_by_margin_guard',
  'out_of_stock',
  'available',
] as const;

export const productAvailabilitySchema = z
  .enum(PRODUCT_AVAILABILITIES)
  .meta({ id: 'ProductAvailability' });

export type ProductAvailability = z.infer<typeof productAvailabilitySchema>;

/** What a game lacks to be activated (rule CT3), in `CATALOG_INCOMPLETE`'s `details.missing`. */
export const CATALOG_MISSING_ITEMS = ['cover', 'input_fields'] as const;

export type CatalogMissingItem = (typeof CATALOG_MISSING_ITEMS)[number];

/** At most this many unarchived input fields per game, and products per game (rules CT1, CT3). */
export const MAX_INPUT_FIELDS_PER_GAME = 10;
export const MAX_PRODUCTS_PER_GAME = 100;

/** The store's dark surface (green-900), the accent's required contrast partner (rule CT6). */
export const ACCENT_DARK_SURFACE = '#0B2D28';
export const ACCENT_LIGHT_SURFACE = '#FFFFFF';
export const ACCENT_MIN_CONTRAST = 3;

/** Catalog images (rule CT10): uploads up to 5 MB and 25 megapixels, stored within 1600 px. */
export const CATALOG_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const CATALOG_IMAGE_MAX_INPUT_PIXELS = 25_000_000;
export const CATALOG_IMAGE_MAX_DIMENSION = 1600;

/** Above this saving the panel warns that the official price should be checked (edge case 7). */
export const SAVINGS_WARNING_PERCENT = 50;

/** The most a product can be ordered at once (rule CT8), and its default per kind. */
export const MAX_QUANTITY_LIMIT = 50;
export const DEFAULT_MAX_QUANTITY: Record<ProductKind, number> = { direct: 1, code: 10 };

/** An official price is at most $10,000 (whole cents). */
const OFFICIAL_PRICE_MAX_USD_UNITS = 10_000 * CURRENCY_SCALE.USD;

/** One line of plain text: trimmed, no control characters. */
const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}]+$/u);

/** Plain text that may hold line breaks (`\n`), and no other control character. */
const paragraph = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^(?:[^\p{Cc}]|\n)+$/u);

/** A URL segment: lower-case Latin letters and digits in dash-separated words, 2–48 characters. */
export const slugSchema = z
  .string()
  .trim()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

/** `#RRGGBB`, stored upper case (rule CT6). */
export const accentColorSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^#[0-9A-F]{6}$/);

const englishNameSchema = line(60).regex(/^[\x20-\x7E]+$/);

/** The WCAG 2 relative luminance of an `#RRGGBB` color. */
function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/**
 * The WCAG 2 contrast ratio of two `#RRGGBB` colors, from 1 to 21, rounded **down** to 2
 * decimals: the ratio the panel shows is the one compared with `ACCENT_MIN_CONTRAST` (rule CT6).
 */
export function contrastRatio(hexA: string, hexB: string): number {
  for (const hex of [hexA, hexB]) {
    if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) throw new RangeError(`Not a #RRGGBB color: ${hex}`);
  }
  const [light, dark] = [luminance(hexA), luminance(hexB)].sort((a, b) => b - a) as [
    number,
    number,
  ];
  return Math.floor(((light + 0.05) / (dark + 0.05)) * 100) / 100;
}

/** The path of a catalog image on the public image route. */
export function catalogImagePath(fileId: string): string {
  return `/api/catalog/images/${fileId}`;
}

/** An uploaded catalog image (`POST /api/admin/catalog/images`), and as games carry it. */
export const catalogImageSchema = z
  .object({
    id: z.uuid(),
    url: z.string(),
    width: z.int().positive(),
    height: z.int().positive(),
  })
  .meta({ id: 'CatalogImage' });

export type CatalogImage = z.infer<typeof catalogImageSchema>;

/** The admin's archive filter: unarchived rows by default, archived ones with `true` (rule CT1). */
const archivedFilter = z.enum(['true', 'false']).optional();

/** Reorder the unarchived children of one parent (rule CT5): every id, once, in the new order. */
export const reorderSchema = z
  .object({
    ids: z
      .array(z.uuid())
      .min(1)
      .max(MAX_PRODUCTS_PER_GAME)
      .refine((ids) => new Set(ids).size === ids.length, 'Expected each id once'),
  })
  .meta({ id: 'Reorder' });

export type Reorder = z.infer<typeof reorderSchema>;

const record = {
  id: z.uuid(),
  sortOrder: z.int(),
  archivedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
};

// Categories ------------------------------------------------------------------------------------

export const categorySchema = z
  .object({
    ...record,
    slug: z.string(),
    nameAr: z.string(),
    /** Unarchived games in the category (rule CT2). */
    gameCount: z.int().nonnegative(),
  })
  .meta({ id: 'Category' });

export type Category = z.infer<typeof categorySchema>;

export const categoryListQuerySchema = z
  .object({ archived: archivedFilter })
  .meta({ id: 'CategoryListQuery' });

export type CategoryListQuery = z.infer<typeof categoryListQuerySchema>;

export const createCategorySchema = z
  .object({ slug: slugSchema, nameAr: line(40) })
  .meta({ id: 'CreateCategory' });

export type CreateCategory = z.input<typeof createCategorySchema>;

export const updateCategorySchema = createCategorySchema
  .pick({ nameAr: true })
  .meta({ id: 'UpdateCategory' });

export type UpdateCategory = z.input<typeof updateCategorySchema>;

// Input fields ----------------------------------------------------------------------------------

export const selectOptionSchema = z
  .object({ value: z.string().regex(/^[a-z0-9_-]{1,32}$/), labelAr: line(40) })
  .meta({ id: 'SelectOption' });

export type SelectOption = z.infer<typeof selectOptionSchema>;

const lengthBound = (max: number) => z.int().min(1).max(max).nullable().default(null);

/**
 * A field's type with what that type allows (rule CT7): length bounds for `digits` (1–32) and
 * `text` (1–64), 2–50 options with unique values for `select`, nothing more for `phone`.
 */
export const inputFieldShapeSchema = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('digits'),
      minLength: lengthBound(32),
      maxLength: lengthBound(32),
      options: z.null().default(null),
    }),
    z.object({
      type: z.literal('text'),
      minLength: lengthBound(64),
      maxLength: lengthBound(64),
      options: z.null().default(null),
    }),
    z.object({
      type: z.literal('select'),
      minLength: z.null().default(null),
      maxLength: z.null().default(null),
      options: z
        .array(selectOptionSchema)
        .min(2)
        .max(50)
        .refine(
          (options) => new Set(options.map((option) => option.value)).size === options.length,
          'Expected unique option values',
        ),
    }),
    z.object({
      type: z.literal('phone'),
      minLength: z.null().default(null),
      maxLength: z.null().default(null),
      options: z.null().default(null),
    }),
  ])
  .refine(
    (shape) =>
      shape.minLength === null || shape.maxLength === null || shape.minLength <= shape.maxLength,
    { message: 'Expected minLength ≤ maxLength', path: ['minLength'] },
  );

export type InputFieldShape = z.infer<typeof inputFieldShapeSchema>;

export const inputFieldSchema = z
  .object({
    ...record,
    gameId: z.uuid(),
    key: z.string(),
    labelAr: z.string(),
    helpAr: z.string().nullable(),
    type: inputFieldTypeSchema,
    required: z.boolean(),
    minLength: z.int().nullable(),
    maxLength: z.int().nullable(),
    options: z.array(selectOptionSchema).nullable(),
  })
  .meta({ id: 'InputField' });

export type InputField = z.infer<typeof inputFieldSchema>;

const inputFieldText = {
  labelAr: line(40),
  helpAr: line(200).nullable().optional(),
  required: z.boolean(),
};

/** The key is fixed at creation (rule CT7): orders and supplier mappings refer to it. */
export const createInputFieldSchema = inputFieldShapeSchema
  .and(z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/), ...inputFieldText }))
  .meta({ id: 'CreateInputField' });

export type CreateInputField = z.input<typeof createInputFieldSchema>;

/**
 * Everything but the key and the type (rule CT7). The bounds and options are checked again
 * against the stored type with `inputFieldShapeSchema`.
 */
export const updateInputFieldSchema = z
  .object({
    ...inputFieldText,
    minLength: z.int().nullable(),
    maxLength: z.int().nullable(),
    options: z.array(selectOptionSchema).nullable(),
  })
  .partial()
  .meta({ id: 'UpdateInputField' });

export type UpdateInputField = z.input<typeof updateInputFieldSchema>;

// Products --------------------------------------------------------------------------------------

export const productSchema = z
  .object({
    ...record,
    gameId: z.uuid(),
    kind: productKindSchema,
    nameAr: z.string(),
    gameAmount: z.int().nullable(),
    officialPriceUsdUnits: z.int().nullable(),
    maxQuantity: z.int(),
    regionAr: z.string().nullable(),
    redemptionAr: z.string().nullable(),
    status: catalogStatusSchema,
    availability: productAvailabilitySchema,
    /** The current stored price (S07 rule P2) and its SYP display price; null: none yet. */
    priceUsdUnits: z.int().nullable(),
    priceSypUnits: z.int().nullable(),
    /** The supplier of the route the price follows now (rule P1); null with no usable route. */
    basisSupplierNameAr: z.string().nullable(),
    /** A price review holds the price (rule P2). */
    reviewOpen: z.boolean(),
    /** Delivery time (S08 rule T1): null with fewer than 5 delivered orders. */
    deliveryStats: z
      .object({ medianMs: z.int().nonnegative(), p90Ms: z.int().nonnegative(), count: z.int() })
      .nullable(),
  })
  .meta({ id: 'Product' });

export type Product = z.infer<typeof productSchema>;

const officialPriceSchema = usdCentsSchema.min(1).max(OFFICIAL_PRICE_MAX_USD_UNITS);

const productValues = {
  nameAr: line(60),
  gameAmount: z.int().min(1).max(1_000_000_000).nullable().optional(),
  officialPriceUsdUnits: officialPriceSchema.nullable().optional(),
};

const maxQuantity = (kind: ProductKind) =>
  z.int().min(1).max(MAX_QUANTITY_LIMIT).default(DEFAULT_MAX_QUANTITY[kind]);

/** The kind is fixed at creation; region and redemption text exist for codes only (rule CT8). */
export const createProductSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('direct'), ...productValues, maxQuantity: maxQuantity('direct') }),
    z.object({
      kind: z.literal('code'),
      ...productValues,
      maxQuantity: maxQuantity('code'),
      regionAr: line(64).nullable().optional(),
      redemptionAr: paragraph(2000).nullable().optional(),
    }),
  ])
  .meta({ id: 'CreateProduct' });

export type CreateProduct = z.input<typeof createProductSchema>;

/** Everything but the kind; region and redemption text are refused on a `direct` product. */
export const updateProductSchema = z
  .object({
    ...productValues,
    maxQuantity: z.int().min(1).max(MAX_QUANTITY_LIMIT),
    regionAr: line(64).nullable(),
    redemptionAr: paragraph(2000).nullable(),
    status: catalogStatusSchema,
  })
  .partial()
  .meta({ id: 'UpdateProduct' });

export type UpdateProduct = z.input<typeof updateProductSchema>;

/** What a product's availability reads (rule CT9; S07 rule P6). */
export interface AvailabilityFacts {
  categoryArchived: boolean;
  gameArchived: boolean;
  productArchived: boolean;
  gameStatus: CatalogStatus;
  productStatus: CatalogStatus;
  /** The current stored price and the minimum margin of the rule that governs it; null: none. */
  price: { priceUsdUnits: number; minMarginUsdUnits: number } | null;
  /** The costs of the product's usable routes (rule RT4). */
  usableRouteCostsUsdUnits: readonly number[];
}

/**
 * A product's availability (rule CT9, ADR 0020; S07 rule P6), in order: `hidden`; `paused`;
 * `out_of_stock` with no current price or no usable route; `paused_by_margin_guard` when no usable
 * route is profitable for the current price (a review holds it); otherwise `available`.
 */
export function productAvailability(facts: AvailabilityFacts): ProductAvailability {
  if (facts.categoryArchived || facts.gameArchived || facts.productArchived) return 'hidden';
  if (facts.gameStatus === 'paused' || facts.productStatus === 'paused') return 'paused';
  const { price } = facts;
  if (price === null || facts.usableRouteCostsUsdUnits.length === 0) return 'out_of_stock';
  const profitable = facts.usableRouteCostsUsdUnits.some(
    (cost) => price.priceUsdUnits - cost >= price.minMarginUsdUnits,
  );
  return profitable ? 'available' : 'paused_by_margin_guard';
}

// Search text (S09, F15) ------------------------------------------------------------------------

const ARABIC_LETTER_FOLDS: Readonly<Record<string, string>> = {
  أ: 'ا',
  إ: 'ا',
  آ: 'ا',
  ٱ: 'ا',
  ة: 'ه',
  ى: 'ي',
  ؤ: 'و',
  ئ: 'ي',
};

/**
 * Rule SR1: lower case and NFKC; Arabic diacritics and tatweel removed; hamza and alef forms,
 * taa marbuta and alef maqsura folded; Arabic-Indic and Persian digits to Latin; anything but
 * letters and digits to one space; trimmed. Search terms are stored in this form.
 */
export function normalizeSearchText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱةىؤئ]/g, (letter) => ARABIC_LETTER_FOLDS[letter] as string)
    .replace(/[\u0660-\u0669]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** A game's search terms (rule AD1): 0–20, each 1–40 characters once normalized, unique. */
export const MAX_SEARCH_TERMS = 20;

export const searchTermsSchema = z
  .array(z.string().max(200).transform(normalizeSearchText).pipe(z.string().min(1).max(40)))
  .max(MAX_SEARCH_TERMS)
  .refine((terms) => new Set(terms).size === terms.length, 'Expected unique search terms');

// Games -----------------------------------------------------------------------------------------

export const gameSchema = z
  .object({
    ...record,
    categoryId: z.uuid(),
    slug: z.string(),
    nameAr: z.string(),
    nameEn: z.string(),
    status: catalogStatusSchema,
    cover: catalogImageSchema.nullable(),
    idGuide: catalogImageSchema.nullable(),
    accentColor: z.string().nullable(),
    regionNotesAr: z.string().nullable(),
    /** Unarchived products. */
    productCount: z.int().nonnegative(),
  })
  .meta({ id: 'Game' });

export type Game = z.infer<typeof gameSchema>;

/** A game with every field and product, archived ones included (marked by `archivedAt`). */
export const gameDetailSchema = gameSchema
  .extend({
    categoryArchived: z.boolean(),
    /** Normalized search terms (S09 rule SR1, AD1). */
    searchTerms: z.array(z.string()),
    fields: z.array(inputFieldSchema),
    products: z.array(productSchema),
  })
  .meta({ id: 'GameDetail' });

export type GameDetail = z.infer<typeof gameDetailSchema>;

const gameValues = {
  categoryId: z.uuid(),
  nameAr: line(60),
  nameEn: englishNameSchema,
  coverFileId: z.uuid().nullable().optional(),
  idGuideFileId: z.uuid().nullable().optional(),
  accentColor: accentColorSchema.nullable().optional(),
  regionNotesAr: paragraph(500).nullable().optional(),
};

/** A new game starts `paused` (rule CT3). */
export const createGameSchema = z
  .object({ slug: slugSchema, ...gameValues })
  .meta({ id: 'CreateGame' });

export type CreateGame = z.input<typeof createGameSchema>;

/** Everything but the slug (immutable: URLs are never reused), the status and search terms. */
export const updateGameSchema = z
  .object({ ...gameValues, status: catalogStatusSchema, searchTerms: searchTermsSchema })
  .partial()
  .meta({ id: 'UpdateGame' });

export type UpdateGame = z.input<typeof updateGameSchema>;

export const gameListQuerySchema = pageQuerySchema
  .extend({
    categoryId: z.uuid().optional(),
    status: catalogStatusSchema.optional(),
    archived: archivedFilter,
    /** Part of the Arabic or English name, or of the slug. */
    q: z.string().trim().min(1).max(60).optional(),
  })
  .meta({ id: 'GameListQuery' });

export type GameListQuery = z.infer<typeof gameListQuerySchema>;

export const gamePageSchema = pagedListSchema(gameSchema, 'GamePage');

export type GamePage = z.infer<typeof gamePageSchema>;

/** What a game lacks to be `active` (rule CT3); empty when it may be activated. */
export function missingForActivation(game: {
  hasCover: boolean;
  hasDirectProduct: boolean;
  hasRequiredField: boolean;
}): CatalogMissingItem[] {
  const missing: CatalogMissingItem[] = [];
  if (!game.hasCover) missing.push('cover');
  if (game.hasDirectProduct && !game.hasRequiredField) missing.push('input_fields');
  return missing;
}

// Store (S09, F12, F15): public, cached, never a supplier, cost or health number (rule SS3) ------

/** A game's service status on the store (rule SS1). */
export const GAME_SERVICE_STATUSES = ['normal', 'slow', 'unavailable'] as const;

export const gameServiceStatusSchema = z
  .enum(GAME_SERVICE_STATUSES)
  .meta({ id: 'GameServiceStatus' });

export type GameServiceStatus = z.infer<typeof gameServiceStatusSchema>;

/** The home page's service line (rule SS2). */
export const STORE_SERVICE_STATES = ['normal', 'slow'] as const;

export const storeServiceStateSchema = z
  .enum(STORE_SERVICE_STATES)
  .meta({ id: 'StoreServiceState' });

export type StoreServiceState = z.infer<typeof storeServiceStateSchema>;

/** What rule SS1 reads of one unarchived product. */
export interface ProductServiceFacts {
  available: boolean;
  /** The product's basis route (S07 P1, RT5) is an automatic route on a healthy supplier. */
  healthyAutomaticBasis: boolean;
}

/**
 * Rule SS1: `normal` when an available product's basis route is a healthy automatic route,
 * `slow` when products are available but none is, `unavailable` when none is available.
 */
export function gameServiceStatus(products: readonly ProductServiceFacts[]): GameServiceStatus {
  const available = products.filter((product) => product.available);
  if (available.length === 0) return 'unavailable';
  return available.some((product) => product.healthyAutomaticBasis) ? 'normal' : 'slow';
}

/** Rule SS2: `slow` when a shown game is `slow`; an `unavailable` game does not change the line. */
export function storeServiceState(games: readonly GameServiceStatus[]): StoreServiceState {
  return games.includes('slow') ? 'slow' : 'normal';
}

/** The widths the public image route serves (rule SF5); the store's `srcset` uses them. */
export const CATALOG_IMAGE_WIDTHS = [160, 320, 640, 1280] as const;

export type CatalogImageWidth = (typeof CATALOG_IMAGE_WIDTHS)[number];

/** `GET /api/catalog/images/:id?w=`: one of the widths, or the stored original. */
export const catalogImageQuerySchema = z
  .object({
    w: z
      .enum(CATALOG_IMAGE_WIDTHS.map(String) as [string, ...string[]])
      .transform((width) => Number(width) as CatalogImageWidth)
      .optional(),
  })
  .meta({ id: 'CatalogImageQuery' });

export type CatalogImageQuery = z.infer<typeof catalogImageQuerySchema>;

const storeDeliveryStats = productSchema.shape.deliveryStats;

/** A pack on a game page (rule SF2): no price while unavailable. */
export const storeProductSchema = z
  .object({
    id: z.uuid(),
    kind: productKindSchema,
    nameAr: z.string(),
    gameAmount: z.int().nullable(),
    maxQuantity: z.int().positive(),
    available: z.boolean(),
    priceUsdUnits: z.int().positive().nullable(),
    priceSypUnits: z.int().nullable(),
    /** S06 rule PR7, when the official price is above the price. */
    savings: z
      .object({ amountUsdUnits: z.int().positive(), percent: z.int().positive().nullable() })
      .nullable(),
    deliveryStats: storeDeliveryStats,
    /** Rule PV1 says the player id can be checked for this pack (quota aside). */
    playerCheck: z.boolean(),
    regionAr: z.string().nullable(),
    redemptionAr: z.string().nullable(),
  })
  .meta({ id: 'StoreProduct' });

export type StoreProduct = z.infer<typeof storeProductSchema>;

/** One input field of a game's buy box (rule BB1). */
export const storeFieldSchema = inputFieldSchema
  .pick({
    key: true,
    labelAr: true,
    helpAr: true,
    type: true,
    required: true,
    minLength: true,
    maxLength: true,
    options: true,
  })
  .meta({ id: 'StoreField' });

export type StoreField = z.infer<typeof storeFieldSchema>;

const storeGameCard = z.object({
  id: z.uuid(),
  slug: z.string(),
  nameAr: z.string(),
  nameEn: z.string(),
  cover: catalogImageSchema.nullable(),
  accentColor: z.string().nullable(),
  status: gameServiceStatusSchema,
});

/** `GET /api/catalog/storefront` (rules SF1, SS2). */
export const storefrontSchema = z
  .object({
    service: storeServiceStateSchema,
    categories: z.array(
      z.object({ slug: z.string(), nameAr: z.string(), games: z.array(storeGameCard) }),
    ),
  })
  .meta({ id: 'Storefront' });

export type Storefront = z.infer<typeof storefrontSchema>;

/** `GET /api/catalog/games/:slug` (rules SF1–SF3, BB1). */
export const storeGameSchema = z
  .object({
    game: storeGameCard.extend({
      idGuide: catalogImageSchema.nullable(),
      regionNotesAr: z.string().nullable(),
    }),
    fields: z.array(storeFieldSchema),
    products: z.array(storeProductSchema),
    /** The rate the SYP prices use; null without one (SYP hidden). */
    rateId: z.uuid().nullable(),
  })
  .meta({ id: 'StoreGame' });

export type StoreGame = z.infer<typeof storeGameSchema>;

/** `GET /api/catalog/search-index` (rule SR2): shown games and their unarchived products. */
export const searchIndexSchema = z
  .object({
    games: z.array(
      storeGameCard
        .pick({ id: true, slug: true, nameAr: true, nameEn: true, cover: true, status: true })
        .extend({ searchTerms: z.array(z.string()), categoryNameAr: z.string() }),
    ),
    products: z.array(
      storeProductSchema
        .pick({
          id: true,
          nameAr: true,
          gameAmount: true,
          available: true,
          priceUsdUnits: true,
          priceSypUnits: true,
        })
        .extend({ gameSlug: z.string() }),
    ),
  })
  .meta({ id: 'SearchIndex' });

export type SearchIndex = z.infer<typeof searchIndexSchema>;

export type SearchIndexGame = SearchIndex['games'][number];

export type SearchIndexProduct = SearchIndex['products'][number];

// Search matching (rules SR3, SR4) ---------------------------------------------------------------

/** A token's match: exact, prefix or fuzzy, best first. */
type MatchQuality = 0 | 1 | 2;

const NO_MATCH = 3;

export const SEARCH_MAX_GAMES = 6;
export const SEARCH_MAX_PRODUCTS = 8;

/** Damerau–Levenshtein distance (optimal string alignment), or `limit + 1` once above `limit`. */
function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let before: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, (before[j - 2] as number) + 1);
      }
      current.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > limit) return limit + 1;
    before = previous;
    previous = current;
  }
  return previous[b.length] as number;
}

/** Rule SR3 for one query token against one target token. */
function tokenMatch(query: string, target: string): MatchQuality | typeof NO_MATCH {
  if (query === target) return 0;
  if (query.length >= 2 && target.startsWith(query)) return 1;
  if (/\d/.test(query)) return NO_MATCH;
  const limit = query.length >= 8 ? 2 : query.length >= 4 ? 1 : 0;
  if (limit === 0) return NO_MATCH;
  return editDistance(query, target, limit) <= limit ? 2 : NO_MATCH;
}

/** The worst of the query tokens' best matches, or `NO_MATCH` when a token matches nothing. */
function textMatch(queryTokens: readonly string[], targetTokens: readonly string[]): number {
  let worst = 0;
  for (const query of queryTokens) {
    let best: number = NO_MATCH;
    for (const target of targetTokens) best = Math.min(best, tokenMatch(query, target));
    if (best === NO_MATCH) return NO_MATCH;
    worst = Math.max(worst, best);
  }
  return worst;
}

const tokens = (texts: readonly string[]) =>
  texts.flatMap((text) => normalizeSearchText(text).split(' ')).filter((token) => token !== '');

export interface SearchResults {
  games: SearchIndexGame[];
  products: SearchIndexProduct[];
}

/**
 * Rules SR3–SR4: every query token must match a name or term token; a pack also matches through
 * its game's names and terms. Ranked exact over prefix over fuzzy, available first, then catalog
 * order; at most 6 games and 8 packs. An empty query finds nothing.
 */
export function searchCatalog(index: SearchIndex, query: string): SearchResults {
  const queryTokens = tokens([query]);
  if (queryTokens.length === 0) return { games: [], products: [] };
  const gameTokens = new Map(
    index.games.map((game) => [game.slug, tokens([game.nameAr, game.nameEn, ...game.searchTerms])]),
  );
  const rank = <Item>(
    items: readonly Item[],
    quality: (item: Item) => number,
    available: (item: Item) => boolean,
    limit: number,
  ) =>
    items
      .map((item, order) => ({
        item,
        order,
        quality: quality(item),
        unavailable: available(item) ? 0 : 1,
      }))
      .filter((entry) => entry.quality !== NO_MATCH)
      .sort((a, b) => a.quality - b.quality || a.unavailable - b.unavailable || a.order - b.order)
      .slice(0, limit)
      .map((entry) => entry.item);
  return {
    games: rank(
      index.games,
      (game) => textMatch(queryTokens, gameTokens.get(game.slug) as string[]),
      (game) => game.status !== 'unavailable',
      SEARCH_MAX_GAMES,
    ),
    products: rank(
      index.products,
      (product) =>
        textMatch(queryTokens, [
          ...tokens([product.nameAr]),
          ...(gameTokens.get(product.gameSlug) ?? []),
        ]),
      (product) => product.available,
      SEARCH_MAX_PRODUCTS,
    ),
  };
}

// "كم أحتاج؟" (rules CL1–CL3) ------------------------------------------------------------------

/** The calculator's target amount (rule CL1). */
export const CALCULATOR_MAX_TARGET = 100_000;

export interface CalculatorPack {
  id: string;
  gameAmount: number;
  priceUsdUnits: number;
}

export interface PackCombination {
  lines: { packId: string; count: number }[];
  totalAmount: number;
  totalUsdUnits: number;
  /** How far the total amount is above the target. */
  overshoot: number;
}

/**
 * Rule CL2: the counts of packs whose amounts reach at least `target` at the lowest USD price;
 * ties go to fewer packs, then to the smaller overshoot. A pack whose amount reaches the target on
 * its own is only ever bought alone (anything added to it costs more), so the dynamic programming
 * runs over the smaller packs up to `target + their largest amount`. Null without packs.
 */
export function cheapestPackCombination(
  packs: readonly CalculatorPack[],
  target: number,
): PackCombination | null {
  if (!Number.isInteger(target) || target < 1 || target > CALCULATOR_MAX_TARGET) {
    throw new RangeError(`Target out of range: ${target}`);
  }
  type Candidate = { cost: number; count: number; amount: number; counts: Map<number, number> };
  const better = (a: Candidate, b: Candidate | null) =>
    b === null ||
    a.cost < b.cost ||
    (a.cost === b.cost && (a.count < b.count || (a.count === b.count && a.amount < b.amount)));
  let best: Candidate | null = null;

  packs.forEach((pack, index) => {
    if (pack.gameAmount < target) return;
    const alone = {
      cost: pack.priceUsdUnits,
      count: 1,
      amount: pack.gameAmount,
      counts: new Map([[index, 1]]),
    };
    if (better(alone, best)) best = alone;
  });

  const small = packs.flatMap((pack, index) => (pack.gameAmount < target ? [{ pack, index }] : []));
  if (small.length > 0) {
    const limit = target - 1 + Math.max(...small.map(({ pack }) => pack.gameAmount));
    const cost = new Array<number>(limit + 1).fill(Number.POSITIVE_INFINITY);
    const count = new Array<number>(limit + 1).fill(0);
    const via = new Int32Array(limit + 1).fill(-1);
    cost[0] = 0;
    for (let amount = 0; amount < target; amount += 1) {
      const here = cost[amount] as number;
      if (here === Number.POSITIVE_INFINITY) continue;
      for (const { pack, index } of small) {
        const next = amount + pack.gameAmount;
        const nextCost = here + pack.priceUsdUnits;
        const nextCount = (count[amount] as number) + 1;
        const known = cost[next] as number;
        if (nextCost < known || (nextCost === known && nextCount < (count[next] as number))) {
          cost[next] = nextCost;
          count[next] = nextCount;
          via[next] = index;
        }
      }
    }
    for (let amount = target; amount <= limit; amount += 1) {
      const total = cost[amount] as number;
      if (total === Number.POSITIVE_INFINITY) continue;
      const candidate = {
        cost: total,
        count: count[amount] as number,
        amount,
        counts: new Map<number, number>(),
      };
      if (!better(candidate, best)) continue;
      for (let at = amount; at > 0; ) {
        const index = via[at] as number;
        candidate.counts.set(index, (candidate.counts.get(index) ?? 0) + 1);
        at -= (packs[index] as CalculatorPack).gameAmount;
      }
      best = candidate;
    }
  }

  const found = best as Candidate | null;
  if (found === null) return null;
  return {
    lines: [...found.counts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, packCount]) => ({
        packId: (packs[index] as CalculatorPack).id,
        count: packCount,
      })),
    totalAmount: found.amount,
    totalUsdUnits: found.cost,
    overshoot: found.amount - target,
  };
}
