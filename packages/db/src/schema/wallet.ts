import {
  ADJUSTMENT_CATEGORIES,
  ADJUSTMENT_DIRECTIONS,
  JOURNAL_KINDS,
  LEDGER_ACCOUNT_KINDS,
  MANUAL_DEPOSIT_METHODS,
} from '@vertex-digital/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  type AnyPgColumn,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { customers } from './auth.js';
import { amountUnits, archivedAt, currencyEnum, id, timestamps } from './columns.js';

/*
 * The double-entry ledger (ADR 0003) and the admin's wallet adjustments (S02), owned by the api
 * `wallet` module. Journals and postings are written only by `postJournal` (`src/ledger`).
 * Migrations 0001 and 0007 add what drizzle-kit cannot express: journals, postings and
 * adjustments refuse UPDATE, DELETE and TRUNCATE; every journal balances per currency at commit;
 * an account's kind, currency, code and customer never change; a reversal mirrors its original.
 */

export const ledgerAccountKindEnum = pgEnum('ledger_account_kind', LEDGER_ACCOUNT_KINDS);

export const journalKindEnum = pgEnum('journal_kind', JOURNAL_KINDS);

/**
 * One account per customer wallet (USD only) and per system purpose. `code` names the account for
 * good (`customer_wallet:<customer id>`, `sales_revenue:USD`, `supplier_prepaid:<supplier id>`).
 * A balance is the sum of the account's postings, never a stored number.
 */
export const ledgerAccounts = pgTable(
  'ledger_accounts',
  {
    id: id(),
    code: text('code').notNull().unique(),
    kind: ledgerAccountKindEnum('kind').notNull(),
    currency: currencyEnum('currency').notNull(),
    /** The wallet's customer: set on, and only on, a `customer_wallet` (S02). */
    customerId: uuid('customer_id')
      .unique()
      .references(() => customers.id),
    ...timestamps(),
    archivedAt: archivedAt(),
  },
  (table) => [
    // Target of the postings' (account_id, currency) foreign key: a posting's currency is its account's.
    unique('ledger_accounts_id_currency_unique').on(table.id, table.currency),
    check('ledger_accounts_code_check', sql`char_length(${table.code}) between 1 and 200`),
    check(
      'ledger_accounts_wallet_usd_check',
      sql`${table.kind} <> 'customer_wallet' or ${table.currency} = 'USD'`,
    ),
    check(
      'ledger_accounts_customer_check',
      sql`(${table.customerId} is not null) = (${table.kind} = 'customer_wallet')`,
    ),
  ],
);

/**
 * One money event. The idempotency key (the deposit id, `order:<id>:<step>`, the admin action
 * id) is unique: the same event is never posted twice. `posting_count` is how many postings the
 * journal has; the commit check refuses any other number, so no posting can be added to a journal
 * later. `created_at` is set by the database at insert, whatever the insert says.
 */
export const ledgerJournals = pgTable(
  'ledger_journals',
  {
    id: id(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    kind: journalKindEnum('kind').notNull(),
    postingCount: integer('posting_count').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'ledger_journals_idempotency_key_check',
      sql`char_length(${table.idempotencyKey}) between 1 and 200`,
    ),
    check('ledger_journals_posting_count_check', sql`${table.postingCount} >= 2`),
  ],
);

/** A line of a journal: `amount_units` is added to the account's balance (negative takes from it). */
export const ledgerPostings = pgTable(
  'ledger_postings',
  {
    id: id(),
    journalId: uuid('journal_id')
      .notNull()
      .references(() => ledgerJournals.id),
    accountId: uuid('account_id').notNull(),
    currency: currencyEnum('currency').notNull(),
    amountUnits: amountUnits('amount_units').notNull(),
  },
  (table) => [
    foreignKey({
      name: 'ledger_postings_account_currency_fk',
      columns: [table.accountId, table.currency],
      foreignColumns: [ledgerAccounts.id, ledgerAccounts.currency],
    }),
    index('ledger_postings_journal_id_idx').on(table.journalId),
    index('ledger_postings_account_id_idx').on(table.accountId, table.currency),
    check('ledger_postings_amount_check', sql`${table.amountUnits} <> 0`),
  ],
);

export const adjustmentDirectionEnum = pgEnum('adjustment_direction', ADJUSTMENT_DIRECTIONS);

export const adjustmentCategoryEnum = pgEnum('adjustment_category', ADJUSTMENT_CATEGORIES);

export const manualDepositMethodEnum = pgEnum('manual_deposit_method', MANUAL_DEPOSIT_METHODS);

/**
 * A manual change of a customer's wallet by the admin (S02 rules J1–J10), written once with its
 * journal and audit entry, never changed. A reversal is a second row pointing at the first (rules
 * R1–R3): at most one per original, never of a reversal. Append-only (migration 0007).
 */
export const walletAdjustments = pgTable(
  'wallet_adjustments',
  {
    id: id(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    direction: adjustmentDirectionEnum('direction').notNull(),
    amountUsdUnits: amountUnits('amount_usd_units').notNull(),
    category: adjustmentCategoryEnum('category').notNull(),
    /** Shown to the customer on the timeline. */
    customerNote: text('customer_note'),
    /** Internal; also the audit entry's reason. */
    reason: text('reason').notNull(),
    /** `manual_deposit` only, not on its reversal (rule J8). */
    depositMethod: manualDepositMethodEnum('deposit_method'),
    /** The Sham Cash transaction number or TXID, as entered; unique per method, any case. */
    externalReference: text('external_reference'),
    reversesAdjustmentId: uuid('reverses_adjustment_id')
      .unique()
      .references((): AnyPgColumn => walletAdjustments.id),
    journalId: uuid('journal_id')
      .notNull()
      .unique()
      .references(() => ledgerJournals.id),
    /** The request's `Idempotency-Key` (rule J9). */
    idempotencyKey: uuid('idempotency_key').notNull().unique(),
    /**
     * The admin who made it. No foreign key, as `audit_entries.actor_id`: an append-only row must
     * not pin the admin row (the tests and the CLI replace the single admin).
     */
    adminId: uuid('admin_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('wallet_adjustments_customer_id_idx').on(table.customerId, table.createdAt.desc()),
    index('wallet_adjustments_admin_id_idx').on(table.adminId),
    uniqueIndex('wallet_adjustments_external_reference_unique').on(
      table.depositMethod,
      sql`upper(${table.externalReference})`,
    ),
    check(
      'wallet_adjustments_amount_check',
      sql`${table.amountUsdUnits} > 0 and ${table.amountUsdUnits} % 10000 = 0`,
    ),
    check(
      'wallet_adjustments_reason_check',
      sql`char_length(${table.reason}) between 5 and 500`,
    ),
    check(
      'wallet_adjustments_customer_note_check',
      sql`char_length(${table.customerNote}) between 1 and 200`,
    ),
    check(
      'wallet_adjustments_external_reference_check',
      sql`char_length(${table.externalReference}) between 1 and 100`,
    ),
    check(
      'wallet_adjustments_deposit_method_check',
      sql`(${table.depositMethod} is not null) = (${table.category} = 'manual_deposit' and ${table.reversesAdjustmentId} is null)`,
    ),
    check(
      'wallet_adjustments_external_reference_method_check',
      sql`(${table.externalReference} is not null) = (${table.depositMethod} is not null)`,
    ),
  ],
);
