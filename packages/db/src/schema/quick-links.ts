import { QUICK_LINK_EVENT_KINDS } from '@vertex-digital/contracts';
import { sql } from 'drizzle-orm';
import { check, index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { catalogProducts } from './catalog.js';
import { id } from './columns.js';
import { orders } from './orders.js';

/*
 * Direct buy links (S22 DL2, DL4, ADR 0037), owned by the api `catalog` module: a counting log of
 * link opens and the orders they led to. Never changed; rows older than 90 days are deleted by
 * `orders.sweep` (the guard of migration 0092). Never tied to money, and the visitor's address is
 * never stored here: opens are counted once per address, code and hour through the rate counters.
 */

export const quickLinkEventKindEnum = pgEnum('quick_link_event', QUICK_LINK_EVENT_KINDS);

export const quickLinkEvents = pgTable(
  'quick_link_events',
  {
    id: id(),
    productId: uuid('product_id')
      .notNull()
      .references(() => catalogProducts.id),
    campaign: text('campaign'),
    kind: quickLinkEventKindEnum('kind').notNull(),
    /** DL4: one row per order; a replayed purchase writes nothing new. */
    orderId: uuid('order_id')
      .unique()
      .references(() => orders.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    index('quick_link_events_product_id_created_at_idx').on(table.productId, table.createdAt),
    index('quick_link_events_created_at_idx').on(table.createdAt),
    check('quick_link_events_campaign_check', sql`${table.campaign} ~ '^[a-z0-9_-]{1,32}$'`),
    check(
      'quick_link_events_order_check',
      sql`(${table.kind} = 'order') = (${table.orderId} is not null)`,
    ),
  ],
);
