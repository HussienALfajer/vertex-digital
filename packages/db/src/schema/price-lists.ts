import { PRICE_LIST_KINDS } from '@vertex-digital/contracts';
import { isNull, sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  index,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { archivedAt, id, timestamps } from './columns.js';

/*
 * Price lists (S20 F29, ADR 0035), owned by the api `pricing` module. Apart from `pricing.ts` so
 * `customers` (auth) can reference them without importing the pricing tables' graph.
 */

export const priceListKindEnum = pgEnum('price_list_kind', PRICE_LIST_KINDS);

/**
 * Price lists (S20 F29, ADR 0035): the seeded roots (retail, wholesale, cost; fixed ids, never
 * archived) and the admin's custom lists, each with a parent fixed at creation (LS1, LS3).
 */
export const priceLists = pgTable(
  'price_lists',
  {
    id: id(),
    kind: priceListKindEnum('kind').notNull(),
    name: text('name').notNull(),
    parentListId: uuid('parent_list_id').references((): AnyPgColumn => priceLists.id),
    ...timestamps(),
    archivedAt: archivedAt(),
  },
  (table) => [
    /** One live list per root kind. */
    uniqueIndex('price_lists_root_kind_live_idx')
      .on(table.kind)
      .where(sql`${table.kind} <> 'custom' and ${table.archivedAt} is null`),
    uniqueIndex('price_lists_name_live_idx')
      .on(sql`lower(${table.name})`)
      .where(isNull(table.archivedAt)),
    index('price_lists_parent_list_id_idx').on(table.parentListId),
    check(
      'price_lists_name_check',
      sql`${table.name} = btrim(${table.name}) and char_length(${table.name}) between 2 and 60`,
    ),
    check(
      'price_lists_parent_check',
      sql`(${table.kind} = 'custom') = (${table.parentListId} is not null)`,
    ),
  ],
);
