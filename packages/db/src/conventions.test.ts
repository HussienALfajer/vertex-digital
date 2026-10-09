import { is } from 'drizzle-orm';
import { getTableConfig, PgTable, PgTimestamp } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from './schema/index.js';

/*
 * Guards for the data conventions of ADR 0011 and the money columns of ADR 0003, applied to every
 * table. A failure here means a schema breaks a project rule: fix the schema, or change the ADR.
 */

const tables = (Object.values(schema) as unknown[])
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => getTableConfig(table));

/**
 * Tables that are not business records, so they skip the business columns (archived_at and
 * timestamps). Every entry needs a reason.
 */
const NOT_BUSINESS_RECORDS: Record<string, string> = {
  ledger_journals: 'Append-only ledger (ADR 0003): never updated or archived',
  ledger_postings: 'Append-only ledger (ADR 0003): never updated or archived',
  customer_sessions: 'Better Auth sessions: deleted on sign-out and expiry, not business records',
  customer_accounts: 'Better Auth credentials of a customer, who is the record that is archived',
  customer_verifications: 'Better Auth short-lived codes: deleted once used or expired',
  admin_sessions: 'Better Auth sessions: deleted on sign-out and expiry, not business records',
  admin_accounts: 'Better Auth credentials of the admin, who is the record that is archived',
  admin_verifications: 'Better Auth short-lived values: deleted once used or expired',
  admin_two_factors: 'TOTP secret of the admin, replaced on re-enrolment by the plugin',
  worker_heartbeats: 'One row per worker process, overwritten every minute',
  customer_rate_limits: 'Better Auth and code-send counters: overwritten, pruned when stale',
  audit_entries: 'Append-only audit log (ADR 0011): never updated or archived; occurred_at instead',
  wallet_adjustments:
    'Append-only (S02): corrected by a reversal or a new adjustment, never changed',
  exchange_rates: 'Append-only (S03): a change is a new row, the newest is the current rate',
  payment_references: 'Append-only (S03): a claim is never released or moved',
  deposit_settings: 'Append-only (S03): a save is a new version, the newest is in force',
  deposits: 'Never archived (S03): a deposit ends in a final state, which is its record',
  deposit_receipts: 'Append-only (S03): receipts are evidence, never changed',
  deposit_flags: 'Append-only (S03): a flag is raised once and never cleared',
  stored_files: 'Append-only (S03): a file and its row are never changed or deleted',
  email_outbox: 'A delivery record: its status changes, it is never archived (S01)',
  usdt_deposits: 'Part of its deposit (S04): never archived, keyed by the deposit',
  usdt_transfers: 'Append-only (S04): what the chain showed, never changed',
  usdt_scan_cursors: "A scanner's position (S04): overwritten each run, safe to move back",
  customer_notifications: 'A delivery record (S05 NT1): only read_at changes, never archived',
  notification_preferences: "A customer's email choice (S05 NT8): overwritten, never archived",
  store_switch_changes: 'Append-only (S05): a change is a new row, the newest is the value',
  telegram_links: 'A link history (S05 TG3): ended by unlinked_at, never archived',
  telegram_link_codes: 'Short-lived one-time codes (S05 TG3): used once or expired',
  telegram_messages: 'A delivery record (S05 F07): its status changes, it is never archived',
  telegram_updates: 'Handled Telegram update ids (S05 TG5): pruned after 7 days',
  telegram_prompts: 'The bot question of the moment (S05 TG7): closed, never archived',
  telegram_deposit_cards: 'A sent Telegram message (S05 TC1): edited, never archived',
  telegram_bot_state: 'One row of bot state (S05 RM3), upserted by the reminder',
  suppliers: 'Four seeded rows (S07): never archived, only their threshold changes',
  supplier_credentials: 'Append-only (S07 SP2): a new row replaces the keys, the newest in force',
  supplier_offers: "A mirror of a supplier's catalog (S07 SY4): missing_since, never archived",
  supplier_cost_changes: 'Append-only (S07 SY4): the history of each offer cost',
  supplier_sync_runs: 'A run record (S07 SY1): updated once from running to its end',
  supplier_calls: 'Append-only (S07 H1): every adapter call, which health is computed from',
  supplier_health_changes: 'Append-only (S07 H4): the newest row is the state',
  supplier_balance_reads: 'Append-only (S07 H5): balances as each supplier reported them',
  supplier_policy: 'Append-only (S07): a save is a new version, the newest is in force',
  product_prices: 'Append-only (S07 P2): the newest row per product is its price',
  price_reviews: 'A decision record (S07 P4): closed by its decision, never archived',
  orders: 'Never archived (S08): an order ends in a terminal status, which is its record',
  order_events: 'Append-only (S08 AU1): every change of an order',
  fulfilment_attempts: 'A call record (S08 R3): closed by its result, never archived',
  order_codes: 'Append-only (S08 C1): one encrypted code per delivered unit',
  order_code_reveals: 'Append-only (S08 C2, C3): every reveal of a code',
  order_policy: 'Append-only (S08): a save is a new version, the newest is in force',
  supplier_webhook_events: 'A delivery record (S08 F4): only its processing changes, once',
  player_checks: 'A cache of supplier answers (S09 PV3): expired rows are deleted, never archived',
  checkouts: 'A payment record (S10 CT5): never deleted or archived, only finished once',
  saved_players: 'The customer’s own data (S10 F14): deleted for real, nothing references it',
  order_share_links: 'A link record (S10 SH1): revoked, never deleted or archived',
};

/** Tables keyed by a natural value instead of a UUIDv7 `id`. Every entry needs a reason. */
const NATURAL_KEYS: Record<string, string> = {
  worker_heartbeats: 'Keyed by the worker name: one row per process, upserted by the heartbeat',
  usdt_deposits: 'Keyed by its deposit: one row per USDT deposit (S04)',
  usdt_scan_cursors: 'Keyed by the network: one cursor per scanner (S04)',
  telegram_updates: "Keyed by Telegram's update id: one row per handled update (S05 TG5)",
  telegram_deposit_cards: 'Keyed by deposit and submission: one card per submission (S05 TC1)',
  telegram_bot_state: 'One row, id 1 (S05 RM3)',
};

/**
 * Append-only tables: rows are never updated, archived or deleted. The database enforces it with
 * the `append_only_guard` trigger and revoked privileges (`src/ledger/guards.test.ts`).
 */
const APPEND_ONLY_TABLES = [
  'ledger_journals',
  'ledger_postings',
  'audit_entries',
  'wallet_adjustments',
  'exchange_rates',
  'payment_references',
  'deposit_settings',
  'deposit_receipts',
  'deposit_flags',
  'stored_files',
  'usdt_transfers',
  'store_switch_changes',
  'supplier_credentials',
  'supplier_cost_changes',
  'supplier_calls',
  'supplier_health_changes',
  'supplier_balance_reads',
  'supplier_policy',
  'product_prices',
  'order_events',
  'order_codes',
  'order_code_reveals',
  'order_policy',
];

/** The column of every unique index or constraint that has exactly one column. */
function singleUniqueColumns(table: ReturnType<typeof getTableConfig>): string[] {
  return [
    ...table.columns.filter((column) => column.isUnique).map((column) => column.name),
    ...table.uniqueConstraints
      .filter((constraint) => constraint.columns.length === 1)
      .map((constraint) => constraint.columns[0]?.name),
    ...table.indexes
      .filter((index) => index.config.unique && index.config.columns.length === 1)
      .map((index) => {
        const column = index.config.columns[0];
        return column && 'name' in column ? column.name : undefined;
      }),
  ].filter((name): name is string => name !== undefined);
}

describe('database conventions', () => {
  it('finds the tables it checks', () => {
    expect(tables.map((table) => table.name)).toEqual(
      expect.arrayContaining(['ledger_accounts', 'ledger_journals', 'ledger_postings']),
    );
  });

  it('lists only existing tables as exceptions', () => {
    const names = new Set(tables.map((table) => table.name));
    const stale = [
      ...Object.keys(NOT_BUSINESS_RECORDS),
      ...Object.keys(NATURAL_KEYS),
      ...APPEND_ONLY_TABLES,
    ].filter((name) => !names.has(name));
    expect(stale).toEqual([]);
  });

  it('keys single-column primary keys on a UUID `id`', () => {
    const offenders = tables
      .filter((table) => !(table.name in NATURAL_KEYS) && table.primaryKeys.length === 0)
      .filter((table) => {
        const primary = table.columns.filter((column) => column.primary);
        return (
          primary.length !== 1 || primary[0]?.name !== 'id' || primary[0].columnType !== 'PgUUID'
        );
      })
      .map((table) => table.name);
    expect(offenders).toEqual([]);
  });

  it('gives every business table created_at, updated_at and archived_at', () => {
    const required = ['created_at', 'updated_at', 'archived_at'];
    const offenders = tables
      .filter((table) => !(table.name in NOT_BUSINESS_RECORDS))
      .flatMap((table) =>
        required
          .filter((name) => !table.columns.some((column) => column.name === name))
          .map((name) => `${table.name}.${name}`),
      );
    expect(offenders).toEqual([]);
  });

  it('gives append-only tables no updated_at or archived_at', () => {
    const offenders = tables
      .filter((table) => APPEND_ONLY_TABLES.includes(table.name))
      .flatMap((table) =>
        table.columns
          .filter((column) => ['updated_at', 'archived_at'].includes(column.name))
          .map((column) => `${table.name}.${column.name}`),
      );
    expect(offenders).toEqual([]);
  });

  it('stores every timestamp with a time zone', () => {
    const offenders = tables.flatMap((table) =>
      table.columns
        .filter((column) => is(column, PgTimestamp) && !column.withTimezone)
        .map((column) => `${table.name}.${column.name}`),
    );
    expect(offenders).toEqual([]);
  });

  it('never uses floating-point columns (ADR 0003)', () => {
    const offenders = tables.flatMap((table) =>
      table.columns
        .filter((column) => ['PgReal', 'PgDoublePrecision'].includes(column.columnType))
        .map((column) => `${table.name}.${column.name}`),
    );
    expect(offenders).toEqual([]);
  });

  it('stores every money amount (`*_units`) as a bigint (ADR 0003)', () => {
    const offenders = tables.flatMap((table) =>
      table.columns
        .filter((column) => column.name.endsWith('_units') && column.getSQLType() !== 'bigint')
        .map((column) => `${table.name}.${column.name}`),
    );
    expect(offenders).toEqual([]);
  });

  it('makes every idempotency key unique: the database is the last line against duplicates', () => {
    const offenders = tables.flatMap((table) => {
      const unique = singleUniqueColumns(table);
      return table.columns
        .filter(
          (column) => column.name.endsWith('idempotency_key') && !unique.includes(column.name),
        )
        .map((column) => `${table.name}.${column.name}`);
    });
    expect(offenders).toEqual([]);
  });

  it('indexes every foreign key (PostgreSQL does not do it automatically)', () => {
    const offenders = tables.flatMap((table) => {
      const leading = [
        ...table.indexes.map((index) =>
          index.config.columns.map((column) => ('name' in column ? column.name : '')),
        ),
        ...table.primaryKeys.map((key) => key.columns.map((column) => column.name)),
        ...table.uniqueConstraints.map((constraint) =>
          constraint.columns.map((column) => column.name),
        ),
        ...table.columns
          .filter((column) => column.primary || column.isUnique)
          .map((column) => [column.name]),
      ];
      return table.foreignKeys
        .map((key) => key.reference().columns.map((column) => column.name))
        .filter(
          (columns) => !leading.some((indexed) => columns.every((name, i) => indexed[i] === name)),
        )
        .map((columns) => `${table.name}(${columns.join(', ')})`);
    });
    expect(offenders).toEqual([]);
  });
});
