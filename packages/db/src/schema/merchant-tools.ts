import { ALERT_KINDS, SALE_CURRENCIES, SALE_SOURCES } from '@vertex-digital/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { customers } from './auth.js';
import { catalogGames, catalogProducts } from './catalog.js';
import { amountUnits, id } from './columns.js';
import { orders } from './orders.js';
import { exchangeRates } from './rates.js';

/*
 * The merchant area (S21 F30, F31, F37; ADR 0036), owned by the api `merchant-tools` module: the
 * merchant's own preferences (selling prices, follows, alert settings), the sale row of each
 * merchant order, and what the hourly alerts told. None of it is a money record: no ledger
 * posting, and the order itself is never changed.
 */

export const saleCurrencyEnum = pgEnum('sale_currency', SALE_CURRENCIES);
export const saleSourceEnum = pgEnum('sale_source', SALE_SOURCES);
export const merchantAlertKindEnum = pgEnum('merchant_alert_kind', ALERT_KINDS);

const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** SP1: the markup (null: none) and the SYP step (null: the store's display step). */
export const merchantSellingSettings = pgTable(
  'merchant_selling_settings',
  {
    customerId: uuid('customer_id')
      .primaryKey()
      .references(() => customers.id),
    markupBp: integer('markup_bp'),
    sypStepUnits: amountUnits('syp_step_units'),
    updatedAt: updatedAt(),
  },
  (table) => [
    check(
      'merchant_selling_settings_check',
      sql`(${table.markupBp} is null or ${table.markupBp} between 0 and 10000)
        and (${table.sypStepUnits} is null or ${table.sypStepUnits} in (500, 1000, 5000, 10000, 50000, 100000))`,
    ),
  ],
);

/** SP2: a product's own selling price in USD (whole cents) or SYP (whole pounds); deleted when cleared. */
export const merchantSellingPrices = pgTable(
  'merchant_selling_prices',
  {
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    productId: uuid('product_id')
      .notNull()
      .references(() => catalogProducts.id),
    currency: saleCurrencyEnum('currency').notNull(),
    amountUnits: amountUnits('amount_units').notNull(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ columns: [table.customerId, table.productId] }),
    index('merchant_selling_prices_product_id_idx').on(table.productId),
    check(
      'merchant_selling_prices_amount_check',
      sql`${table.amountUnits} > 0 and (
        (${table.currency} = 'usd' and ${table.amountUnits} % 10000 = 0 and ${table.amountUnits} <= 10000000000)
        or (${table.currency} = 'syp' and ${table.amountUnits} % 100 = 0))`,
    ),
  ],
);

/**
 * SP4, SP5: one row per merchant order with a selling price, written in the purchase or checkout
 * transaction, changed later by the merchant (`manual`). `unit_usd_units` is the USD equivalent at
 * `rate_id`, rounded down to whole cents.
 */
export const merchantOrderSales = pgTable(
  'merchant_order_sales',
  {
    orderId: uuid('order_id')
      .primaryKey()
      .references(() => orders.id),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    currency: saleCurrencyEnum('currency').notNull(),
    unitAmountUnits: amountUnits('unit_amount_units').notNull(),
    /** The rate in force at purchase; null only when the store had no rate (a USD sale). */
    rateId: uuid('rate_id').references(() => exchangeRates.id),
    unitUsdUnits: amountUnits('unit_usd_units').notNull(),
    source: saleSourceEnum('source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('merchant_order_sales_customer_id_idx').on(table.customerId, table.orderId),
    index('merchant_order_sales_rate_id_idx').on(table.rateId),
    check(
      'merchant_order_sales_amount_check',
      sql`${table.unitAmountUnits} > 0 and ${table.unitUsdUnits} >= 0
        and ${table.unitUsdUnits} % 10000 = 0
        and (${table.currency} = 'usd' or ${table.rateId} is not null)
        and (${table.currency} <> 'usd' or ${table.unitUsdUnits} = ${table.unitAmountUnits})`,
    ),
  ],
);

/** AL1: a followed game or product (exactly one), at most 200 per merchant (the API). */
export const merchantWatches = pgTable(
  'merchant_watches',
  {
    id: id(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    gameId: uuid('game_id').references(() => catalogGames.id),
    productId: uuid('product_id').references(() => catalogProducts.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('merchant_watches_game_idx')
      .on(table.customerId, table.gameId)
      .where(sql`${table.gameId} is not null`),
    uniqueIndex('merchant_watches_product_idx')
      .on(table.customerId, table.productId)
      .where(sql`${table.productId} is not null`),
    index('merchant_watches_customer_id_idx').on(table.customerId),
    index('merchant_watches_game_id_idx').on(table.gameId),
    index('merchant_watches_product_id_idx').on(table.productId),
    check(
      'merchant_watches_target_check',
      sql`(${table.gameId} is null) <> (${table.productId} is null)`,
    ),
  ],
);

/** AL2: what the merchant was last told of a product, written by the alerts job only. */
export const merchantWatchStates = pgTable(
  'merchant_watch_states',
  {
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    productId: uuid('product_id')
      .notNull()
      .references(() => catalogProducts.id),
    priceUsdUnits: amountUnits('price_usd_units'),
    available: boolean('available').notNull(),
    toldAt: timestamp('told_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.customerId, table.productId] }),
    index('merchant_watch_states_product_id_idx').on(table.productId),
  ],
);

/**
 * AL2–AL4: what each hourly digest said. Never updated; only rows older than 90 days are deleted,
 * by the sweep (`merchant_alert_events_guard`, migration 0084).
 */
export const merchantAlertEvents = pgTable(
  'merchant_alert_events',
  {
    id: id(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    productId: uuid('product_id')
      .notNull()
      .references(() => catalogProducts.id),
    kind: merchantAlertKindEnum('kind').notNull(),
    oldPriceUsdUnits: amountUnits('old_price_usd_units'),
    newPriceUsdUnits: amountUnits('new_price_usd_units'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    index('merchant_alert_events_customer_idx').on(table.customerId, table.createdAt.desc()),
    index('merchant_alert_events_product_id_idx').on(table.productId),
    index('merchant_alert_events_created_at_idx').on(table.createdAt),
  ],
);

/** AL4–AL6: the low-balance threshold (null: off), the daily email and when the alert was sent. */
export const merchantAlertSettings = pgTable(
  'merchant_alert_settings',
  {
    customerId: uuid('customer_id')
      .primaryKey()
      .references(() => customers.id),
    lowBalanceUsdUnits: amountUnits('low_balance_usd_units'),
    dailyEmail: boolean('daily_email').notNull().default(false),
    lowBalanceAlertedAt: timestamp('low_balance_alerted_at', { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (table) => [
    check(
      'merchant_alert_settings_threshold_check',
      sql`${table.lowBalanceUsdUnits} is null or (${table.lowBalanceUsdUnits} between 1000000 and 10000000000
        and ${table.lowBalanceUsdUnits} % 10000 = 0)`,
    ),
  ],
);
