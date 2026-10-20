import {
  MARGIN_SCOPES,
  PRICE_CHANGE_CAUSES,
  PRICE_REVIEW_STATUSES,
  PRICE_SOURCES,
  ROOT_PRICE_LIST_IDS,
} from '@vertex-digital/contracts';
import { isNull, sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { catalogProducts } from './catalog.js';
import { amountUnits, archivedAt, id, timestamps } from './columns.js';
import { priceLists } from './price-lists.js';
import { productRoutes } from './suppliers.js';

/*
 * Margin rules (S06, F10; ADR 0020), owned by the api `pricing` module. `target_id` names a
 * category, game or product of the `catalog` module without a foreign key: the API checks it when
 * a rule is set. One live rule per target, and one global rule (seeded by 0025). S20: rules belong
 * to a price list (rows before it are retail's), one live rule per list and target, one live
 * global rule per list (root lists always have one, LS2).
 */

export const marginScopeEnum = pgEnum('margin_scope', MARGIN_SCOPES);

export const marginRules = pgTable(
  'margin_rules',
  {
    id: id(),
    /** S20: the retail default keeps the release before it working; the code always names one. */
    priceListId: uuid('price_list_id')
      .notNull()
      .default(ROOT_PRICE_LIST_IDS.retail)
      .references(() => priceLists.id),
    scope: marginScopeEnum('scope').notNull(),
    targetId: uuid('target_id'),
    percentBp: integer('percent_bp').notNull(),
    fixedUsdUnits: amountUnits('fixed_usd_units').notNull(),
    minMarginUsdUnits: amountUnits('min_margin_usd_units').notNull(),
    ...timestamps(),
    archivedAt: archivedAt(),
  },
  (table) => [
    uniqueIndex('margin_rules_list_scope_target_id_live_idx')
      .on(table.priceListId, table.scope, table.targetId)
      .where(isNull(table.archivedAt)),
    /** The global rule's `target_id` is null, which the index above treats as distinct. */
    uniqueIndex('margin_rules_list_global_live_idx')
      .on(table.priceListId)
      .where(sql`${table.scope} = 'global' and ${table.archivedAt} is null`),
    index('margin_rules_target_id_idx').on(table.targetId),
    check(
      'margin_rules_target_check',
      sql`(${table.scope} = 'global') = (${table.targetId} is null)`,
    ),
    check('margin_rules_percent_bp_check', sql`${table.percentBp} between 0 and 10000`),
    check(
      'margin_rules_fixed_check',
      sql`${table.fixedUsdUnits} between 0 and 50000000 and ${table.fixedUsdUnits} % 10000 = 0`,
    ),
    check(
      'margin_rules_min_margin_check',
      sql`${table.minMarginUsdUnits} between 10000 and 50000000 and ${table.minMarginUsdUnits} % 10000 = 0`,
    ),
  ],
);

/**
 * S20 LS2: a list's fixed price for a product, whole cents up to $10,000; one live row per list
 * and product. A change archives the row and inserts another, so a price row names the value used.
 */
export const priceListFixedPrices = pgTable(
  'price_list_fixed_prices',
  {
    id: id(),
    priceListId: uuid('price_list_id')
      .notNull()
      .references(() => priceLists.id),
    productId: uuid('product_id')
      .notNull()
      .references(() => catalogProducts.id),
    priceUsdUnits: amountUnits('price_usd_units').notNull(),
    ...timestamps(),
    archivedAt: archivedAt(),
  },
  (table) => [
    uniqueIndex('price_list_fixed_prices_list_product_live_idx')
      .on(table.priceListId, table.productId)
      .where(isNull(table.archivedAt)),
    index('price_list_fixed_prices_product_id_idx').on(table.productId),
    check(
      'price_list_fixed_prices_price_check',
      sql`${table.priceUsdUnits} > 0 and ${table.priceUsdUnits} <= 10000000000 and ${table.priceUsdUnits} % 10000 = 0`,
    ),
  ],
);

export const priceSourceEnum = pgEnum('price_source', PRICE_SOURCES);

export const priceChangeCauseEnum = pgEnum('price_change_cause', PRICE_CHANGE_CAUSES);

export const priceReviewStatusEnum = pgEnum('price_review_status', PRICE_REVIEW_STATUSES);

/**
 * A synced cost change held for the admin (S07 rules P2–P4, ADR 0021): one open review per
 * product. Closed by a decision, never archived.
 */
export const priceReviews = pgTable(
  'price_reviews',
  {
    id: id(),
    productId: uuid('product_id')
      .notNull()
      .references(() => catalogProducts.id),
    routeId: uuid('route_id')
      .notNull()
      .references(() => productRoutes.id),
    /** The cost the current price was built on. */
    costBeforeUsdUnits: amountUnits('cost_before_usd_units').notNull(),
    costAfterUsdUnits: amountUnits('cost_after_usd_units').notNull(),
    /** Signed basis points of the cost before; a cost can grow 10⁶ times (1 unit to $10,000). */
    changeBp: bigint('change_bp', { mode: 'number' }).notNull(),
    priceBeforeUsdUnits: amountUnits('price_before_usd_units').notNull(),
    proposedPriceUsdUnits: amountUnits('proposed_price_usd_units').notNull(),
    status: priceReviewStatusEnum('status').notNull().default('open'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    adminId: uuid('admin_id'),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('price_reviews_open_idx').on(table.productId).where(sql`${table.status} = 'open'`),
    index('price_reviews_product_id_idx').on(table.productId),
    index('price_reviews_route_id_idx').on(table.routeId),
    index('price_reviews_status_created_at_idx').on(table.status, table.createdAt),
    check(
      'price_reviews_amounts_check',
      sql`${table.costBeforeUsdUnits} > 0 and ${table.costAfterUsdUnits} > 0
        and ${table.priceBeforeUsdUnits} > 0 and ${table.priceBeforeUsdUnits} % 10000 = 0
        and ${table.proposedPriceUsdUnits} > 0 and ${table.proposedPriceUsdUnits} % 10000 = 0`,
    ),
    check(
      'price_reviews_decided_check',
      sql`(${table.status} = 'open') = (${table.decidedAt} is null)`,
    ),
  ],
);

/**
 * Stored prices (S07 rules P1, P2, P8): the newest row per product is its price, with the basis
 * route, its cost and the rule values used. Append-only (migration 0027), stamped at insert.
 * S20: the newest row per product and list is that list's price, with its source (LP1, LP2) and
 * the fixed price it used; `rule_id` is the rule whose values are copied (a fixed price's guarding
 * rule, or the retail row's rule when capped).
 */
export const productPrices = pgTable(
  'product_prices',
  {
    id: id(),
    productId: uuid('product_id')
      .notNull()
      .references(() => catalogProducts.id),
    /** S20: the retail default keeps the release before it working; the code always names one. */
    priceListId: uuid('price_list_id')
      .notNull()
      .default(ROOT_PRICE_LIST_IDS.retail)
      .references(() => priceLists.id),
    source: priceSourceEnum('source').notNull().default('rule'),
    fixedPriceId: uuid('fixed_price_id').references(() => priceListFixedPrices.id),
    priceUsdUnits: amountUnits('price_usd_units').notNull(),
    costUsdUnits: amountUnits('cost_usd_units').notNull(),
    routeId: uuid('route_id')
      .notNull()
      .references(() => productRoutes.id),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => marginRules.id),
    percentBp: integer('percent_bp').notNull(),
    fixedUsdUnits: amountUnits('fixed_usd_units').notNull(),
    minMarginUsdUnits: amountUnits('min_margin_usd_units').notNull(),
    cause: priceChangeCauseEnum('cause').notNull(),
    reviewId: uuid('review_id').references(() => priceReviews.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    index('product_prices_product_list_created_at_idx').on(
      table.productId,
      table.priceListId,
      table.createdAt.desc(),
    ),
    index('product_prices_price_list_id_idx').on(table.priceListId),
    index('product_prices_fixed_price_id_idx').on(table.fixedPriceId),
    check(
      'product_prices_fixed_price_check',
      sql`(${table.source} in ('fixed', 'fixed_fallback')) = (${table.fixedPriceId} is not null)`,
    ),
    index('product_prices_route_id_idx').on(table.routeId),
    index('product_prices_rule_id_idx').on(table.ruleId),
    index('product_prices_review_id_idx').on(table.reviewId),
    /** Rule P8: whole cents, above the cost. */
    check(
      'product_prices_price_check',
      sql`${table.priceUsdUnits} % 10000 = 0 and ${table.costUsdUnits} > 0 and ${table.priceUsdUnits} > ${table.costUsdUnits}`,
    ),
  ],
);
