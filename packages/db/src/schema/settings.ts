import { STORE_SWITCHES, SWITCH_CHANNELS } from '@vertex-digital/contracts';
import { sql } from 'drizzle-orm';
import { boolean, index, pgEnum, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { id } from './columns.js';

/*
 * The store switches (S05 F26, rules SW1–SW8), owned by the api `settings` module. One row per
 * change; a switch's current value is its newest row, or its default (`STORE_SWITCH_DEFAULTS`).
 * Append-only (migration 0019).
 */

export const storeSwitchEnum = pgEnum('store_switch', STORE_SWITCHES);

export const switchChannelEnum = pgEnum('switch_channel', SWITCH_CHANNELS);

export const storeSwitchChanges = pgTable(
  'store_switch_changes',
  {
    id: id(),
    switch: storeSwitchEnum('switch').notNull(),
    value: boolean('value').notNull(),
    /** The admin who changed it; no foreign key, as `deposit_settings.admin_id`. */
    adminId: uuid('admin_id').notNull(),
    channel: switchChannelEnum('channel').notNull(),
    /**
     * The time of the insert, not of its transaction's start: the change takes the switches lock
     * first (rule SW2), so a later row always has a later time even when its transaction began
     * earlier.
     */
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    index('store_switch_changes_switch_created_at_idx').on(table.switch, table.createdAt.desc()),
    index('store_switch_changes_created_at_idx').on(table.createdAt.desc()),
  ],
);
