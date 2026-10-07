import { JOURNAL_KINDS, LEDGER_ACCOUNT_KINDS } from '@vertex-digital/contracts';
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
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { amountUnits, archivedAt, currencyEnum, id, timestamps } from './columns.js';

/*
 * The double-entry ledger (ADR 0003), owned by the api `wallet` module. Journals and postings are
 * written only by `postJournal` (`src/ledger`). Migration 0001 adds what drizzle-kit cannot
 * express: journals and postings refuse UPDATE, DELETE and TRUNCATE; every journal balances per
 * currency at commit; an account's kind, currency and code never change.
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
