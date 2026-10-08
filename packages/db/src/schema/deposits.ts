import {
  DEPOSIT_FLAG_CODES,
  DEPOSIT_METHODS,
  DEPOSIT_REFERENCE_CHECKS,
  DEPOSIT_REJECT_REASONS,
  DEPOSIT_STATUSES,
} from '@vertex-digital/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { customers } from './auth.js';
import { amountUnits, currencyEnum, id, timestamps } from './columns.js';
import { storedFiles } from './files.js';
import { exchangeRates } from './rates.js';
import { ledgerJournals } from './wallet.js';

/*
 * Deposits (S03, F05; ADR 0006, 0017), owned by the api `deposits` module: the settings' versions,
 * the deposits, their receipts and their fraud flags. Settings, receipts and flags are
 * append-only; a deposit changes only along the transition table and never leaves a final state
 * (migration 0012).
 */

export const depositMethodEnum = pgEnum('deposit_method', DEPOSIT_METHODS);

export const depositStatusEnum = pgEnum('deposit_status', DEPOSIT_STATUSES);

export const depositReferenceCheckEnum = pgEnum(
  'deposit_reference_check',
  DEPOSIT_REFERENCE_CHECKS,
);

export const depositRejectReasonEnum = pgEnum('deposit_reject_reason', DEPOSIT_REJECT_REASONS);

export const depositFlagCodeEnum = pgEnum('deposit_flag_code', DEPOSIT_FLAG_CODES);

/** USD units of a limit or threshold: whole cents above zero. */
const isLimit = (column: unknown) => sql`${column} > 0 and ${column} % 10000 = 0`;

/**
 * One saved version of the Sham Cash deposit settings; the newest row is in force. Before the
 * first save, Sham Cash deposits are unavailable (rule SC1).
 */
export const depositSettings = pgTable(
  'deposit_settings',
  {
    id: id(),
    shamCashAccountName: text('sham_cash_account_name').notNull(),
    shamCashAccountNumber: text('sham_cash_account_number').notNull(),
    sypEnabled: boolean('syp_enabled').notNull(),
    usdEnabled: boolean('usd_enabled').notNull(),
    sypQrFileId: uuid('syp_qr_file_id').references(() => storedFiles.id),
    usdQrFileId: uuid('usd_qr_file_id').references(() => storedFiles.id),
    minDepositUsdUnits: amountUnits('min_deposit_usd_units').notNull(),
    newAccountPerDepositUsdUnits: amountUnits('new_account_per_deposit_usd_units').notNull(),
    newAccountDailyUsdUnits: amountUnits('new_account_daily_usd_units').notNull(),
    establishedPerDepositUsdUnits: amountUnits('established_per_deposit_usd_units').notNull(),
    establishedDailyUsdUnits: amountUnits('established_daily_usd_units').notNull(),
    /** In `Asia/Damascus` (rule SC13). */
    reviewHoursStart: time('review_hours_start').notNull(),
    reviewHoursEnd: time('review_hours_end').notNull(),
    reviewTargetMinutes: integer('review_target_minutes').notNull(),
    flagNewAccountUsdUnits: amountUnits('flag_new_account_usd_units').notNull(),
    flagVelocityCount: integer('flag_velocity_count').notNull(),
    /** The admin who saved it; no foreign key, as `wallet_adjustments.admin_id`. */
    adminId: uuid('admin_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('deposit_settings_created_at_idx').on(table.createdAt.desc()),
    index('deposit_settings_syp_qr_file_id_idx').on(table.sypQrFileId),
    index('deposit_settings_usd_qr_file_id_idx').on(table.usdQrFileId),
    check(
      'deposit_settings_account_check',
      sql`char_length(${table.shamCashAccountName}) between 1 and 100 and char_length(${table.shamCashAccountNumber}) between 1 and 64`,
    ),
    check(
      'deposit_settings_qr_check',
      sql`(not ${table.sypEnabled} or ${table.sypQrFileId} is not null) and (not ${table.usdEnabled} or ${table.usdQrFileId} is not null)`,
    ),
    check(
      'deposit_settings_limits_check',
      sql`${isLimit(table.minDepositUsdUnits)} and ${isLimit(table.newAccountPerDepositUsdUnits)}
        and ${isLimit(table.newAccountDailyUsdUnits)} and ${isLimit(table.establishedPerDepositUsdUnits)}
        and ${isLimit(table.establishedDailyUsdUnits)} and ${isLimit(table.flagNewAccountUsdUnits)}
        and ${table.minDepositUsdUnits} <= ${table.newAccountPerDepositUsdUnits}
        and ${table.newAccountPerDepositUsdUnits} <= ${table.newAccountDailyUsdUnits}
        and ${table.minDepositUsdUnits} <= ${table.establishedPerDepositUsdUnits}
        and ${table.establishedPerDepositUsdUnits} <= ${table.establishedDailyUsdUnits}`,
    ),
    check(
      'deposit_settings_hours_check',
      sql`${table.reviewHoursStart} < ${table.reviewHoursEnd} and ${table.reviewTargetMinutes} between 1 and 1440`,
    ),
    check('deposit_settings_velocity_check', sql`${table.flagVelocityCount} between 1 and 50`),
  ],
);

/**
 * A customer's deposit (rules SC1–SC14, RV1–RV10). Never deleted or archived: the trigger of
 * migration 0012 refuses a change out of a final state, a move the transition table does not
 * allow, and a change of what the customer declared or of a decision once set.
 */
export const deposits = pgTable(
  'deposits',
  {
    id: id(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    method: depositMethodEnum('method').notNull(),
    status: depositStatusEnum('status').notNull().default('pending'),
    /** `VD-` and 5 characters of `REFERENCE_CODE_ALPHABET`, for the transfer note. */
    referenceCode: text('reference_code').notNull().unique(),
    /** What the customer sends. */
    currency: currencyEnum('currency').notNull(),
    /** In `currency` units: whole pounds or whole cents. */
    declaredAmountUnits: amountUnits('declared_amount_units').notNull(),
    /** The USD the customer expects (rule FX6); recomputed by a requote while unfixed. */
    declaredUsdUnits: amountUnits('declared_usd_units').notNull(),
    /** The quote (SYP only, rule FX5). */
    rateId: uuid('rate_id').references(() => exchangeRates.id),
    rate: numeric('rate', { precision: 12, scale: 4 }),
    quoteExpiresAt: timestamp('quote_expires_at', { withTimezone: true }),
    /** Set at the first submission within a valid quote; the rate never changes after (SC9). */
    rateFixedAt: timestamp('rate_fixed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    receiptRequestedAt: timestamp('receipt_requested_at', { withTimezone: true }),
    receiptRequestCount: smallint('receipt_request_count').notNull().default(0),
    /** The clearer-receipt request's note to the customer (rule RV8). */
    receiptRequestNote: text('receipt_request_note'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    /** The decision, set once when credited (rules RV1–RV3). */
    transactionNumber: text('transaction_number'),
    receivedCurrency: currencyEnum('received_currency'),
    receivedAmountUnits: amountUnits('received_amount_units'),
    creditedUsdUnits: amountUnits('credited_usd_units'),
    creditRateId: uuid('credit_rate_id').references(() => exchangeRates.id),
    creditRate: numeric('credit_rate', { precision: 12, scale: 4 }),
    referenceCheck: depositReferenceCheckEnum('reference_check'),
    journalId: uuid('journal_id')
      .unique()
      .references(() => ledgerJournals.id),
    /** The rejection, set once when rejected (rule RV6). */
    rejectReason: depositRejectReasonEnum('reject_reason'),
    customerNote: text('customer_note'),
    /** The create request's `Idempotency-Key` (rule SC2); unique across customers. */
    idempotencyKey: uuid('idempotency_key').notNull().unique(),
    /** The approval's or rejection's `Idempotency-Key` (rule RV9). */
    decisionIdempotencyKey: uuid('decision_idempotency_key').unique(),
    /** Who decided; no foreign key, as `wallet_adjustments.admin_id`. */
    adminId: uuid('admin_id'),
    ...timestamps(),
  },
  (table) => [
    index('deposits_customer_id_idx').on(table.customerId, table.createdAt.desc()),
    // One deposit awaiting a receipt per customer (rule SC4).
    uniqueIndex('deposits_one_pending_unique')
      .on(table.customerId)
      .where(sql`${table.status} = 'pending'`),
    index('deposits_queue_idx').on(table.status, table.submittedAt),
    index('deposits_expiry_idx').on(table.status, table.expiresAt),
    index('deposits_rate_id_idx').on(table.rateId),
    index('deposits_credit_rate_id_idx').on(table.creditRateId),
    index('deposits_admin_id_idx').on(table.adminId),
    check(
      'deposits_reference_code_check',
      sql`${table.referenceCode} ~ '^VD-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$'`,
    ),
    check(
      'deposits_declared_check',
      sql`${table.declaredAmountUnits} > 0
        and ${table.declaredAmountUnits} % (case ${table.currency} when 'SYP' then 100 else 10000 end) = 0
        and ${table.declaredUsdUnits} >= 0 and ${table.declaredUsdUnits} % 10000 = 0`,
    ),
    check(
      'deposits_quote_check',
      sql`num_nonnulls(${table.rateId}, ${table.rate}, ${table.quoteExpiresAt}) = case ${table.currency} when 'SYP' then 3 else 0 end
        and (${table.rate} is null or ${table.rate} > 0)
        and (${table.rateFixedAt} is null or ${table.currency} = 'SYP')`,
    ),
    check(
      'deposits_receipt_request_check',
      sql`${table.receiptRequestCount} between 0 and 1
        and (${table.receiptRequestedAt} is not null) = (${table.receiptRequestCount} = 1)
        and (${table.receiptRequestNote} is null or (${table.receiptRequestedAt} is not null and char_length(${table.receiptRequestNote}) between 1 and 300))`,
    ),
    check(
      'deposits_submitted_check',
      sql`${table.status} not in ('submitted', 'credited', 'rejected') or ${table.submittedAt} is not null`,
    ),
    check(
      'deposits_decided_check',
      sql`(${table.status} in ('credited', 'rejected')) = (${table.decidedAt} is not null)
        and (${table.status} in ('credited', 'rejected')) = (${table.adminId} is not null)
        and (${table.status} in ('credited', 'rejected')) = (${table.decisionIdempotencyKey} is not null)`,
    ),
    check(
      'deposits_credit_check',
      sql`num_nonnulls(${table.transactionNumber}, ${table.receivedCurrency}, ${table.receivedAmountUnits}, ${table.creditedUsdUnits}, ${table.referenceCheck}, ${table.journalId})
          = case when ${table.status} = 'credited' then 6 else 0 end
        and num_nonnulls(${table.creditRateId}, ${table.creditRate})
          = case when ${table.status} = 'credited' and ${table.receivedCurrency} = 'SYP' then 2 else 0 end
        and (${table.transactionNumber} is null or char_length(${table.transactionNumber}) between 1 and 64)
        and (${table.receivedAmountUnits} is null or ${table.receivedAmountUnits} > 0)
        and (${table.creditedUsdUnits} is null or (${table.creditedUsdUnits} > 0 and ${table.creditedUsdUnits} % 10000 = 0))`,
    ),
    check(
      'deposits_rejection_check',
      sql`(${table.rejectReason} is not null) = (${table.status} = 'rejected')
        and (${table.customerNote} is null or (${table.status} = 'rejected' and char_length(${table.customerNote}) between 1 and 300))
        and (${table.rejectReason} <> 'other' or ${table.customerNote} is not null)`,
    ),
  ],
);

/** SHA-256 digests: PostgreSQL `bytea`, a Node `Buffer`. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/**
 * A receipt image of a deposit: one, or two after a clearer-receipt request; the newest is the
 * current one. The hashes find reused and similar receipts (rules FL1, FL2). Append-only.
 */
export const depositReceipts = pgTable(
  'deposit_receipts',
  {
    id: id(),
    depositId: uuid('deposit_id')
      .notNull()
      .references(() => deposits.id),
    fileId: uuid('file_id')
      .notNull()
      .unique()
      .references(() => storedFiles.id),
    /** SHA-256 of the uploaded bytes, before re-encoding. Reuse is a flag, not a refusal. */
    originalSha256: bytea('original_sha256').notNull(),
    /** The 64-bit dHash of the decoded image, signed (`dHash` in the contracts). */
    perceptualHash: bigint('perceptual_hash', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('deposit_receipts_deposit_id_idx').on(table.depositId, table.createdAt),
    index('deposit_receipts_original_sha256_idx').on(table.originalSha256),
    check('deposit_receipts_sha256_check', sql`octet_length(${table.originalSha256}) = 32`),
  ],
);

/**
 * A fraud flag (A10, rules FL1–FL6): information for the admin, never shown to the customer.
 * Raised once per receipt (`receipt_id`), or once at approval (no receipt). Append-only.
 */
export const depositFlags = pgTable(
  'deposit_flags',
  {
    id: id(),
    depositId: uuid('deposit_id')
      .notNull()
      .references(() => deposits.id),
    code: depositFlagCodeEnum('code').notNull(),
    receiptId: uuid('receipt_id').references(() => depositReceipts.id),
    /** Checked against `DEPOSIT_FLAG_DETAILS` before it is written. */
    details: jsonb('details').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('deposit_flags_once_unique')
      .on(table.depositId, table.code, table.receiptId)
      .nullsNotDistinct(),
    index('deposit_flags_receipt_id_idx').on(table.receiptId),
  ],
);
