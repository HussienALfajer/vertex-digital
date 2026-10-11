import { OUTSIDE_CATEGORIES, TREASURY_MOVEMENT_KINDS } from '@vertex-digital/contracts';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  foreignKey,
  index,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { amountUnits, currencyEnum, id } from './columns.js';
import { orders } from './orders.js';
import { ledgerAccounts, ledgerJournals } from './wallet.js';

/*
 * Treasury movements (S13 rules T1–T10, M1–M5, ADR 0027), owned by the api `treasury` module:
 * money moving between the store's places and the outside, and supplier balance corrections.
 * Migration 0045 adds what drizzle-kit cannot express: the rows are append-only, and an
 * `outside_category` is set exactly when one side is an `outside_funds` account.
 */

export const treasuryMovementKindEnum = pgEnum('treasury_movement_kind', TREASURY_MOVEMENT_KINDS);

export const outsideCategoryEnum = pgEnum('outside_category', OUTSIDE_CATEGORIES);

/**
 * One movement and its `treasury` journal, written once with its audit entry. Money flows from
 * `from_account_id` (which gets +sent) to `to_account_id` (−received); each amount is in its
 * account's currency (the composite foreign keys). A reversal is a second row pointing at the
 * first, with the same accounts and amounts and mirrored postings (rule M4): at most one.
 */
export const treasuryMovements = pgTable(
  'treasury_movements',
  {
    id: id(),
    kind: treasuryMovementKindEnum('kind').notNull(),
    fromAccountId: uuid('from_account_id').notNull(),
    sentUnits: amountUnits('sent_units').notNull(),
    sentCurrency: currencyEnum('sent_currency').notNull(),
    toAccountId: uuid('to_account_id').notNull(),
    receivedUnits: amountUnits('received_units').notNull(),
    receivedCurrency: currencyEnum('received_currency').notNull(),
    /** SYP per USD implied when the currencies differ (rule M2), 4 decimals; null otherwise. */
    rate: numeric('rate', { precision: 16, scale: 4 }),
    outsideCategory: outsideCategoryEnum('outside_category'),
    openingBalance: boolean('opening_balance').notNull().default(false),
    /** A supplier correction's order, when it concerns one (rule T5). */
    orderId: uuid('order_id').references(() => orders.id),
    /** The outgoing TXID, Sham Cash transaction number or supplier receipt (rule T8). */
    externalReference: text('external_reference'),
    /** Also the audit entry's reason. */
    reason: text('reason').notNull(),
    reversesMovementId: uuid('reverses_movement_id')
      .unique()
      .references((): AnyPgColumn => treasuryMovements.id),
    journalId: uuid('journal_id')
      .notNull()
      .unique()
      .references(() => ledgerJournals.id),
    /** The request's `Idempotency-Key` (rule T7). */
    idempotencyKey: uuid('idempotency_key').notNull().unique(),
    /** No foreign key, as `wallet_adjustments.admin_id`. */
    adminId: uuid('admin_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'treasury_movements_from_account_fk',
      columns: [table.fromAccountId, table.sentCurrency],
      foreignColumns: [ledgerAccounts.id, ledgerAccounts.currency],
    }),
    foreignKey({
      name: 'treasury_movements_to_account_fk',
      columns: [table.toAccountId, table.receivedCurrency],
      foreignColumns: [ledgerAccounts.id, ledgerAccounts.currency],
    }),
    index('treasury_movements_created_at_idx').on(table.createdAt.desc()),
    index('treasury_movements_from_account_id_idx').on(table.fromAccountId, table.sentCurrency),
    index('treasury_movements_to_account_id_idx').on(table.toAccountId, table.receivedCurrency),
    index('treasury_movements_order_id_idx').on(table.orderId),
    index('treasury_movements_admin_id_idx').on(table.adminId),
    /** Rule T8: one booking of an outgoing reference per source place, any case. */
    uniqueIndex('treasury_movements_external_reference_unique')
      .on(table.fromAccountId, sql`upper(${table.externalReference})`)
      .where(sql`${table.externalReference} is not null and ${table.reversesMovementId} is null`),
    check('treasury_movements_accounts_check', sql`${table.fromAccountId} <> ${table.toAccountId}`),
    check(
      'treasury_movements_amounts_check',
      sql`${table.sentUnits} > 0 and ${table.receivedUnits} > 0`,
    ),
    check(
      'treasury_movements_rate_check',
      sql`(${table.rate} is null) = (${table.sentCurrency} = ${table.receivedCurrency})`,
    ),
    check(
      'treasury_movements_same_currency_check',
      sql`${table.sentCurrency} <> ${table.receivedCurrency} or ${table.receivedUnits} <= ${table.sentUnits}`,
    ),
    check(
      'treasury_movements_correction_check',
      sql`${table.kind} = 'transfer' or (${table.sentUnits} = ${table.receivedUnits} and ${table.sentCurrency} = 'USD' and ${table.receivedCurrency} = 'USD' and not ${table.openingBalance})`,
    ),
    check(
      'treasury_movements_order_check',
      sql`${table.orderId} is null or ${table.kind} = 'supplier_correction'`,
    ),
    check(
      'treasury_movements_opening_check',
      sql`not ${table.openingBalance} or (${table.outsideCategory} = 'owner' and ${table.reversesMovementId} is null)`,
    ),
    check('treasury_movements_reason_check', sql`char_length(${table.reason}) between 5 and 500`),
    check(
      'treasury_movements_external_reference_check',
      sql`char_length(${table.externalReference}) between 1 and 100`,
    ),
  ],
);
