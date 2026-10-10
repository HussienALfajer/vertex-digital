import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { customers } from './auth.js';
import { amountUnits, archivedAt, id, timestamps } from './columns.js';

/*
 * Customer administration (S12 F19), owned by the api `customers` module: per-customer limit
 * overrides and the admin's notes. The customer rows themselves belong to the `auth` module.
 */

/** A set override: positive whole cents up to $100,000. */
const limitCheck = (column: unknown) =>
  sql`${column} is null or (${column} > 0 and ${column} % 10000 = 0 and ${column} <= 100000000000)`;

/**
 * S12 LM1–LM5: a null column is the store default (the S03 tier, or no purchase cap); a missing row
 * is all null. Upserted with its audit entry (before and after).
 */
export const customerLimits = pgTable(
  'customer_limits',
  {
    customerId: uuid('customer_id')
      .primaryKey()
      .references(() => customers.id),
    perDepositUsdUnits: amountUnits('per_deposit_usd_units'),
    dailyDepositUsdUnits: amountUnits('daily_deposit_usd_units'),
    dailyPurchaseUsdUnits: amountUnits('daily_purchase_usd_units'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    check('customer_limits_per_deposit_check', limitCheck(table.perDepositUsdUnits)),
    check('customer_limits_daily_deposit_check', limitCheck(table.dailyDepositUsdUnits)),
    check('customer_limits_daily_purchase_check', limitCheck(table.dailyPurchaseUsdUnits)),
    check(
      'customer_limits_per_deposit_within_daily_check',
      sql`${table.perDepositUsdUnits} is null or ${table.dailyDepositUsdUnits} is null or ${table.perDepositUsdUnits} <= ${table.dailyDepositUsdUnits}`,
    ),
  ],
);

/**
 * S12 SN2: the admin's notes, never shown to the customer. At most one pinned, unarchived note per
 * customer; the body and the customer never change (`customer_notes_guard`, migration 0043); no
 * delete (archive, don't delete).
 */
export const customerNotes = pgTable(
  'customer_notes',
  {
    id: id(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    body: text('body').notNull(),
    pinned: boolean('pinned').notNull().default(false),
    ...timestamps(),
    archivedAt: archivedAt(),
  },
  (table) => [
    index('customer_notes_customer_idx').on(table.customerId, table.createdAt.desc()),
    uniqueIndex('customer_notes_one_pinned_idx')
      .on(table.customerId)
      .where(sql`${table.pinned} and ${table.archivedAt} is null`),
    check('customer_notes_body_check', sql`char_length(${table.body}) between 1 and 2000`),
  ],
);
