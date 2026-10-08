import {
  CATALOG_STATUSES,
  INPUT_FIELD_TYPES,
  PRODUCT_KINDS,
  type SelectOption,
} from '@vertex-digital/contracts';
import { isNull, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { amountUnits, archivedAt, id, timestamps } from './columns.js';
import { storedFiles } from './files.js';

/*
 * The catalog (S06, F08), owned by the api `catalog` module. Business tables: archived, never
 * deleted (rule CT1). Slugs and field keys are unique across archived rows too (URLs and order
 * references are never reused); names are unique among unarchived siblings. Seeds: 0025.
 */

export const catalogStatusEnum = pgEnum('catalog_status', CATALOG_STATUSES);

export const productKindEnum = pgEnum('product_kind', PRODUCT_KINDS);

export const inputFieldTypeEnum = pgEnum('input_field_type', INPUT_FIELD_TYPES);

const SLUG = `'^[a-z0-9]+(-[a-z0-9]+)*$'`;

export const catalogCategories = pgTable(
  'catalog_categories',
  {
    id: id(),
    slug: text('slug').notNull().unique(),
    nameAr: text('name_ar').notNull(),
    sortOrder: integer('sort_order').notNull(),
    ...timestamps(),
    archivedAt: archivedAt(),
  },
  (table) => [
    uniqueIndex('catalog_categories_name_ar_live_idx')
      .on(table.nameAr)
      .where(isNull(table.archivedAt)),
    check(
      'catalog_categories_slug_check',
      sql`${table.slug} ~ ${sql.raw(SLUG)} and char_length(${table.slug}) between 2 and 48`,
    ),
    check('catalog_categories_name_ar_check', sql`char_length(${table.nameAr}) between 1 and 40`),
  ],
);

/** A game or an app (one table). New games start paused (rule CT3). */
export const catalogGames = pgTable(
  'catalog_games',
  {
    id: id(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => catalogCategories.id),
    slug: text('slug').notNull().unique(),
    nameAr: text('name_ar').notNull(),
    nameEn: text('name_en').notNull(),
    status: catalogStatusEnum('status').notNull().default('paused'),
    coverFileId: uuid('cover_file_id').references(() => storedFiles.id),
    idGuideFileId: uuid('id_guide_file_id').references(() => storedFiles.id),
    accentColor: text('accent_color'),
    regionNotesAr: text('region_notes_ar'),
    sortOrder: integer('sort_order').notNull(),
    ...timestamps(),
    archivedAt: archivedAt(),
  },
  (table) => [
    index('catalog_games_category_id_sort_order_idx').on(table.categoryId, table.sortOrder),
    index('catalog_games_cover_file_id_idx').on(table.coverFileId),
    index('catalog_games_id_guide_file_id_idx').on(table.idGuideFileId),
    uniqueIndex('catalog_games_name_ar_live_idx').on(table.nameAr).where(isNull(table.archivedAt)),
    check(
      'catalog_games_slug_check',
      sql`${table.slug} ~ ${sql.raw(SLUG)} and char_length(${table.slug}) between 2 and 48`,
    ),
    check('catalog_games_name_ar_check', sql`char_length(${table.nameAr}) between 1 and 60`),
    check('catalog_games_name_en_check', sql`char_length(${table.nameEn}) between 1 and 60`),
    check('catalog_games_accent_color_check', sql`${table.accentColor} ~ '^#[0-9A-F]{6}$'`),
    check(
      'catalog_games_region_notes_ar_check',
      sql`char_length(${table.regionNotesAr}) between 1 and 500`,
    ),
  ],
);

/** A value the customer types for a direct top-up (rule CT7). Key and type never change. */
export const catalogInputFields = pgTable(
  'catalog_input_fields',
  {
    id: id(),
    gameId: uuid('game_id')
      .notNull()
      .references(() => catalogGames.id),
    key: text('key').notNull(),
    labelAr: text('label_ar').notNull(),
    helpAr: text('help_ar'),
    type: inputFieldTypeEnum('type').notNull(),
    required: boolean('required').notNull(),
    minLength: integer('min_length'),
    maxLength: integer('max_length'),
    options: jsonb('options').$type<SelectOption[]>(),
    sortOrder: integer('sort_order').notNull(),
    ...timestamps(),
    archivedAt: archivedAt(),
  },
  (table) => [
    uniqueIndex('catalog_input_fields_game_id_key_idx').on(table.gameId, table.key),
    index('catalog_input_fields_game_id_sort_order_idx').on(table.gameId, table.sortOrder),
    check('catalog_input_fields_key_check', sql`${table.key} ~ '^[a-z][a-z0-9_]{1,31}$'`),
    check(
      'catalog_input_fields_label_ar_check',
      sql`char_length(${table.labelAr}) between 1 and 40`,
    ),
    check(
      'catalog_input_fields_help_ar_check',
      sql`char_length(${table.helpAr}) between 1 and 200`,
    ),
    check(
      'catalog_input_fields_bounds_check',
      sql`case ${table.type}
        when 'digits' then coalesce(${table.minLength} between 1 and 32, true)
          and coalesce(${table.maxLength} between 1 and 32, true)
        when 'text' then coalesce(${table.minLength} between 1 and 64, true)
          and coalesce(${table.maxLength} between 1 and 64, true)
        else ${table.minLength} is null and ${table.maxLength} is null
      end and coalesce(${table.minLength} <= ${table.maxLength}, true)`,
    ),
    check(
      'catalog_input_fields_options_check',
      sql`case ${table.type}
        when 'select' then jsonb_typeof(${table.options}) = 'array'
          and jsonb_array_length(${table.options}) between 2 and 50
        else ${table.options} is null
      end`,
    ),
  ],
);

/** A pack: a direct top-up or a code (rule CT8). The kind never changes. */
export const catalogProducts = pgTable(
  'catalog_products',
  {
    id: id(),
    gameId: uuid('game_id')
      .notNull()
      .references(() => catalogGames.id),
    kind: productKindEnum('kind').notNull(),
    nameAr: text('name_ar').notNull(),
    gameAmount: integer('game_amount'),
    /** Q13: entered by the admin, a reference for savings only (rule PR7). */
    officialPriceUsdUnits: amountUnits('official_price_usd_units'),
    maxQuantity: integer('max_quantity').notNull(),
    regionAr: text('region_ar'),
    redemptionAr: text('redemption_ar'),
    status: catalogStatusEnum('status').notNull().default('active'),
    sortOrder: integer('sort_order').notNull(),
    ...timestamps(),
    archivedAt: archivedAt(),
  },
  (table) => [
    index('catalog_products_game_id_sort_order_idx').on(table.gameId, table.sortOrder),
    uniqueIndex('catalog_products_game_id_name_ar_live_idx')
      .on(table.gameId, table.nameAr)
      .where(isNull(table.archivedAt)),
    check('catalog_products_name_ar_check', sql`char_length(${table.nameAr}) between 1 and 60`),
    check('catalog_products_game_amount_check', sql`${table.gameAmount} > 0`),
    check(
      'catalog_products_official_price_check',
      sql`${table.officialPriceUsdUnits} > 0 and ${table.officialPriceUsdUnits} % 10000 = 0`,
    ),
    check('catalog_products_max_quantity_check', sql`${table.maxQuantity} between 1 and 50`),
    check('catalog_products_region_ar_check', sql`char_length(${table.regionAr}) between 1 and 64`),
    check(
      'catalog_products_redemption_ar_check',
      sql`char_length(${table.redemptionAr}) between 1 and 2000`,
    ),
    check(
      'catalog_products_code_text_check',
      sql`${table.kind} = 'code' or (${table.regionAr} is null and ${table.redemptionAr} is null)`,
    ),
  ],
);
