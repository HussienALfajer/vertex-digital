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
};

/** Tables keyed by a natural value instead of a UUIDv7 `id`. Every entry needs a reason. */
const NATURAL_KEYS: Record<string, string> = {
  worker_heartbeats: 'Keyed by the worker name: one row per process, upserted by the heartbeat',
  usdt_deposits: 'Keyed by its deposit: one row per USDT deposit (S04)',
  usdt_scan_cursors: 'Keyed by the network: one cursor per scanner (S04)',
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
