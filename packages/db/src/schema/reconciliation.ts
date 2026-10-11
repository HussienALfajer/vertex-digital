import {
  RECONCILIATION_CHECKS,
  RECONCILIATION_RESULT_STATUSES,
  RECONCILIATION_RUN_STATUSES,
  RECONCILIATION_RUN_TRIGGERS,
} from '@vertex-digital/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { amountUnits, currencyEnum, id, timestamps } from './columns.js';

/*
 * The nightly reconciliation (S13 rules RN1–RN9, C1–C9, E1–E6, ADR 0027), owned by the api
 * `reconciliation` module and written by the worker's jobs. Results and explanations are
 * append-only (migration 0045); a run changes only until it finishes or fails.
 */

export const reconciliationRunTriggerEnum = pgEnum(
  'reconciliation_run_trigger',
  RECONCILIATION_RUN_TRIGGERS,
);

export const reconciliationRunStatusEnum = pgEnum(
  'reconciliation_run_status',
  RECONCILIATION_RUN_STATUSES,
);

export const reconciliationCheckEnum = pgEnum('reconciliation_check', RECONCILIATION_CHECKS);

export const reconciliationResultStatusEnum = pgEnum(
  'reconciliation_result_status',
  RECONCILIATION_RESULT_STATUSES,
);

const insertedAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`);

/** One run: nightly (one per Damascus day), manual or a Sham Cash count (rules RN1, RN2, RN6). */
export const reconciliationRuns = pgTable(
  'reconciliation_runs',
  {
    id: id(),
    trigger: reconciliationRunTriggerEnum('trigger').notNull(),
    /** The `Asia/Damascus` day a nightly run covers; set exactly for `schedule`. */
    businessDate: date('business_date', { mode: 'string' }),
    status: reconciliationRunStatusEnum('status').notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** The highest `ledger_postings.position` the internal checks saw (rule RN3). */
    snapshotPosition: bigint('snapshot_position', { mode: 'number' }),
    mismatchCount: integer('mismatch_count').notNull().default(0),
    warningCount: integer('warning_count').notNull().default(0),
    /** When the external recheck is due (rule RN4). */
    recheckAt: timestamp('recheck_at', { withTimezone: true }),
    /** The error's class and message, never secrets or personal data (rule RN5). */
    failure: text('failure'),
    /** The admin who started a `manual` or `count` run; no foreign key. */
    adminId: uuid('admin_id'),
    /** When its Telegram alert was queued (rule NT1). */
    alertedAt: timestamp('alerted_at', { withTimezone: true }),
    /** A count's `Idempotency-Key` (rule RN6); set exactly for `count`. */
    idempotencyKey: uuid('idempotency_key').unique(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('reconciliation_runs_business_date_unique')
      .on(table.businessDate)
      .where(sql`${table.businessDate} is not null`),
    /** One running run at a time (rules RN2, RN6). */
    uniqueIndex('reconciliation_runs_running_idx')
      .on(table.status)
      .where(sql`${table.status} = 'running'`),
    index('reconciliation_runs_trigger_started_at_idx').on(table.trigger, table.startedAt.desc()),
    index('reconciliation_runs_started_at_idx').on(table.startedAt.desc()),
    index('reconciliation_runs_admin_id_idx').on(table.adminId),
    check(
      'reconciliation_runs_business_date_check',
      sql`(${table.businessDate} is not null) = (${table.trigger} = 'schedule')`,
    ),
    check(
      'reconciliation_runs_admin_check',
      sql`(${table.adminId} is not null) = (${table.trigger} <> 'schedule')`,
    ),
    check(
      'reconciliation_runs_idempotency_key_check',
      sql`(${table.idempotencyKey} is not null) = (${table.trigger} = 'count')`,
    ),
    check(
      'reconciliation_runs_finished_check',
      sql`(${table.status} = 'running') = (${table.finishedAt} is null)`,
    ),
    check(
      'reconciliation_runs_counts_check',
      sql`${table.mismatchCount} >= 0 and ${table.warningCount} >= 0`,
    ),
    check('reconciliation_runs_failure_check', sql`char_length(${table.failure}) <= 500`),
  ],
);

/** One check's result in a run (S13 data). Append-only. */
export const reconciliationResults = pgTable(
  'reconciliation_results',
  {
    id: id(),
    runId: uuid('run_id')
      .notNull()
      .references(() => reconciliationRuns.id),
    check: reconciliationCheckEnum('check').notNull(),
    /** `ledger`, an account code, `supplier:<code>`, `usdt_trc20`, `sham_cash_syp` … */
    subject: text('subject').notNull(),
    status: reconciliationResultStatusEnum('status').notNull(),
    currency: currencyEnum('currency'),
    booksUnits: amountUnits('books_units'),
    actualUnits: amountUnits('actual_units'),
    differenceUnits: amountUnits('difference_units'),
    allowedLowUnits: amountUnits('allowed_low_units'),
    allowedHighUnits: amountUnits('allowed_high_units'),
    offendingCount: integer('offending_count').notNull().default(0),
    /** `ReconciliationDetails` of the contracts: ids and lines, never personal data. */
    details: jsonb('details').notNull(),
    createdAt: insertedAt(),
  },
  (table) => [
    unique('reconciliation_results_run_check_subject_unique').on(
      table.runId,
      table.check,
      table.subject,
    ),
    index('reconciliation_results_check_subject_idx').on(
      table.check,
      table.subject,
      table.createdAt.desc(),
    ),
    check(
      'reconciliation_results_subject_check',
      sql`char_length(${table.subject}) between 1 and 100`,
    ),
    check('reconciliation_results_offending_check', sql`${table.offendingCount} >= 0`),
    check(
      'reconciliation_results_range_check',
      sql`${table.allowedLowUnits} is null or ${table.allowedHighUnits} is null or ${table.allowedLowUnits} <= ${table.allowedHighUnits}`,
    ),
  ],
);

/** The admin's note on a mismatch (rule RN8): one per result. Append-only. */
export const reconciliationExplanations = pgTable(
  'reconciliation_explanations',
  {
    id: id(),
    resultId: uuid('result_id')
      .notNull()
      .unique()
      .references(() => reconciliationResults.id),
    note: text('note').notNull(),
    /** No foreign key, as `wallet_adjustments.admin_id`. */
    adminId: uuid('admin_id').notNull(),
    createdAt: insertedAt(),
  },
  (table) => [
    index('reconciliation_explanations_admin_id_idx').on(table.adminId),
    check(
      'reconciliation_explanations_note_check',
      sql`char_length(${table.note}) between 5 and 500`,
    ),
  ],
);

/** The settings (rules E1, E5): the newest row is in force; seeded with the defaults. */
export const reconciliationSettings = pgTable(
  'reconciliation_settings',
  {
    id: id(),
    toleranceUsdUnits: amountUnits('tolerance_usd_units').notNull(),
    countStaleDays: integer('count_stale_days').notNull(),
    /** Null for the seed. */
    adminId: uuid('admin_id'),
    createdAt: insertedAt(),
  },
  (table) => [
    index('reconciliation_settings_created_at_idx').on(table.createdAt.desc()),
    index('reconciliation_settings_admin_id_idx').on(table.adminId),
    check(
      'reconciliation_settings_bounds_check',
      sql`${table.toleranceUsdUnits} between 0 and 100000000
        and ${table.toleranceUsdUnits} % 10000 = 0
        and ${table.countStaleDays} between 1 and 60`,
    ),
  ],
);
