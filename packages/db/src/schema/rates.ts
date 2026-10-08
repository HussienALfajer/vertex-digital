import { sql } from 'drizzle-orm';
import { bigint, check, index, numeric, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { id } from './columns.js';

/*
 * The admin's USD→SYP exchange rate (S03 rules FX1–FX9, ADR 0003), owned by the api `rates`
 * module. Every change of the rate or the display step is a new row; the current rate is the
 * newest. Append-only (migration 0010).
 */

export const exchangeRates = pgTable(
  'exchange_rates',
  {
    id: id(),
    /** New Syrian pounds per 1 USD, up to 4 decimals (`exchangeRateSchema`). */
    sypPerUsd: numeric('syp_per_usd', { precision: 12, scale: 4 }).notNull(),
    /** The step SYP displays round to, in SYP units: whole pounds, 1 to 50 (rule FX3). */
    displayStepSypUnits: bigint('display_step_syp_units', { mode: 'number' }).notNull(),
    /** The admin who saved it; no foreign key, as `wallet_adjustments.admin_id`. */
    adminId: uuid('admin_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('exchange_rates_created_at_idx').on(table.createdAt.desc()),
    check('exchange_rates_rate_check', sql`${table.sypPerUsd} > 0`),
    check(
      'exchange_rates_display_step_check',
      sql`${table.displayStepSypUnits} between 100 and 5000 and ${table.displayStepSypUnits} % 100 = 0`,
    ),
  ],
);
