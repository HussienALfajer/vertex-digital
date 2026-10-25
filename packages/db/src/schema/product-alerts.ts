import { PRODUCT_ALERT_KINDS, PRODUCT_ALERT_STATUSES } from '@vertex-digital/contracts';
import { sql } from 'drizzle-orm';
import { check, index, pgEnum, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { customers } from './auth.js';
import { catalogProducts } from './catalog.js';
import { amountUnits, id, timestamps } from './columns.js';
import { priceLists } from './price-lists.js';

/*
 * Availability and price-drop alerts (S22 F42, ADR 0037), owned by the api `catalog` module: the
 * customer's preference data, not a business record. An alert is sent once by the worker's
 * `catalog.product-alerts`, or ends without sending (expired, cancelled); ended rows are deleted
 * 90 days after they ended by `orders.sweep`.
 */

export const productAlertKindEnum = pgEnum('product_alert_kind', PRODUCT_ALERT_KINDS);

export const productAlertStatusEnum = pgEnum('product_alert_status', PRODUCT_ALERT_STATUSES);

export const productAlerts = pgTable(
  'product_alerts',
  {
    id: id(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    productId: uuid('product_id')
      .notNull()
      .references(() => catalogProducts.id),
    kind: productAlertKindEnum('kind').notNull(),
    /** PA1: the unit price the customer saw, whole cents; a price drop's only. */
    baselinePriceUsdUnits: amountUnits('baseline_price_usd_units'),
    /** The customer's effective list when the alert was set or last rebased (PA5). */
    priceListId: uuid('price_list_id')
      .notNull()
      .references(() => priceLists.id),
    status: productAlertStatusEnum('status').notNull().default('active'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    // PA1: one active alert of a kind per customer and pack.
    uniqueIndex('product_alerts_active_idx')
      .on(table.customerId, table.productId, table.kind)
      .where(sql`${table.status} = 'active'`),
    index('product_alerts_customer_idx').on(table.customerId, table.createdAt),
    index('product_alerts_product_idx').on(table.productId, table.status),
    index('product_alerts_status_idx').on(table.status, table.productId),
    index('product_alerts_price_list_idx').on(table.priceListId),
    check(
      'product_alerts_baseline_check',
      sql`(${table.kind} = 'price_drop') = (${table.baselinePriceUsdUnits} is not null) and (${table.baselinePriceUsdUnits} is null or (${table.baselinePriceUsdUnits} > 0 and ${table.baselinePriceUsdUnits} % 10000 = 0))`,
    ),
    check(
      'product_alerts_ended_check',
      sql`(${table.status} = 'active') = (${table.endedAt} is null) and (${table.status} = 'sent') = (${table.sentAt} is not null)`,
    ),
  ],
);
