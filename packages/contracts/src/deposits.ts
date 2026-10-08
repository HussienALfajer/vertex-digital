import { z } from 'zod';
import { cursorPageSchema, cursorQuerySchema } from './lists.js';
import {
  amountUnitsSchema,
  CURRENCY_SCALE,
  type Currency,
  currencySchema,
  exchangeRateSchema,
  isWholeCents,
  sypDepositUsd,
  usdCentsSchema,
} from './money.js';
import { displayStepSchema } from './rates.js';
import { USDT_METHODS, usdtMethodSchema } from './usdt.js';

/*
 * Deposits (S03, F05; ADR 0006, 0017), owned by the api `deposits` module: Sham Cash deposits
 * checked by hand, their states, limits, fraud flags, the review ETA and the deposit settings.
 * S04 adds the USDT methods to the same model.
 */

/** How a deposit is paid: Sham Cash (S03) or USDT on one of its networks (S04). */
export const DEPOSIT_METHODS = ['sham_cash', ...USDT_METHODS] as const;

export const depositMethodSchema = z.enum(DEPOSIT_METHODS).meta({ id: 'DepositMethod' });

export type DepositMethod = z.infer<typeof depositMethodSchema>;

export const DEPOSIT_STATUSES = [
  'pending',
  'submitted',
  'credited',
  'rejected',
  'expired',
  'cancelled',
] as const;

export const depositStatusSchema = z.enum(DEPOSIT_STATUSES).meta({ id: 'DepositStatus' });

export type DepositStatus = z.infer<typeof depositStatusSchema>;

/**
 * The only allowed status changes (S03 "Deposit states", ADR 0017). `submitted → pending` is the
 * clearer-receipt request, once per deposit (rule RV8). A status with no next status is final.
 */
export const DEPOSIT_TRANSITIONS: Readonly<Record<DepositStatus, readonly DepositStatus[]>> = {
  pending: ['submitted', 'cancelled', 'expired'],
  submitted: ['credited', 'rejected', 'pending'],
  credited: [],
  rejected: [],
  expired: [],
  cancelled: [],
};

export function canTransitionDeposit(from: DepositStatus, to: DepositStatus): boolean {
  return DEPOSIT_TRANSITIONS[from].includes(to);
}

/** True for `credited`, `rejected`, `expired` and `cancelled`: the deposit never changes again. */
export function isFinalDepositStatus(status: DepositStatus): boolean {
  return DEPOSIT_TRANSITIONS[status].length === 0;
}

/** An approval above $100 needs a re-authentication (rule RV4); exactly $100 does not. */
export const DEPOSIT_APPROVAL_REAUTH_THRESHOLD_USD_UNITS = 100 * CURRENCY_SCALE.USD;

/** A deposit without a receipt expires this long after creation or a receipt request (SC12). */
export const DEPOSIT_PENDING_HOURS = 24;

/** At most this many `submitted` deposits per customer (rule SC5). */
export const MAX_DEPOSITS_IN_REVIEW = 3;

/** Two receipts whose dHashes differ in at most this many bits are similar (rule FL2). */
export const RECEIPT_SIMILAR_MAX_DISTANCE = 6;

/** Receipt and QR uploads (rule SC8): at most 5 MB, JPEG, PNG or WebP, decoded up to 40 MP. */
export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
export const UPLOAD_MAX_INPUT_PIXELS = 40_000_000;
export const RECEIPT_MAX_DIMENSION = 2000;
export const QR_MAX_DIMENSION = 1000;

/** Per-customer limits (rule SC6), counted in the database over the last hour. */
export const DEPOSIT_CREATIONS_PER_HOUR = 10;
export const RECEIPT_UPLOADS_PER_HOUR = 20;

/** The time zone of the review hours (rule SC13). */
export const REVIEW_TIME_ZONE = 'Asia/Damascus';

/** The review ETA's sample (rule SC13): the last 20 decisions of 14 days; fewer than 5: target. */
export const REVIEW_ETA_SAMPLE_SIZE = 20;
export const REVIEW_ETA_SAMPLE_DAYS = 14;
export const REVIEW_ETA_MIN_SAMPLES = 5;
const REVIEW_ETA_STEP_MINUTES = 5;

/* Reference codes ------------------------------------------------------------------------- */

/** The characters of a reference code: no 0, O, 1, I or L, which read alike. */
export const REFERENCE_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const REFERENCE_CODE_LENGTH = 5;
export const REFERENCE_CODE_PREFIX = 'VD-';

const REFERENCE_CODE_PATTERN = new RegExp(
  `^${REFERENCE_CODE_PREFIX}[${REFERENCE_CODE_ALPHABET}]{${REFERENCE_CODE_LENGTH}}$`,
);

/**
 * A deposit's reference code, as the customer writes it in the transfer note: `VD-` and 5
 * characters. Accepts lower case and a missing dash, and normalizes to `VD-XXXXX`.
 */
export const referenceCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .transform((value) => value.replace(/^VD-?/, REFERENCE_CODE_PREFIX))
  .pipe(z.string().regex(REFERENCE_CODE_PATTERN, 'Expected a reference code such as VD-7KQ2M'));

/* Flags (A10) --------------------------------------------------------------------------- */

/** Computed when a receipt is submitted, for that receipt (rules FL1–FL5). */
export const SUBMISSION_FLAG_CODES = [
  'receipt_reused',
  'receipt_similar',
  'new_account_large',
  'velocity',
  'shared_phone',
] as const;

/** Computed from the approval request and inserted with the approval (rules RV5, FL6). */
export const APPROVAL_FLAG_CODES = [
  'amount_mismatch',
  'reference_missing',
  'reference_different',
] as const;

/**
 * Why a USDT transfer went to review instead of an automatic credit (S04 rule U11).
 * `amount_mismatch` compares the amount to pay with the amount received, both USD.
 */
export const USDT_REVIEW_FLAG_CODES = [
  'amount_mismatch',
  'wrong_network',
  'sent_before_deposit',
] as const;

export const DEPOSIT_FLAG_CODES = [
  ...SUBMISSION_FLAG_CODES,
  ...APPROVAL_FLAG_CODES,
  'wrong_network',
  'sent_before_deposit',
] as const;

export const depositFlagCodeSchema = z.enum(DEPOSIT_FLAG_CODES).meta({ id: 'DepositFlagCode' });

export type DepositFlagCode = z.infer<typeof depositFlagCodeSchema>;

const receiptMatch = {
  depositId: z.uuid(),
  receiptId: z.uuid(),
  customerId: z.uuid(),
};

/** The shape of each flag's `details`, checked before a flag is written (as audit details are). */
export const DEPOSIT_FLAG_DETAILS = {
  /** FL1: the other receipts with the same original bytes, any customer. */
  receipt_reused: z.strictObject({ matches: z.array(z.strictObject(receiptMatch)).min(1) }),
  /** FL2: the other receipts whose dHash is within the distance, not caught by FL1. */
  receipt_similar: z.strictObject({
    matches: z.array(z.strictObject({ ...receiptMatch, distance: z.int().min(0).max(64) })).min(1),
  }),
  /** FL3: a new customer's deposit at or above the setting. */
  new_account_large: z.strictObject({
    declaredUsdUnits: z.int().positive(),
    thresholdUnits: z.int().positive(),
  }),
  /** FL4: the customer's submissions in 24 hours, this one included, above the setting. */
  velocity: z.strictObject({ submissions: z.int().positive(), threshold: z.int().positive() }),
  /** FL5: other non-archived customers with the same phone. */
  shared_phone: z.strictObject({
    count: z.int().positive(),
    customerIds: z.array(z.uuid()).min(1),
  }),
  /** FL6: what was received differs from what was declared. */
  amount_mismatch: z.strictObject({
    declaredCurrency: currencySchema,
    declaredAmountUnits: z.int().positive(),
    receivedCurrency: currencySchema,
    receivedAmountUnits: z.int().positive(),
  }),
  reference_missing: z.strictObject({}),
  reference_different: z.strictObject({}),
  /** U11: the transfer is on the other network, to the store's address there. */
  wrong_network: z.strictObject({
    depositMethod: usdtMethodSchema,
    transferMethod: usdtMethodSchema,
  }),
  /** U11: the transfer's block is older than the deposit. */
  sent_before_deposit: z.strictObject({
    depositCreatedAt: z.iso.datetime(),
    blockTime: z.iso.datetime(),
  }),
} as const satisfies Record<DepositFlagCode, z.ZodType>;

export type DepositFlagDetails<Code extends DepositFlagCode> = z.infer<
  (typeof DEPOSIT_FLAG_DETAILS)[Code]
>;

/** What the admin saw of the reference code in the transfer note (rule RV1). */
export const DEPOSIT_REFERENCE_CHECKS = ['matches', 'missing', 'different'] as const;

export const depositReferenceCheckSchema = z
  .enum(DEPOSIT_REFERENCE_CHECKS)
  .meta({ id: 'DepositReferenceCheck' });

export type DepositReferenceCheck = z.infer<typeof depositReferenceCheckSchema>;

/** Rule RV6; the customer sees each in words. `other` needs a customer note. */
export const DEPOSIT_REJECT_REASONS = [
  'not_received',
  'receipt_invalid',
  'receipt_used',
  'reference_other_customer',
  'wrong_account',
  /** S04: the transfer is on another network than the deposit's. */
  'wrong_network',
  /** S04: the transfer belongs to another customer's deposit. */
  'transfer_other_customer',
  'other',
] as const;

export const depositRejectReasonSchema = z
  .enum(DEPOSIT_REJECT_REASONS)
  .meta({ id: 'DepositRejectReason' });

export type DepositRejectReason = z.infer<typeof depositRejectReasonSchema>;

/** Who decided a deposit: the admin, or the worker on an exact USDT match (S04 rule U7). */
export const DEPOSIT_DECIDERS = ['admin', 'system'] as const;

export const depositDeciderSchema = z.enum(DEPOSIT_DECIDERS).meta({ id: 'DepositDecider' });

export type DepositDecider = z.infer<typeof depositDeciderSchema>;

/**
 * Where a USDT deposit's check stands (S04 "Deposit states"): `pending` is `awaiting_transfer`;
 * `submitted` is `searching` (a TXID not found yet), `confirming` (an exact match waiting for
 * finality) or `review`; a final deposit is `done`.
 */
export const USDT_CHECK_STATUSES = [
  'awaiting_transfer',
  'searching',
  'confirming',
  'review',
  'done',
] as const;

export const usdtCheckStatusSchema = z.enum(USDT_CHECK_STATUSES).meta({ id: 'UsdtCheckStatus' });

export type UsdtCheckStatus = z.infer<typeof usdtCheckStatusSchema>;

/**
 * Why a TXID bounced the deposit back to `pending` (rule U10); the customer sees it in words.
 * `amount_too_small`: official USDT reached the store, but under $1, which is never recorded
 * (rule U14), so it cannot go to review (owner, 2026-10-08). `txid_used`: the transfer is
 * already bound to another deposit or recorded by the admin (two customers pasted one TXID).
 */
export const USDT_CHECK_ERRORS = [
  'not_found',
  'tx_failed',
  'not_to_store',
  'wrong_token',
  'amount_too_small',
  'txid_used',
] as const;

export const usdtCheckErrorSchema = z.enum(USDT_CHECK_ERRORS).meta({ id: 'UsdtCheckError' });

export type UsdtCheckError = z.infer<typeof usdtCheckErrorSchema>;

/** Who gave a USDT deposit its TXID: the customer (rule U8) or the scanner (rule U12). */
export const USDT_TXID_SOURCES = ['customer', 'scan'] as const;

export const usdtTxidSourceSchema = z.enum(USDT_TXID_SOURCES).meta({ id: 'UsdtTxidSource' });

/** Who saw a transfer first: the scanner, or the verifier reading a TXID (rule U13). */
export const USDT_TRANSFER_SOURCES = ['scan', 'txid'] as const;

export const usdtTransferSourceSchema = z
  .enum(USDT_TRANSFER_SOURCES)
  .meta({ id: 'UsdtTransferSource' });

/* Amounts and the credit ----------------------------------------------------------------- */

/** True when `units` is a whole amount a customer can send: whole pounds, or whole cents. */
export function isWholeDepositAmount(currency: Currency, units: number): boolean {
  return currency === 'SYP' ? units % CURRENCY_SCALE.SYP === 0 : isWholeCents(units);
}

const positiveUnitsSchema = amountUnitsSchema.refine((units) => units > 0, 'Expected above zero');

/**
 * The USD an amount is worth to the store: USD as is; SYP converted at `rate` with rule FX6.
 * Used for a deposit's declared USD (rule SC2) and an approval's credit (rule RV2, with the rate
 * of rule RV3). `rate` is required for pounds.
 */
export function depositCreditUsdUnits(
  receivedCurrency: Currency,
  receivedAmountUnits: number,
  rate: string | null,
): number {
  if (receivedCurrency === 'USD') return receivedAmountUnits;
  if (rate === null) throw new RangeError('Converting pounds needs a rate');
  return sypDepositUsd(receivedAmountUnits, rate);
}

/** The approval-time flags of a request (rule RV5). */
export function approvalFlags(
  deposit: { currency: Currency; declaredAmountUnits: number },
  received: {
    receivedCurrency: Currency;
    receivedAmountUnits: number;
    referenceCheck: DepositReferenceCheck;
  },
): DepositFlagCode[] {
  const flags: DepositFlagCode[] = [];
  if (
    received.receivedCurrency !== deposit.currency ||
    received.receivedAmountUnits !== deposit.declaredAmountUnits
  ) {
    flags.push('amount_mismatch');
  }
  if (received.referenceCheck === 'missing') flags.push('reference_missing');
  if (received.referenceCheck === 'different') flags.push('reference_different');
  return flags;
}

/** True when both lists hold the same flags, whatever the order or repeats (rule RV5). */
export function sameFlags(a: readonly DepositFlagCode[], b: readonly DepositFlagCode[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((code) => right.has(code));
}

/** Rule RV4: above $100, or any flag at all, needs a re-authentication. */
export function approvalNeedsReauthentication(creditUsdUnits: number, flagCount: number): boolean {
  return creditUsdUnits > DEPOSIT_APPROVAL_REAUTH_THRESHOLD_USD_UNITS || flagCount > 0;
}

/* Limits (rule SC3) ---------------------------------------------------------------------- */

export interface DepositLimitSettings {
  minDepositUsdUnits: number;
  newAccountPerDepositUsdUnits: number;
  newAccountDailyUsdUnits: number;
  establishedPerDepositUsdUnits: number;
  establishedDailyUsdUnits: number;
}

export const depositLimitsSchema = z
  .object({
    /** False until the customer has one credited deposit (rule SC3). */
    established: z.boolean(),
    minUnits: amountUnitsSchema,
    perDepositUnits: amountUnitsSchema,
    dailyUnits: amountUnitsSchema,
    /** What the 24-hour window still allows; 0 when used up. */
    remainingTodayUnits: amountUnitsSchema,
  })
  .meta({ id: 'DepositLimits' });

export type DepositLimits = z.infer<typeof depositLimitsSchema>;

/** A USDT deposit's limits take the USDT minimum instead of Sham Cash's (S04 rule U5). */
export function depositLimitSettingsFor(
  method: DepositMethod,
  settings: DepositLimitSettings & { usdtMinDepositUsdUnits: number },
): DepositLimitSettings {
  return method === 'sham_cash'
    ? settings
    : { ...settings, minDepositUsdUnits: settings.usdtMinDepositUsdUnits };
}

/**
 * A customer's limits (rule SC3). `usedTodayUnits` is the declared USD of their `pending` and
 * `submitted` deposits plus the credited USD of `credited` ones, all created in the last 24 hours.
 */
export function depositLimits(
  settings: DepositLimitSettings,
  established: boolean,
  usedTodayUnits: number,
): DepositLimits {
  const dailyUnits = established
    ? settings.establishedDailyUsdUnits
    : settings.newAccountDailyUsdUnits;
  return {
    established,
    minUnits: settings.minDepositUsdUnits,
    perDepositUnits: established
      ? settings.establishedPerDepositUsdUnits
      : settings.newAccountPerDepositUsdUnits,
    dailyUnits,
    remainingTodayUnits: Math.max(0, dailyUnits - usedTodayUnits),
  };
}

export const DEPOSIT_LIMIT_KINDS = ['minimum', 'per_deposit', 'daily'] as const;

/** `DEPOSIT_LIMIT_EXCEEDED`'s `details`. */
export interface DepositLimitBreach {
  limit: (typeof DEPOSIT_LIMIT_KINDS)[number];
  limitUnits: number;
  remainingUnits: number;
}

/** The limit a new deposit of `declaredUsdUnits` breaks, or null (rule SC3). */
export function depositLimitBreach(
  limits: DepositLimits,
  declaredUsdUnits: number,
): DepositLimitBreach | null {
  const breach = (limit: DepositLimitBreach['limit'], limitUnits: number) => ({
    limit,
    limitUnits,
    remainingUnits: limits.remainingTodayUnits,
  });
  if (declaredUsdUnits < limits.minUnits) return breach('minimum', limits.minUnits);
  if (declaredUsdUnits > limits.perDepositUnits) {
    return breach('per_deposit', limits.perDepositUnits);
  }
  if (declaredUsdUnits > limits.remainingTodayUnits) return breach('daily', limits.dailyUnits);
  return null;
}

/* Review hours and the ETA (rule SC13) --------------------------------------------------- */

/** A time of day in the review time zone, `HH:MM` (24 hours). */
export const reviewTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM')
  .meta({ id: 'ReviewTime' });

export interface ReviewHours {
  start: string;
  end: string;
}

const minutesOfDay = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

const zoneFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: REVIEW_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

/** The wall clock of the review time zone at `at`. */
function zoneClock(at: Date) {
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(zoneFormat.formatToParts(at).find((item) => item.type === type)?.value);
  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
    minutes: part('hour') * 60 + part('minute'),
    seconds: part('second'),
  };
}

/** The zone's offset from UTC at `at`, in milliseconds. */
function zoneOffset(at: Date): number {
  const clock = zoneClock(at);
  const asUtc = Date.UTC(clock.year, clock.month - 1, clock.day, 0, clock.minutes, clock.seconds);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant of a wall-clock time in the zone; `day` may run past the month's end. */
function zoneInstant(year: number, month: number, day: number, minutes: number): Date {
  const wall = Date.UTC(year, month - 1, day, 0, minutes);
  const first = wall - zoneOffset(new Date(wall));
  return new Date(wall - zoneOffset(new Date(first)));
}

/** True when `at` falls within the review hours, start included, end excluded. */
export function isWithinReviewHours(at: Date, hours: ReviewHours): boolean {
  const { minutes } = zoneClock(at);
  return minutes >= minutesOfDay(hours.start) && minutes < minutesOfDay(hours.end);
}

/** The next time reviews open after `at`: today's start if it is still ahead, else tomorrow's. */
export function nextReviewOpening(at: Date, hours: ReviewHours): Date {
  const clock = zoneClock(at);
  const start = minutesOfDay(hours.start);
  const day = clock.minutes < start ? clock.day : clock.day + 1;
  return zoneInstant(clock.year, clock.month, day, start);
}

/**
 * The review ETA in minutes within hours (rule SC13): the median of the sampled review times
 * (seconds from submission to decision), rounded up to 5 minutes, at least 5; the target when
 * fewer than 5 decisions were sampled.
 */
export function reviewEtaMinutes(durationsSeconds: readonly number[], targetMinutes: number) {
  if (durationsSeconds.length < REVIEW_ETA_MIN_SAMPLES) return targetMinutes;
  const sorted = [...durationsSeconds].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[middle] as number)
      : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
  const step = REVIEW_ETA_STEP_MINUTES * 60;
  return Math.max(REVIEW_ETA_STEP_MINUTES, Math.ceil(median / step) * REVIEW_ETA_STEP_MINUTES);
}

/** What the customer is told about the review time (rule SC13): an ETA, or the next opening. */
export const reviewEtaSchema = z
  .discriminatedUnion('state', [
    z.object({ state: z.literal('open'), minutes: z.int().positive() }),
    z.object({ state: z.literal('closed'), opensAt: z.iso.datetime() }),
  ])
  .meta({ id: 'ReviewEta' });

export type ReviewEta = z.infer<typeof reviewEtaSchema>;

export function reviewEta(
  now: Date,
  hours: ReviewHours,
  targetMinutes: number,
  durationsSeconds: readonly number[],
): ReviewEta {
  if (!isWithinReviewHours(now, hours)) {
    return { state: 'closed', opensAt: nextReviewOpening(now, hours).toISOString() };
  }
  return { state: 'open', minutes: reviewEtaMinutes(durationsSeconds, targetMinutes) };
}

/* Receipt hashes (rule FL2) -------------------------------------------------------------- */

/** The dHash input: a 9×8 grayscale image, row by row. */
export const DHASH_WIDTH = 9;
export const DHASH_HEIGHT = 8;

/**
 * The 64-bit difference hash of a 9×8 grayscale image (one byte per pixel, row by row): a bit per
 * pair of neighbours, set when the left one is brighter. A signed 64-bit integer, as stored.
 */
export function dHash(pixels: Uint8Array): bigint {
  if (pixels.length !== DHASH_WIDTH * DHASH_HEIGHT) {
    throw new RangeError(`Expected ${DHASH_WIDTH * DHASH_HEIGHT} pixels, got ${pixels.length}`);
  }
  let hash = 0n;
  for (let row = 0; row < DHASH_HEIGHT; row += 1) {
    for (let column = 0; column < DHASH_WIDTH - 1; column += 1) {
      const left = pixels[row * DHASH_WIDTH + column] as number;
      const right = pixels[row * DHASH_WIDTH + column + 1] as number;
      hash = (hash << 1n) | (left > right ? 1n : 0n);
    }
  }
  return BigInt.asIntN(64, hash);
}

/** How many of the 64 bits differ between two dHashes. */
export function dHashDistance(a: bigint, b: bigint): number {
  let rest = BigInt.asUintN(64, a ^ b);
  let count = 0;
  while (rest > 0n) {
    count += Number(rest & 1n);
    rest >>= 1n;
  }
  return count;
}

/* Settings ------------------------------------------------------------------------------- */

/** A limit or threshold: whole cents above zero. */
const limitSchema = usdCentsSchema.refine((units) => units > 0, 'Expected above zero');

const depositSettingsFields = {
  shamCashAccountName: z.string().trim().min(1).max(100),
  shamCashAccountNumber: z.string().trim().min(1).max(64),
  sypEnabled: z.boolean(),
  usdEnabled: z.boolean(),
  /** From `POST /api/admin/deposit-settings/qr`; required while the currency is enabled. */
  sypQrFileId: z.uuid().nullable(),
  usdQrFileId: z.uuid().nullable(),
  minDepositUsdUnits: limitSchema,
  newAccountPerDepositUsdUnits: limitSchema,
  newAccountDailyUsdUnits: limitSchema,
  establishedPerDepositUsdUnits: limitSchema,
  establishedDailyUsdUnits: limitSchema,
  reviewHoursStart: reviewTimeSchema,
  reviewHoursEnd: reviewTimeSchema,
  reviewTargetMinutes: z.int().min(1).max(1440),
  flagNewAccountUsdUnits: limitSchema,
  flagVelocityCount: z.int().min(1).max(50),
  /** S04: one switch per network; on only with its address in the server environment (U1). */
  usdtTrc20Enabled: z.boolean(),
  usdtBep20Enabled: z.boolean(),
  usdtMinDepositUsdUnits: limitSchema,
  /**
   * S05 rule TC4: the largest credit approved from Telegram, whole cents; 0 turns it off. Never
   * above the re-authentication threshold of rule RV4 (ADR 0019).
   */
  telegramApprovalMaxUsdUnits: usdCentsSchema.max(DEPOSIT_APPROVAL_REAUTH_THRESHOLD_USD_UNITS),
};

export type DepositSettingsValues = z.infer<z.ZodObject<typeof depositSettingsFields>>;

/** What the first save starts from (owner, 2026-10-08); never seeded. */
export const DEPOSIT_SETTINGS_DEFAULTS = {
  shamCashAccountName: '',
  shamCashAccountNumber: '',
  sypEnabled: false,
  usdEnabled: false,
  sypQrFileId: null,
  usdQrFileId: null,
  minDepositUsdUnits: 2 * CURRENCY_SCALE.USD,
  newAccountPerDepositUsdUnits: 50 * CURRENCY_SCALE.USD,
  newAccountDailyUsdUnits: 100 * CURRENCY_SCALE.USD,
  establishedPerDepositUsdUnits: 300 * CURRENCY_SCALE.USD,
  establishedDailyUsdUnits: 1000 * CURRENCY_SCALE.USD,
  reviewHoursStart: '10:00',
  reviewHoursEnd: '22:00',
  reviewTargetMinutes: 15,
  flagNewAccountUsdUnits: 25 * CURRENCY_SCALE.USD,
  flagVelocityCount: 3,
  usdtTrc20Enabled: false,
  usdtBep20Enabled: false,
  usdtMinDepositUsdUnits: 5 * CURRENCY_SCALE.USD,
  telegramApprovalMaxUsdUnits: 100 * CURRENCY_SCALE.USD,
} as const satisfies DepositSettingsValues;

/** `PUT /api/admin/deposit-settings`: the cross-field rules of the table's checks. */
export const depositSettingsInputSchema = z
  .object(depositSettingsFields)
  .superRefine((input, context) => {
    const issue = (path: keyof DepositSettingsValues, message: string) =>
      context.addIssue({ code: 'custom', path: [path], message });
    if (input.sypEnabled && !input.sypQrFileId) issue('sypQrFileId', 'SYP needs its QR image');
    if (input.usdEnabled && !input.usdQrFileId) issue('usdQrFileId', 'USD needs its QR image');
    const tiers = [
      ['newAccountPerDepositUsdUnits', 'newAccountDailyUsdUnits'],
      ['establishedPerDepositUsdUnits', 'establishedDailyUsdUnits'],
    ] as const;
    for (const [perDeposit, daily] of tiers) {
      if (input[perDeposit] < input.minDepositUsdUnits) {
        issue(perDeposit, 'Below the minimum deposit');
      }
      if (input[daily] < input[perDeposit]) issue(daily, 'Below the per-deposit limit');
    }
    const lowestPerDeposit = Math.min(
      input.newAccountPerDepositUsdUnits,
      input.establishedPerDepositUsdUnits,
    );
    if (input.usdtMinDepositUsdUnits > lowestPerDeposit) {
      issue('usdtMinDepositUsdUnits', 'Above a per-deposit limit');
    }
    if (input.reviewHoursEnd <= input.reviewHoursStart) {
      issue('reviewHoursEnd', 'Must be after the start');
    }
  })
  .meta({ id: 'DepositSettingsInput' });

export type DepositSettingsInput = z.input<typeof depositSettingsInputSchema>;

/** `GET /api/admin/deposit-settings`: the current version, or the defaults before a first save. */
export const depositSettingsSchema = z
  .object({
    ...depositSettingsFields,
    shamCashAccountName: z.string(),
    shamCashAccountNumber: z.string(),
    /** False before the first save: Sham Cash deposits are unavailable (rule SC1). */
    saved: z.boolean(),
    savedAt: z.iso.datetime().nullable(),
    /** S04: per network, read-only: the server's address and the scanner's health (rule U1). */
    usdt: z.array(
      z.object({
        method: usdtMethodSchema,
        /** From the server environment; null when not configured. Never editable here. */
        address: z.string().nullable(),
        lastScanAt: z.iso.datetime().nullable(),
        delayed: z.boolean(),
      }),
    ),
  })
  .meta({ id: 'DepositSettings' });

export type DepositSettings = z.infer<typeof depositSettingsSchema>;

/** `POST /api/admin/deposit-settings/qr`: the re-encoded image, to name in the settings. */
export const storedFileRefSchema = z.object({ fileId: z.uuid() }).meta({ id: 'StoredFileRef' });

export type StoredFileRef = z.infer<typeof storedFileRefSchema>;

/* Customer routes ------------------------------------------------------------------------ */

/**
 * A deposit method's state for new deposits (S05 rule SW6): `stopped` by the emergency stop,
 * `paused` by its own switch, `unavailable` when not configured or not ready (S03 SC1, S04 U1).
 * The store shows paused and stopped methods disabled with the stop text.
 */
export const DEPOSIT_METHOD_STATES = ['available', 'paused', 'stopped', 'unavailable'] as const;

export const depositMethodStateSchema = z
  .enum(DEPOSIT_METHOD_STATES)
  .meta({ id: 'DepositMethodState' });

export type DepositMethodState = z.infer<typeof depositMethodStateSchema>;

/** The emergency stop wins over the method's pause, which wins over its configuration. */
export function depositMethodState(input: {
  stopped: boolean;
  paused: boolean;
  ready: boolean;
}): DepositMethodState {
  if (input.stopped) return 'stopped';
  if (input.paused) return 'paused';
  return input.ready ? 'available' : 'unavailable';
}

/** Why a currency cannot be deposited now (rules SC1, FX8). */
export const DEPOSIT_UNAVAILABLE_REASONS = ['not_configured', 'disabled', 'no_rate'] as const;

const currencyOption = z.object({
  available: z.boolean(),
  reason: z.enum(DEPOSIT_UNAVAILABLE_REASONS).nullable(),
});

/** `GET /api/deposits/sham-cash/options` (rules SC1, SC3, SC13). */
export const shamCashOptionsSchema = z
  .object({
    /** The method's state (S05 rule SW6); `available` when a currency is. */
    state: depositMethodStateSchema,
    currencies: z.object({ SYP: currencyOption, USD: currencyOption }),
    /** The store's Sham Cash account; null before the settings exist. */
    account: z.object({ name: z.string(), number: z.string() }).nullable(),
    limits: depositLimitsSchema.nullable(),
    rate: z
      .object({
        id: z.uuid(),
        sypPerUsd: exchangeRateSchema,
        displayStepSypUnits: displayStepSchema,
      })
      .nullable(),
    reviewHours: z.object({ start: reviewTimeSchema, end: reviewTimeSchema }).nullable(),
    eta: reviewEtaSchema.nullable(),
    /** The customer's deposit awaiting a receipt, which the store opens instead (rule SC4). */
    pendingDepositId: z.uuid().nullable(),
  })
  .meta({ id: 'ShamCashOptions' });

export type ShamCashOptions = z.infer<typeof shamCashOptionsSchema>;

/** `POST /api/deposits/sham-cash` (rule SC2): the amount in the currency's whole units. */
export const createShamCashDepositSchema = z
  .object({ currency: currencySchema, amountUnits: positiveUnitsSchema })
  .superRefine((input, context) => {
    if (!isWholeDepositAmount(input.currency, input.amountUnits)) {
      context.addIssue({
        code: 'custom',
        path: ['amountUnits'],
        message: input.currency === 'SYP' ? 'Expected whole pounds' : 'Expected whole cents',
      });
    }
  })
  .meta({ id: 'CreateShamCashDeposit' });

export type CreateShamCashDeposit = z.input<typeof createShamCashDepositSchema>;

/** `POST /api/deposits/:id/receipt` (rule SC9): the rate the customer saw, for SYP. */
export const submitReceiptSchema = z
  .object({ rateId: z.uuid().optional() })
  .meta({ id: 'SubmitReceipt' });

export type SubmitReceipt = z.infer<typeof submitReceiptSchema>;

/** A SYP deposit's locked rate (rule FX5). */
export const depositQuoteSchema = z
  .object({ rateId: z.uuid(), rate: exchangeRateSchema, expiresAt: z.iso.datetime() })
  .meta({ id: 'DepositQuote' });

/** `QUOTE_EXPIRED`'s `details` (rule SC9): the current rate and what the amount would get. */
export const quoteOfferSchema = z
  .object({ rateId: z.uuid(), rate: exchangeRateSchema, declaredUsdUnits: amountUnitsSchema })
  .meta({ id: 'QuoteOffer' });

export type QuoteOffer = z.infer<typeof quoteOfferSchema>;

/** Why a USDT network cannot take new deposits now (S04 rule U1). */
export const USDT_UNAVAILABLE_REASONS = ['not_configured', 'disabled', 'delayed'] as const;

/** `GET /api/deposits/usdt/options` (rules U1, U5). */
export const usdtOptionsSchema = z
  .object({
    networks: z.array(
      z.object({
        method: usdtMethodSchema,
        /** The network's state (S05 rule SW6); `available` only when `available` is true. */
        state: depositMethodStateSchema,
        available: z.boolean(),
        unavailableReason: z.enum(USDT_UNAVAILABLE_REASONS).nullable(),
        /** Null while the network is not available. */
        address: z.string().nullable(),
        confirmations: z.int().positive(),
      }),
    ),
    /** With the USDT minimum; null before the deposit settings exist. */
    limits: depositLimitsSchema.nullable(),
    /** The customer's deposit awaiting payment, which the store opens instead (rule SC4). */
    pendingDepositId: z.uuid().nullable(),
  })
  .meta({ id: 'UsdtOptions' });

export type UsdtOptions = z.infer<typeof usdtOptionsSchema>;

/** `POST /api/deposits/usdt` (rule U2): the USD amount in whole cents. */
export const createUsdtDepositSchema = z
  .object({
    method: usdtMethodSchema,
    amountUnits: usdCentsSchema.refine((units) => units > 0, 'Expected above zero'),
  })
  .meta({ id: 'CreateUsdtDeposit' });

export type CreateUsdtDeposit = z.input<typeof createUsdtDepositSchema>;

/**
 * `POST /api/deposits/:id/txid` (rule U8): what the customer pasted. The API normalizes it with
 * `normalizeTxid` and answers `TXID_INVALID` when it is not a TXID; the store checks it first
 * with `txidSchema`.
 */
export const submitTxidSchema = z
  .object({ txid: z.string().trim().min(1).max(300) })
  .meta({ id: 'SubmitTxid' });

export type SubmitTxid = z.input<typeof submitTxidSchema>;

/** A USDT deposit's payment and check, as its customer sees it (S04 "Screens"). */
const depositUsdtFields = {
  method: usdtMethodSchema,
  /** The address shown at creation; it never changes for this deposit (rule U1). */
  address: z.string(),
  /** The exact amount to send, 4 decimals (`"25.0037"`). */
  payAmount: z.string(),
  payAmountUnits: amountUnitsSchema,
  checkStatus: usdtCheckStatusSchema,
  /** The last TXID's failure, shown while `awaiting_transfer` (rule U10). */
  checkError: usdtCheckErrorSchema.nullable(),
  txid: z.string().nullable(),
  explorerUrl: z.string().nullable(),
  confirmations: z.int().nonnegative().nullable(),
  requiredConfirmations: z.int().positive(),
  /** The network's scanner is late: verification may take longer (rule U12). */
  delayed: z.boolean(),
  /** In review: what arrived on chain and why it did not match (rule U11). */
  receivedAmountUnits: amountUnitsSchema.nullable(),
  reviewReasons: z.array(z.enum(USDT_REVIEW_FLAG_CODES)),
};

export const depositUsdtSchema = z.object(depositUsdtFields).meta({ id: 'DepositUsdt' });

export type DepositUsdt = z.infer<typeof depositUsdtSchema>;

const depositBase = {
  id: z.uuid(),
  method: depositMethodSchema,
  status: depositStatusSchema,
  referenceCode: z.string(),
  currency: currencySchema,
  declaredAmountUnits: amountUnitsSchema,
  declaredUsdUnits: amountUnitsSchema,
  /** SYP only. */
  quote: depositQuoteSchema.nullable(),
  expiresAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  submittedAt: z.iso.datetime().nullable(),
  decidedAt: z.iso.datetime().nullable(),
};

/** A deposit as its customer sees it: no flags, transaction number or internal notes. */
export const depositSchema = z
  .object({
    ...depositBase,
    /** The rate was fixed at the first valid submission and never changes (rule SC9). */
    rateFixed: z.boolean(),
    /** The admin asked for a clearer receipt, with an optional note (rule RV8). */
    receiptRequest: z.object({ at: z.iso.datetime(), note: z.string().nullable() }).nullable(),
    /** While `pending`: where to send the money (rule SC7); the QR of the current settings. */
    payTo: z
      .object({
        accountName: z.string(),
        accountNumber: z.string(),
        qrUrl: z.string().nullable(),
      })
      .nullable(),
    /** While `submitted` (rule SC13). */
    eta: reviewEtaSchema.nullable(),
    credited: z
      .object({
        usdUnits: amountUnitsSchema,
        receivedCurrency: currencySchema,
        receivedAmountUnits: amountUnitsSchema,
        /** The rate the pounds were converted at; null when USD was received. */
        rate: exchangeRateSchema.nullable(),
      })
      .nullable(),
    rejection: z
      .object({ reason: depositRejectReasonSchema, note: z.string().nullable() })
      .nullable(),
    /** USDT deposits only (S04). */
    usdt: depositUsdtSchema.nullable(),
  })
  .meta({ id: 'Deposit' });

export type Deposit = z.infer<typeof depositSchema>;

export const depositListQuerySchema = cursorQuerySchema.meta({ id: 'DepositListQuery' });

export type DepositListQuery = z.infer<typeof depositListQuerySchema>;

export const depositPageSchema = cursorPageSchema(depositSchema, 'DepositPage');

export type DepositPage = z.infer<typeof depositPageSchema>;

/* Admin routes --------------------------------------------------------------------------- */

/** `GET /api/admin/deposits` (rule RV10): `submitted` by default, flagged first, oldest first. */
export const adminDepositQuerySchema = cursorQuerySchema
  .extend({
    status: z.enum([...DEPOSIT_STATUSES, 'all']).default('submitted'),
    flagged: z.enum(['true', 'false']).optional(),
    method: depositMethodSchema.optional(),
    /** A reference code (any case, dash optional) or the customer's email prefix. */
    q: z.string().trim().min(3).max(254).optional(),
  })
  .meta({ id: 'AdminDepositQuery' });

export type AdminDepositQuery = z.infer<typeof adminDepositQuerySchema>;

const depositCustomer = {
  id: z.uuid(),
  name: z.string(),
  email: z.string(),
  isTest: z.boolean(),
};

export const adminDepositListItemSchema = z
  .object({
    ...depositBase,
    customer: z.object(depositCustomer),
    flags: z.array(depositFlagCodeSchema),
  })
  .meta({ id: 'AdminDepositListItem' });

export type AdminDepositListItem = z.infer<typeof adminDepositListItemSchema>;

export const adminDepositPageSchema = cursorPageSchema(
  adminDepositListItemSchema,
  'AdminDepositPage',
);

export type AdminDepositPage = z.infer<typeof adminDepositPageSchema>;

/** `GET /api/admin/deposits/counts`: the navigation badge. */
export const adminDepositCountsSchema = z
  .object({
    submitted: z.int().nonnegative(),
    submittedFlagged: z.int().nonnegative(),
    pending: z.int().nonnegative(),
    /** USDT deposits in review (S04 rule U11); also counted in `submitted`. */
    usdtReview: z.int().nonnegative(),
    /** USDT transfers of the last 30 days that no deposit or adjustment holds (rule U13). */
    unmatchedTransfers: z.int().nonnegative(),
  })
  .meta({ id: 'AdminDepositCounts' });

export type AdminDepositCounts = z.infer<typeof adminDepositCountsSchema>;

export const depositFlagSchema = z
  .object({
    id: z.uuid(),
    code: depositFlagCodeSchema,
    /** The receipt a submission flag was raised for; null for approval-time flags. */
    receiptId: z.uuid().nullable(),
    details: z.record(z.string(), z.unknown()),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'DepositFlag' });

export type DepositFlag = z.infer<typeof depositFlagSchema>;

/**
 * A reserved USDT deposit a transfer may belong to (rule U11): same network, and the same amount
 * to pay or the same tail. Any customer's.
 */
export const usdtCandidateSchema = z
  .object({
    depositId: z.uuid(),
    referenceCode: z.string(),
    status: depositStatusSchema,
    payAmountUnits: amountUnitsSchema,
    createdAt: z.iso.datetime(),
    customer: z.object({ id: z.uuid(), name: z.string(), email: z.string() }),
  })
  .meta({ id: 'UsdtCandidate' });

export type UsdtCandidate = z.infer<typeof usdtCandidateSchema>;

/** A confirmed official-USDT transfer to a store address (rule U13), as recorded. */
export const usdtTransferSchema = z
  .object({
    id: z.uuid(),
    method: usdtMethodSchema,
    txid: z.string(),
    explorerUrl: z.string(),
    fromAddress: z.string(),
    toAddress: z.string(),
    /** The exact on-chain sum, in the token's raw units. */
    rawAmount: z.string(),
    /** The sum in USD units, floored. */
    amountUnits: amountUnitsSchema,
    blockNumber: z.int().nonnegative(),
    blockTime: z.iso.datetime(),
    source: usdtTransferSourceSchema,
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'UsdtTransfer' });

export type UsdtTransfer = z.infer<typeof usdtTransferSchema>;

/** A USDT deposit as the admin sees it: the customer's view, the tail, the transfer, candidates. */
export const adminDepositUsdtSchema = z
  .object({
    ...depositUsdtFields,
    tailUnits: amountUnitsSchema,
    txidSource: usdtTxidSourceSchema.nullable(),
    txidSubmissions: z.int().nonnegative(),
    lastCheckedAt: z.iso.datetime().nullable(),
    transfer: usdtTransferSchema.nullable(),
    candidates: z.array(usdtCandidateSchema),
  })
  .meta({ id: 'AdminDepositUsdt' });

export type AdminDepositUsdt = z.infer<typeof adminDepositUsdtSchema>;

/**
 * `GET /api/admin/deposits/:id`: everything the review needs (rules RV1–RV10, A10). Its audit
 * trail is the audit log filtered by the deposit (`entityType=deposit&entityId=<id>`).
 */
export const adminDepositSchema = z
  .object({
    ...depositBase,
    rateFixedAt: z.iso.datetime().nullable(),
    receiptRequestedAt: z.iso.datetime().nullable(),
    receiptRequestCount: z.int().min(0).max(1),
    receiptRequestNote: z.string().nullable(),
    /** The rate an approval converts received pounds at now (rule RV3); null without one. */
    approvalRate: z.object({ rateId: z.uuid(), rate: exchangeRateSchema }).nullable(),
    /** The admin, or the worker on an exact USDT match (S04 rule U7); null while undecided. */
    decidedBy: depositDeciderSchema.nullable(),
    /** The admin who decided (approved or rejected); null once that admin was replaced. */
    adminName: z.string().nullable(),
    credit: z
      .object({
        transactionNumber: z.string(),
        receivedCurrency: currencySchema,
        receivedAmountUnits: amountUnitsSchema,
        creditedUsdUnits: amountUnitsSchema,
        creditRateId: z.uuid().nullable(),
        creditRate: exchangeRateSchema.nullable(),
        /** Sham Cash only. */
        referenceCheck: depositReferenceCheckSchema.nullable(),
        journalId: z.uuid(),
      })
      .nullable(),
    rejection: z
      .object({ reason: depositRejectReasonSchema, customerNote: z.string().nullable() })
      .nullable(),
    /** Oldest first: the second one follows a clearer-receipt request. */
    receipts: z.array(z.object({ id: z.uuid(), createdAt: z.iso.datetime() })),
    flags: z.array(depositFlagSchema),
    customer: z.object({
      ...depositCustomer,
      phone: z.string(),
      createdAt: z.iso.datetime(),
      /** Rule SC3: one credited deposit makes an account established. */
      established: z.boolean(),
      creditedCount: z.int().nonnegative(),
      creditedTotalUsdUnits: amountUnitsSchema,
      balanceUnits: amountUnitsSchema,
      /** The customer's last 10 deposits, this one excluded, with their codes (edge case 16). */
      recentDeposits: z.array(
        z.object({
          id: z.uuid(),
          referenceCode: z.string(),
          status: depositStatusSchema,
          currency: currencySchema,
          declaredAmountUnits: amountUnitsSchema,
          createdAt: z.iso.datetime(),
        }),
      ),
    }),
    /** While `submitted`: what the customer is told (rule SC13). */
    eta: reviewEtaSchema.nullable(),
    /** USDT deposits only (S04). */
    usdt: adminDepositUsdtSchema.nullable(),
  })
  .meta({ id: 'AdminDeposit' });

export type AdminDeposit = z.infer<typeof adminDepositSchema>;

const internalNoteSchema = z.string().trim().min(5).max(500);
const depositCustomerNoteSchema = z.string().trim().min(1).max(300);

/** `POST /api/admin/deposits/:id/approve` (rules RV1–RV5, RV9). */
export const approveDepositSchema = z
  .object({
    /** From the store's Sham Cash account history, never from the image alone (rule RV1). */
    transactionNumber: z.string().trim().min(1).max(64),
    receivedCurrency: currencySchema,
    receivedAmountUnits: positiveUnitsSchema,
    referenceCheck: depositReferenceCheckSchema,
    /** Every submission flag and every approval-time flag of this request (rule RV5). */
    acknowledgedFlags: z.array(depositFlagCodeSchema).max(DEPOSIT_FLAG_CODES.length * 2),
    internalNote: z.string().trim().min(1).max(500).optional(),
  })
  .superRefine((input, context) => {
    if (!isWholeDepositAmount(input.receivedCurrency, input.receivedAmountUnits)) {
      context.addIssue({
        code: 'custom',
        path: ['receivedAmountUnits'],
        message:
          input.receivedCurrency === 'SYP' ? 'Expected whole pounds' : 'Expected whole cents',
      });
    }
  })
  .meta({ id: 'ApproveDeposit' });

export type ApproveDeposit = z.input<typeof approveDepositSchema>;

/**
 * `POST /api/admin/deposits/:id/approve-usdt` (S04 rule U15): the credit is the received amount
 * floored to whole cents, never typed; every flag must be acknowledged.
 */
export const approveUsdtDepositSchema = z
  .object({
    acknowledgedFlags: z.array(depositFlagCodeSchema).max(DEPOSIT_FLAG_CODES.length * 2),
    internalNote: z.string().trim().min(1).max(500).optional(),
  })
  .meta({ id: 'ApproveUsdtDeposit' });

export type ApproveUsdtDeposit = z.input<typeof approveUsdtDepositSchema>;

/** `POST /api/admin/deposits/:id/reject` (rule RV6). */
export const rejectDepositSchema = z
  .object({
    reason: depositRejectReasonSchema,
    /** Shown on the deposit page only, never in the email. Required for `other`. */
    customerNote: depositCustomerNoteSchema.optional(),
    /** The audit entry's reason. */
    internalNote: internalNoteSchema,
  })
  .superRefine((input, context) => {
    if (input.reason === 'other' && input.customerNote === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['customerNote'],
        message: 'Another reason needs a note for the customer',
      });
    }
  })
  .meta({ id: 'RejectDeposit' });

export type RejectDeposit = z.input<typeof rejectDepositSchema>;

/** `POST /api/admin/deposits/:id/request-receipt` (rule RV8). */
export const requestReceiptSchema = z
  .object({
    customerNote: depositCustomerNoteSchema.optional(),
    internalNote: internalNoteSchema,
  })
  .meta({ id: 'RequestReceipt' });

export type RequestReceipt = z.input<typeof requestReceiptSchema>;

/** Where a recorded USDT transfer stands (rule U13), derived, never stored. */
export const USDT_TRANSFER_STATES = ['credited', 'bound', 'unmatched'] as const;

export const usdtTransferStateSchema = z
  .enum(USDT_TRANSFER_STATES)
  .meta({ id: 'UsdtTransferState' });

export type UsdtTransferState = z.infer<typeof usdtTransferStateSchema>;

/** `GET /api/admin/usdt-transfers`: unmatched by default, newest first. */
export const adminUsdtTransferQuerySchema = cursorQuerySchema
  .extend({
    method: usdtMethodSchema.optional(),
    state: z.enum(['unmatched', 'all']).default('unmatched'),
  })
  .meta({ id: 'AdminUsdtTransferQuery' });

export type AdminUsdtTransferQuery = z.infer<typeof adminUsdtTransferQuerySchema>;

/** One transfer of the list (rule U13): its state, who holds it, and its candidates. */
export const adminUsdtTransferSchema = usdtTransferSchema
  .extend({
    state: usdtTransferStateSchema,
    /** The deposit bound to it, or the adjustment that claimed its TXID. */
    holder: z
      .object({
        kind: z.enum(['deposit', 'adjustment']),
        id: z.uuid(),
        customer: z.object({ id: z.uuid(), name: z.string(), email: z.string() }),
      })
      .nullable(),
    /** Unmatched only: reserved, expired or cancelled deposits it may belong to (U4, U11). */
    candidates: z.array(usdtCandidateSchema),
  })
  .meta({ id: 'AdminUsdtTransfer' });

export type AdminUsdtTransfer = z.infer<typeof adminUsdtTransferSchema>;

export const adminUsdtTransferPageSchema = cursorPageSchema(
  adminUsdtTransferSchema,
  'AdminUsdtTransferPage',
);

export type AdminUsdtTransferPage = z.infer<typeof adminUsdtTransferPageSchema>;
