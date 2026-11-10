import { SHOP_COMPENSATION_MARGIN_SOURCES } from '@vertex-digital/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { amountUnits, id } from './columns.js';
import { saleCurrencyEnum } from './merchant-tools.js';
import { orders } from './orders.js';
import { merchantShops, shopCustomers } from './shops.js';
import { ledgerJournals } from './wallet.js';

/*
 * What a shop order sold for (S26 PR6, PR8, PR10, ADR 0040), owned by the api `shops` module and
 * written by `packages/db/src/orders` in the order's own transactions: the sale row of every shop
 * order and the compensations after delivery. A table over two modules' tables, so a file of its
 * own (packages/db/CLAUDE.md).
 */

export const shopCompensationMarginSourceEnum = pgEnum(
  'shop_compensation_margin_source',
  SHOP_COMPENSATION_MARGIN_SOURCES,
);

/**
 * PR6: one row per shop order, written with it: the unit selling price the customer paid, the
 * merchant's unit price (the order's), how the price was set and the shop's rate then. Fixed after
 * insert but `margin_released_usd_units`, set once when the order finishes (PR8).
 */
export const shopOrderSales = pgTable(
  'shop_order_sales',
  {
    orderId: uuid('order_id')
      .primaryKey()
      .references(() => orders.id),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => merchantShops.id),
    shopCustomerId: uuid('shop_customer_id')
      .notNull()
      .references(() => shopCustomers.id),
    unitSellUsdUnits: amountUnits('unit_sell_usd_units').notNull(),
    unitBuyUsdUnits: amountUnits('unit_buy_usd_units').notNull(),
    quantity: integer('quantity').notNull(),
    /** How the merchant set the price: `syp` for an own SYP price, else `usd`. */
    sellCurrency: saleCurrencyEnum('sell_currency').notNull(),
    /** The own SYP price as set, or the unit selling price in USD. */
    unitSellEnteredUnits: amountUnits('unit_sell_entered_units').notNull(),
    /** ST4: the unit's SYP shown at purchase, at the shop's rate; null without one. */
    unitSellSypUnits: amountUnits('unit_sell_syp_units'),
    rateSypPerUsd: numeric('rate_syp_per_usd', { precision: 12, scale: 4 }),
    marginReleasedUsdUnits: amountUnits('margin_released_usd_units'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('shop_order_sales_shop_idx').on(table.shopId, table.createdAt.desc()),
    index('shop_order_sales_customer_idx').on(table.shopCustomerId, table.createdAt.desc()),
    check(
      'shop_order_sales_amount_check',
      sql`${table.unitBuyUsdUnits} > 0 and ${table.unitBuyUsdUnits} % 10000 = 0
        and ${table.unitSellUsdUnits} >= ${table.unitBuyUsdUnits} and ${table.unitSellUsdUnits} % 10000 = 0
        and ${table.quantity} > 0 and ${table.unitSellEnteredUnits} > 0
        and (${table.sellCurrency} <> 'usd' or ${table.unitSellEnteredUnits} = ${table.unitSellUsdUnits})
        and (${table.sellCurrency} = 'usd' or ${table.rateSypPerUsd} is not null)
        and (${table.rateSypPerUsd} is null or ${table.rateSypPerUsd} > 0)
        and (${table.marginReleasedUsdUnits} is null or ${table.marginReleasedUsdUnits} >= 0)`,
    ),
  ],
);

/**
 * PR10 (append-only): one compensation of a delivered shop order, with its journals: Vertex's part
 * as an `adjustment` against `adjustments:compensation` (the margin too when the store covers it),
 * and the margin part as a `shop_margin` journal from the merchant's wallet when the merchant pays
 * it. The reason is the audit entry's.
 */
export const shopCompensations = pgTable(
  'shop_compensations',
  {
    id: id(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => merchantShops.id),
    shopCustomerId: uuid('shop_customer_id')
      .notNull()
      .references(() => shopCustomers.id),
    units: integer('units').notNull(),
    vertexUsdUnits: amountUnits('vertex_usd_units').notNull(),
    /** The margin owed back (zero when it was never released). */
    marginUsdUnits: amountUnits('margin_usd_units').notNull(),
    marginFrom: shopCompensationMarginSourceEnum('margin_from').notNull(),
    adjustmentJournalId: uuid('adjustment_journal_id')
      .notNull()
      .unique()
      .references(() => ledgerJournals.id),
    marginJournalId: uuid('margin_journal_id')
      .unique()
      .references(() => ledgerJournals.id),
    idempotencyKey: uuid('idempotency_key').notNull().unique(),
    /** The single admin, without a foreign key (ADR 0016). */
    adminId: uuid('admin_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    index('shop_compensations_order_idx').on(table.orderId),
    index('shop_compensations_shop_id_idx').on(table.shopId),
    index('shop_compensations_shop_customer_id_idx').on(table.shopCustomerId),
    check(
      'shop_compensations_amount_check',
      sql`${table.units} > 0 and ${table.vertexUsdUnits} > 0 and ${table.vertexUsdUnits} % 10000 = 0
        and ${table.marginUsdUnits} >= 0 and ${table.marginUsdUnits} % 10000 = 0
        and (${table.marginJournalId} is not null) = (${table.marginFrom} = 'merchant' and ${table.marginUsdUnits} > 0)`,
    ),
  ],
);
