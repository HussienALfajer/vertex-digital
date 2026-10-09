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

/** Everything but the slug (immutable: URLs are never reused), and the status. */
export const updateGameSchema = z
  .object({ ...gameValues, status: catalogStatusSchema })
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
