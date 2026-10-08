import {
  DEPOSIT_DECIDERS,
  DEPOSIT_FLAG_CODES,
  DEPOSIT_METHODS,
  DEPOSIT_REFERENCE_CHECKS,
  DEPOSIT_REJECT_REASONS,
  DEPOSIT_STATUSES,
  USDT_CHECK_ERRORS,
  USDT_CHECK_STATUSES,
  USDT_TRANSFER_SOURCES,
  USDT_TXID_SOURCES,
} from '@vertex-digital/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
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
import { amountUnits, bytea, currencyEnum, id, timestamps } from './columns.js';
import { storedFiles } from './files.js';
import { exchangeRates } from './rates.js';
import { ledgerJournals, paymentMethodEnum } from './wallet.js';

/*
 * Deposits (S03, F05; S04, F06; ADR 0006, 0017, 0018), owned by the api `deposits` module: the
 * settings' versions, the deposits, their receipts and their fraud flags; S04 adds each USDT
 * deposit's payment and check, the USDT transfers seen on chain and the scanners' cursors.
 * Settings, receipts, flags and transfers are append-only; a deposit changes only along the
 * transition table and never leaves a final state (migrations 0012 and 0014).
 */

export const depositMethodEnum = pgEnum('deposit_method', DEPOSIT_METHODS);

export const depositStatusEnum = pgEnum('deposit_status', DEPOSIT_STATUSES);

export const depositReferenceCheckEnum = pgEnum(
  'deposit_reference_check',
  DEPOSIT_REFERENCE_CHECKS,
);

export const depositRejectReasonEnum = pgEnum('deposit_reject_reason', DEPOSIT_REJECT_REASONS);

export const depositFlagCodeEnum = pgEnum('deposit_flag_code', DEPOSIT_FLAG_CODES);

export const depositDeciderEnum = pgEnum('deposit_decider', DEPOSIT_DECIDERS);

export const usdtCheckStatusEnum = pgEnum('usdt_check_status', USDT_CHECK_STATUSES);

export const usdtCheckErrorEnum = pgEnum('usdt_check_error', USDT_CHECK_ERRORS);

export const usdtTxidSourceEnum = pgEnum('usdt_txid_source', USDT_TXID_SOURCES);

export const usdtTransferSourceEnum = pgEnum('usdt_transfer_source', USDT_TRANSFER_SOURCES);

/** The USDT methods of `payment_method` (S04). */
const isUsdtMethod = (column: unknown) => sql`${column} in ('usdt_trc20', 'usdt_bep20')`;

/** A normalized TXID: 64 lower-case hex characters, no `0x` (contracts `txidSchema`). */
const isTxid = (column: unknown) => sql`${column} ~ '^[0-9a-f]{64}$'`;

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
    /** S04: older versions read as disabled, with the $5 minimum (rule U1, U5). */
    usdtTrc20Enabled: boolean('usdt_trc20_enabled').notNull().default(false),
    usdtBep20Enabled: boolean('usdt_bep20_enabled').notNull().default(false),
    /** Kept within both per-deposit limits by the contract (`depositSettingsInputSchema`). */
    usdtMinDepositUsdUnits: amountUnits('usdt_min_deposit_usd_units').notNull().default(5_000_000),
    /** S05 rule TC4: the largest credit approved from Telegram; 0 turns it off; at most $100. */
    telegramApprovalMaxUsdUnits: amountUnits('telegram_approval_max_usd_units')
      .notNull()
      .default(100_000_000),
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
    check('deposit_settings_usdt_min_check', isLimit(table.usdtMinDepositUsdUnits)),
    check(
      'deposit_settings_telegram_approval_check',
      sql`${table.telegramApprovalMaxUsdUnits} between 0 and 100000000 and ${table.telegramApprovalMaxUsdUnits} % 10000 = 0`,
    ),
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
    /** The admin, or the worker on an exact USDT match (S04 rule U7); set with the decision. */
    decidedBy: depositDeciderEnum('decided_by'),
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
    // A USDT deposit is declared and credited in dollars (S04).
    check('deposits_method_check', sql`${table.method} = 'sham_cash' or ${table.currency} = 'USD'`),
    // Decided by the admin (with its decision key) or by the worker (S04 rule U7).
    check(
      'deposits_decided_check',
      sql`(${table.status} in ('credited', 'rejected')) = (${table.decidedAt} is not null)
        and (${table.status} in ('credited', 'rejected')) = (${table.decidedBy} is not null)
        and coalesce(${table.decidedBy} = 'admin', false) = (${table.adminId} is not null)
        and coalesce(${table.decidedBy} = 'admin', false) = (${table.decisionIdempotencyKey} is not null)`,
    ),
    check(
      'deposits_credit_check',
      sql`num_nonnulls(${table.transactionNumber}, ${table.receivedCurrency}, ${table.receivedAmountUnits}, ${table.creditedUsdUnits}, ${table.journalId})
          = case when ${table.status} = 'credited' then 5 else 0 end
        and (${table.referenceCheck} is not null) = (${table.status} = 'credited' and ${table.method} = 'sham_cash')
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

/**
 * A USDT deposit's payment and check (S04), one per USDT deposit, keyed by it. Not append-only:
 * it carries the verification state. Migration 0014 refuses a delete and any change of the
 * deposit, method, address, tail or amount, or of the transfer once bound; it keeps
 * `deposit_open` equal to the deposit being `pending` or `submitted`.
 */
export const usdtDeposits = pgTable(
  'usdt_deposits',
  {
    depositId: uuid('deposit_id')
      .primaryKey()
      .references(() => deposits.id),
    /** The deposit's method (checked by migration 0014's trigger at insert). */
    method: paymentMethodEnum('method').notNull(),
    /** The address shown to the customer, from the server environment at creation (rule U1). */
    receivingAddress: text('receiving_address').notNull(),
    /** 0.0001–0.0099 USDT in USD units (rule U3). */
    tailUnits: amountUnits('tail_units').notNull(),
    /** The exact USDT to send, in USD units: the declared amount plus the tail. */
    payAmountUnits: amountUnits('pay_amount_units').notNull(),
    /** Mirrors the deposit being `pending` or `submitted`: the amount's reservation backstop. */
    depositOpen: boolean('deposit_open').notNull().default(true),
    checkStatus: usdtCheckStatusEnum('check_status').notNull().default('awaiting_transfer'),
    /** The last TXID failure shown to the customer (rule U10). */
    checkError: usdtCheckErrorEnum('check_error'),
    /** The TXID being verified or found. */
    txid: text('txid'),
    txidSource: usdtTxidSourceEnum('txid_source'),
    txidSubmissions: smallint('txid_submissions').notNull().default(0),
    /** When the current TXID was first looked for (rule U9). */
    searchStartedAt: timestamp('search_started_at', { withTimezone: true }),
    /** The last count read, for the customer's progress. */
    confirmations: integer('confirmations'),
    /** The transfer this deposit is bound to; never changed once set. */
    transferId: uuid('transfer_id')
      .unique()
      .references(() => usdtTransfers.id),
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    // No two open deposits of one network ask for the same amount (rule U3).
    uniqueIndex('usdt_deposits_open_amount_unique')
      .on(table.method, table.payAmountUnits)
      .where(sql`${table.depositOpen}`),
    index('usdt_deposits_amount_idx').on(table.method, table.payAmountUnits),
    index('usdt_deposits_check_status_idx').on(table.checkStatus),
    check('usdt_deposits_method_check', isUsdtMethod(table.method)),
    check(
      'usdt_deposits_amount_check',
      sql`${table.tailUnits} between 100 and 9900 and ${table.tailUnits} % 100 = 0
        and ${table.payAmountUnits} > ${table.tailUnits}
        and (${table.payAmountUnits} - ${table.tailUnits}) % 10000 = 0`,
    ),
    check(
      'usdt_deposits_txid_check',
      sql`(${table.txid} is null or ${isTxid(table.txid)})
        and (${table.txid} is null) = (${table.txidSource} is null)
        and ${table.txidSubmissions} between 0 and 5
        and (${table.confirmations} is null or ${table.confirmations} >= 0)`,
    ),
    check(
      'usdt_deposits_check_error_check',
      sql`${table.checkError} is null or ${table.checkStatus} = 'awaiting_transfer'`,
    ),
    check(
      'usdt_deposits_transfer_check',
      sql`${table.transferId} is null or ${table.checkStatus} in ('confirming', 'review', 'done')`,
    ),
  ],
);

/**
 * Every confirmed official-USDT transfer of at least $1 to a store address that the scanner or
 * the verifier has seen (S04 rules U13, U14): one row per transaction, its matching transfers
 * summed. Append-only. Credited, bound or unmatched is derived, never stored.
 */
export const usdtTransfers = pgTable(
  'usdt_transfers',
  {
    id: id(),
    method: paymentMethodEnum('method').notNull(),
    txid: text('txid').notNull(),
    fromAddress: text('from_address').notNull(),
    toAddress: text('to_address').notNull(),
    /** The exact on-chain sum in the token's raw units (18 decimals on BSC). */
    rawAmount: numeric('raw_amount', { precision: 78, scale: 0 }).notNull(),
    /** The sum in USD units, floored (`rawToUsdUnits`). */
    amountUnits: amountUnits('amount_units').notNull(),
    blockNumber: bigint('block_number', { mode: 'number' }).notNull(),
    blockTime: timestamp('block_time', { withTimezone: true }).notNull(),
    /** Who saw it first. */
    source: usdtTransferSourceEnum('source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('usdt_transfers_txid_unique').on(table.method, table.txid),
    index('usdt_transfers_block_time_idx').on(table.method, table.blockTime.desc()),
    index('usdt_transfers_amount_idx').on(table.method, table.amountUnits),
    check('usdt_transfers_method_check', isUsdtMethod(table.method)),
    check('usdt_transfers_txid_check', isTxid(table.txid)),
    check(
      'usdt_transfers_amount_check',
      sql`${table.rawAmount} > 0 and ${table.amountUnits} >= 1000000 and ${table.blockNumber} >= 0`,
    ),
  ],
);

/** Each network scanner's position (S04 rule U12): safe to move back, never a business record. */
export const usdtScanCursors = pgTable(
  'usdt_scan_cursors',
  {
    method: paymentMethodEnum('method').primaryKey(),
    /** TRON: the last block timestamp in ms; BSC: the last scanned block number. */
    cursor: text('cursor').notNull(),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }).notNull(),
    ...timestamps(),
  },
  (table) => [check('usdt_scan_cursors_method_check', isUsdtMethod(table.method))],
);
