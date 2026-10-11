import { z } from 'zod';
import { cursorPageSchema, cursorQuerySchema } from './lists.js';
import {
  amountUnitsSchema,
  CURRENCY_SCALE,
  type Currency,
  ceilToStep,
  currencySchema,
  exchangeRateSchema,
  isWholeCents,
  usdToSyp,
} from './money.js';
import { orderNumberSchema } from './orders.js';
import { type SupplierCode, supplierCodeSchema } from './suppliers.js';
import {
  ADJUSTMENT_CONFIRMATION_THRESHOLD_USD_UNITS,
  type JournalKind,
  type LedgerAccountKind,
} from './wallet.js';

/*
 * Treasury movements and the nightly reconciliation (S13, F20, ADR 0027), owned by the api
 * `treasury` and `reconciliation` modules: the store's money places and their ledger accounts, the
 * movements between them, the checks a run makes and what the panel shows of them.
 */

/* ---------------------------------------------------------------------------------------------
 * Places (rule T1)
 * ------------------------------------------------------------------------------------------- */

/** The store's money places and the outside (rule T1). A supplier place per supplier code. */
export const TREASURY_PLACES = [
  'sham_cash_syp',
  'sham_cash_usd',
  'usdt_trc20',
  'usdt_bep20',
  'supplier:shop2topup',
  'supplier:wdgzone',
  'supplier:manual',
  'supplier:fake',
  'outside_usd',
  'outside_syp',
] as const;

export const treasuryPlaceSchema = z.enum(TREASURY_PLACES).meta({ id: 'TreasuryPlace' });

export type TreasuryPlace = z.infer<typeof treasuryPlaceSchema>;

/**
 * Where a movement's money comes from or goes to: a place, or `supplier_corrections` (the counter
 * side of a supplier correction, rule T5), which is not a place.
 */
export const TREASURY_ENDPOINTS = [...TREASURY_PLACES, 'supplier_corrections'] as const;

export const treasuryEndpointSchema = z.enum(TREASURY_ENDPOINTS).meta({ id: 'TreasuryEndpoint' });

export type TreasuryEndpoint = z.infer<typeof treasuryEndpointSchema>;

export interface TreasuryAccount {
  code: string;
  kind: Exclude<LedgerAccountKind, 'customer_wallet'>;
  currency: Currency;
}

const account = (
  kind: TreasuryAccount['kind'],
  suffix: string,
  currency: Currency,
): TreasuryAccount => ({ code: `${kind}:${suffix}`, kind, currency });

/** Rule T1: each endpoint's ledger account. Accounts are created on first use. */
export const TREASURY_ACCOUNTS = {
  sham_cash_syp: account('sham_cash_receipts', 'SYP', 'SYP'),
  sham_cash_usd: account('sham_cash_receipts', 'USD', 'USD'),
  usdt_trc20: account('usdt_receipts', 'usdt_trc20', 'USD'),
  usdt_bep20: account('usdt_receipts', 'usdt_bep20', 'USD'),
  'supplier:shop2topup': account('supplier_prepaid', 'shop2topup', 'USD'),
  'supplier:wdgzone': account('supplier_prepaid', 'wdgzone', 'USD'),
  'supplier:manual': account('supplier_prepaid', 'manual', 'USD'),
  'supplier:fake': account('supplier_prepaid', 'fake', 'USD'),
  outside_usd: account('outside_funds', 'USD', 'USD'),
  outside_syp: account('outside_funds', 'SYP', 'SYP'),
  supplier_corrections: account('supplier_corrections', 'USD', 'USD'),
} as const satisfies Record<TreasuryEndpoint, TreasuryAccount>;

/** The endpoint of a ledger account code, or null when the account is none of them. */
export function treasuryEndpointOf(code: string): TreasuryEndpoint | null {
  for (const endpoint of TREASURY_ENDPOINTS) {
    if (TREASURY_ACCOUNTS[endpoint].code === code) return endpoint;
  }
  return null;
}

/** True for `outside_usd` and `outside_syp` (rule T4). */
export function isOutsidePlace(place: TreasuryEndpoint): boolean {
  return TREASURY_ACCOUNTS[place].kind === 'outside_funds';
}

/** The supplier of a supplier place, or null. */
export function supplierOfPlace(place: TreasuryEndpoint): SupplierCode | null {
  return place.startsWith('supplier:') ? (place.slice('supplier:'.length) as SupplierCode) : null;
}

/** The place of a supplier's prepaid balance. */
export function supplierPlace(supplier: SupplierCode): TreasuryPlace {
  return `supplier:${supplier}`;
}

/**
 * Rule T3: amounts are whole cents in USD places, except a supplier place (sub-cent, as supplier
 * balances are); SYP units are already hundredths of a pound.
 */
export function placeAmountValid(place: TreasuryPlace, units: number): boolean {
  if (!Number.isSafeInteger(units) || units <= 0) return false;
  const { currency } = TREASURY_ACCOUNTS[place];
  return currency === 'SYP' || supplierOfPlace(place) !== null || isWholeCents(units);
}

/* ---------------------------------------------------------------------------------------------
 * Movements (rules T2–T10, M1–M5)
 * ------------------------------------------------------------------------------------------- */

export const TREASURY_MOVEMENT_KINDS = ['transfer', 'supplier_correction'] as const;

export const treasuryMovementKindSchema = z
  .enum(TREASURY_MOVEMENT_KINDS)
  .meta({ id: 'TreasuryMovementKind' });

export type TreasuryMovementKind = z.infer<typeof treasuryMovementKindSchema>;

/** Rule T4: why money crossed the store's edge. */
export const OUTSIDE_CATEGORIES = [
  'owner',
  'unclaimed_receipt',
  'return_to_sender',
  'other',
] as const;

export const outsideCategorySchema = z.enum(OUTSIDE_CATEGORIES).meta({ id: 'OutsideCategory' });

export type OutsideCategory = z.infer<typeof outsideCategorySchema>;

/** Rule T5: `increase` when the supplier credited the store, `decrease` when it charged. */
export const SUPPLIER_CORRECTION_DIRECTIONS = ['increase', 'decrease'] as const;

export const supplierCorrectionDirectionSchema = z
  .enum(SUPPLIER_CORRECTION_DIRECTIONS)
  .meta({ id: 'SupplierCorrectionDirection' });

export type SupplierCorrectionDirection = z.infer<typeof supplierCorrectionDirectionSchema>;

/** The endpoints of a supplier correction (rules T5, M3): money flows `from` → `to`. */
export function correctionEndpoints(
  supplier: SupplierCode,
  direction: SupplierCorrectionDirection,
): { from: TreasuryEndpoint; to: TreasuryEndpoint } {
  const place = supplierPlace(supplier);
  return direction === 'increase'
    ? { from: 'supplier_corrections', to: place }
    : { from: place, to: 'supplier_corrections' };
}

/**
 * Rules T2 and T3, the refusals a valid request can still meet: the same place twice, outside to
 * outside, or more received than sent in one currency. Null when the movement may be recorded.
 */
export function treasuryMovementError(movement: {
  from: TreasuryPlace;
  to: TreasuryPlace;
  sentUnits: number;
  receivedUnits: number;
}): 'TREASURY_PLACES_INVALID' | 'MOVEMENT_RECEIVED_EXCEEDS_SENT' | null {
  if (
    movement.from === movement.to ||
    (isOutsidePlace(movement.from) && isOutsidePlace(movement.to))
  ) {
    return 'TREASURY_PLACES_INVALID';
  }
  const sameCurrency =
    TREASURY_ACCOUNTS[movement.from].currency === TREASURY_ACCOUNTS[movement.to].currency;
  return sameCurrency && movement.receivedUnits > movement.sentUnits
    ? 'MOVEMENT_RECEIVED_EXCEEDS_SENT'
    : null;
}

/** One posting a movement writes: the account and the signed amount (rules M1–M4). */
export interface TreasuryPosting extends TreasuryAccount {
  amountUnits: number;
}

/**
 * The postings of a movement (rules M1–M4). Money flows `from` → `to`: the source gets +sent, the
 * destination −received. Same currency: the difference is the fee on `transfer_fees`. Two
 * currencies: through `currency_exchange` in each. A reversal mirrors every sign (rule M4).
 */
export function treasuryPostings(movement: {
  from: TreasuryEndpoint;
  to: TreasuryEndpoint;
  sentUnits: number;
  receivedUnits: number;
  reversal: boolean;
}): TreasuryPosting[] {
  const from = TREASURY_ACCOUNTS[movement.from];
  const to = TREASURY_ACCOUNTS[movement.to];
  const postings: TreasuryPosting[] = [{ ...from, amountUnits: movement.sentUnits }];
  if (from.currency === to.currency) {
    const fee = movement.sentUnits - movement.receivedUnits;
    if (fee < 0) throw new RangeError('A same-currency movement cannot receive more than it sent');
    postings.push({ ...to, amountUnits: -movement.receivedUnits });
    if (fee > 0) {
      postings.push({
        ...account('transfer_fees', from.currency, from.currency),
        amountUnits: -fee,
      });
    }
  } else {
    postings.push(
      {
        ...account('currency_exchange', from.currency, from.currency),
        amountUnits: -movement.sentUnits,
      },
      {
        ...account('currency_exchange', to.currency, to.currency),
        amountUnits: movement.receivedUnits,
      },
      { ...to, amountUnits: -movement.receivedUnits },
    );
  }
  return movement.reversal
    ? postings.map((posting) => ({ ...posting, amountUnits: -posting.amountUnits }))
    : postings;
}

/**
 * Rule T7: a movement worth more than $100 needs its amount typed again. `sentUsdValueUnits` is
 * the sent amount in USD (SYP converted at today's rate), or null when no rate exists: then the
 * confirmation is required. A confirmation that was sent must equal the sent amount.
 */
export function treasuryConfirmationError(
  sentUnits: number,
  sentUsdValueUnits: number | null,
  confirmationUnits: number | undefined,
): 'AMOUNT_CONFIRMATION_REQUIRED' | 'AMOUNT_CONFIRMATION_MISMATCH' | null {
  if (confirmationUnits === undefined) {
    return sentUsdValueUnits === null ||
      sentUsdValueUnits > ADJUSTMENT_CONFIRMATION_THRESHOLD_USD_UNITS
      ? 'AMOUNT_CONFIRMATION_REQUIRED'
      : null;
  }
  return confirmationUnits === sentUnits ? null : 'AMOUNT_CONFIRMATION_MISMATCH';
}

const reasonSchema = z.string().trim().min(5).max(500);
const externalReferenceSchema = z.string().trim().min(1).max(100);
const positiveUnitsSchema = amountUnitsSchema.refine((units) => units > 0, 'Expected above zero');

/** `POST /api/admin/treasury/movements` (rules T2–T8). */
export const createTreasuryMovementSchema = z
  .object({
    from: treasuryPlaceSchema,
    to: treasuryPlaceSchema,
    /** In the source place's currency. */
    sentUnits: positiveUnitsSchema,
    /** In the destination place's currency. */
    receivedUnits: positiveUnitsSchema,
    /** Required when, and only when, one side is outside (rule T4). */
    outsideCategory: outsideCategorySchema.optional(),
    /** Rule T6: from outside, category `owner`, and only as a place's first movement. */
    openingBalance: z.boolean().default(false),
    externalReference: externalReferenceSchema.optional(),
    reason: reasonSchema,
    amountConfirmationUnits: amountUnitsSchema.optional(),
  })
  .superRefine((input, context) => {
    if (!placeAmountValid(input.from, input.sentUnits)) {
      context.addIssue({ code: 'custom', path: ['sentUnits'], message: 'Expected whole cents' });
    }
    if (!placeAmountValid(input.to, input.receivedUnits)) {
      context.addIssue({
        code: 'custom',
        path: ['receivedUnits'],
        message: 'Expected whole cents',
      });
    }
    const outside = isOutsidePlace(input.from) || isOutsidePlace(input.to);
    if (outside === (input.outsideCategory === undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['outsideCategory'],
        message: outside
          ? 'A movement to or from outside needs a category'
          : 'Only a movement to or from outside takes a category',
      });
    }
    if (
      input.openingBalance &&
      (!isOutsidePlace(input.from) || input.outsideCategory !== 'owner')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['openingBalance'],
        message: 'An opening balance comes from outside, category owner',
      });
    }
  })
  .meta({ id: 'CreateTreasuryMovement' });

export type CreateTreasuryMovement = z.input<typeof createTreasuryMovementSchema>;

/** `POST /api/admin/treasury/supplier-corrections` (rule T5). */
export const createSupplierCorrectionSchema = z
  .object({
    supplier: supplierCodeSchema,
    direction: supplierCorrectionDirectionSchema,
    /** USD units; sub-cent allowed, as supplier balances. */
    amountUnits: positiveUnitsSchema,
    orderNumber: orderNumberSchema.optional(),
    externalReference: externalReferenceSchema.optional(),
    reason: reasonSchema,
    amountConfirmationUnits: amountUnitsSchema.optional(),
  })
  .meta({ id: 'CreateSupplierCorrection' });

export type CreateSupplierCorrection = z.input<typeof createSupplierCorrectionSchema>;

/** `POST /api/admin/treasury/movements/:id/reverse` (rule T9). */
export const reverseTreasuryMovementSchema = z
  .object({ reason: reasonSchema, amountConfirmationUnits: amountUnitsSchema.optional() })
  .meta({ id: 'ReverseTreasuryMovement' });

export type ReverseTreasuryMovement = z.input<typeof reverseTreasuryMovementSchema>;

/** A movement as the panel shows it. */
export const treasuryMovementSchema = z
  .object({
    id: z.uuid(),
    kind: treasuryMovementKindSchema,
    from: treasuryEndpointSchema,
    to: treasuryEndpointSchema,
    sentUnits: amountUnitsSchema,
    sentCurrency: currencySchema,
    receivedUnits: amountUnitsSchema,
    receivedCurrency: currencySchema,
    /** Same currency: sent − received; null across currencies. */
    feeUnits: amountUnitsSchema.nullable(),
    /** Across currencies: SYP per USD implied (rule M2); null otherwise. */
    rate: exchangeRateSchema.nullable(),
    outsideCategory: outsideCategorySchema.nullable(),
    openingBalance: z.boolean(),
    order: z.object({ id: z.uuid(), number: z.string() }).nullable(),
    externalReference: z.string().nullable(),
    reason: z.string(),
    /** On a reversal: the movement it reverses (rule T9). */
    reversesMovementId: z.uuid().nullable(),
    /** The reversal of this movement, once reversed. */
    reversedByMovementId: z.uuid().nullable(),
    journalId: z.uuid(),
    adminName: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'TreasuryMovement' });

export type TreasuryMovement = z.infer<typeof treasuryMovementSchema>;

/** `GET /api/admin/treasury/movements`: newest first, optionally those touching one place. */
export const treasuryMovementQuerySchema = cursorQuerySchema
  .extend({ place: treasuryPlaceSchema.optional() })
  .meta({ id: 'TreasuryMovementQuery' });

export type TreasuryMovementQuery = z.infer<typeof treasuryMovementQuerySchema>;

export const treasuryMovementPageSchema = cursorPageSchema(
  treasuryMovementSchema,
  'TreasuryMovementPage',
);

export type TreasuryMovementPage = z.infer<typeof treasuryMovementPageSchema>;

/** Where a place's last outside balance came from. */
export const EXTERNAL_BALANCE_SOURCES = ['supplier', 'chain', 'count'] as const;

/** `GET /api/admin/treasury/places`: each place with its books and its last outside balance. */
export const moneyPlacesSchema = z
  .object({
    places: z.array(
      z.object({
        place: treasuryPlaceSchema,
        currency: currencySchema,
        /** Rule LS2: what the books say the place holds (outside places: brought in, net). */
        booksUnits: z.int(),
        /** The newest balance read or counted outside the books; null for none. */
        external: z
          .object({
            units: z.int(),
            at: z.iso.datetime(),
            source: z.enum(EXTERNAL_BALANCE_SOURCES),
          })
          .nullable(),
        /** external − books; null without an external balance. */
        differenceUnits: z.int().nullable(),
        /** Rule T6: true once an opening balance stands (not reversed). */
        openingRecorded: z.boolean(),
        /** Rule T6: the opening amount that makes the books match the external balance now. */
        proposedOpeningUnits: amountUnitsSchema.nullable(),
      }),
    ),
  })
  .meta({ id: 'MoneyPlaces' });

export type MoneyPlaces = z.infer<typeof moneyPlacesSchema>;

/* ---------------------------------------------------------------------------------------------
 * Reconciliation (rules RN1–RN9, C1–C9, E1–E6)
 * ------------------------------------------------------------------------------------------- */

/** Internal checks: exact, any difference is a mismatch (C1–C9). */
export const INTERNAL_CHECKS = [
  'journal_balance',
  'ledger_total',
  'wallet_non_negative',
  'account_journal_kinds',
  'attempt_cost',
  'order_purchase',
  'order_refund',
  'deposit_credit',
  'manual_journals',
] as const;

/** External checks against real balances (E2–E4), within a range and the tolerance (E1). */
export const EXTERNAL_CHECKS = ['supplier_balance', 'usdt_balance', 'sham_cash_count'] as const;

/** Warning checks (E5): `ok` or `warning`, never a mismatch. */
export const WARNING_CHECKS = ['count_stale', 'order_conflicts'] as const;

export const RECONCILIATION_CHECKS = [
  ...INTERNAL_CHECKS,
  ...EXTERNAL_CHECKS,
  ...WARNING_CHECKS,
] as const;

export const reconciliationCheckSchema = z
  .enum(RECONCILIATION_CHECKS)
  .meta({ id: 'ReconciliationCheck' });

export type ReconciliationCheck = z.infer<typeof reconciliationCheckSchema>;

export type InternalCheck = (typeof INTERNAL_CHECKS)[number];
export type ExternalCheck = (typeof EXTERNAL_CHECKS)[number];

export function isInternalCheck(check: ReconciliationCheck): check is InternalCheck {
  return (INTERNAL_CHECKS as readonly string[]).includes(check);
}

export const RECONCILIATION_RESULT_STATUSES = ['ok', 'mismatch', 'warning', 'skipped'] as const;

export const reconciliationResultStatusSchema = z
  .enum(RECONCILIATION_RESULT_STATUSES)
  .meta({ id: 'ReconciliationResultStatus' });

export type ReconciliationResultStatus = z.infer<typeof reconciliationResultStatusSchema>;

/**
 * Why an external check was skipped (rules E2, E5, RN4): `opening_missing` and `reader_failed`
 * are warnings; `currency_unsupported` is a supplier balance in another currency than USD.
 */
export const RECONCILIATION_SKIP_REASONS = [
  'opening_missing',
  'reader_failed',
  'currency_unsupported',
] as const;

export const reconciliationSkipReasonSchema = z
  .enum(RECONCILIATION_SKIP_REASONS)
  .meta({ id: 'ReconciliationSkipReason' });

export type ReconciliationSkipReason = z.infer<typeof reconciliationSkipReasonSchema>;

/** A skipped result counts as a warning (rule E5) unless its reason is the currency. */
export function isWarningResult(result: {
  status: ReconciliationResultStatus;
  reason: ReconciliationSkipReason | null;
}): boolean {
  return (
    result.status === 'warning' ||
    (result.status === 'skipped' && result.reason !== 'currency_unsupported')
  );
}

export const RECONCILIATION_RUN_TRIGGERS = ['schedule', 'manual', 'count'] as const;

export const reconciliationRunTriggerSchema = z
  .enum(RECONCILIATION_RUN_TRIGGERS)
  .meta({ id: 'ReconciliationRunTrigger' });

export type ReconciliationRunTrigger = z.infer<typeof reconciliationRunTriggerSchema>;

export const RECONCILIATION_RUN_STATUSES = ['running', 'finished', 'failed'] as const;

export const reconciliationRunStatusSchema = z
  .enum(RECONCILIATION_RUN_STATUSES)
  .meta({ id: 'ReconciliationRunStatus' });

export type ReconciliationRunStatus = z.infer<typeof reconciliationRunStatusSchema>;

/** The defaults and fixed times of the reconciliation (S13 data, rules RN1–RN5, E5, NT1). */
export const RECONCILIATION_DEFAULTS = {
  /** Rule E1: $1. */
  toleranceUsdUnits: 1 * CURRENCY_SCALE.USD,
  /** Rule E5: no Sham Cash count for more than this many days. */
  countStaleDays: 7,
} as const;

/** Rule RN4: an external result off its range is read again after this many minutes. */
export const RECONCILIATION_RECHECK_MINUTES = 10;
/** Rule RN1: the nightly run's cron, in `Asia/Damascus`. */
export const RECONCILIATION_CRON = '30 0 * * *';
/** Rule RN5: a run still `running` after this many minutes is marked failed by the next run. */
export const RECONCILIATION_STALE_RUN_MINUTES = 60;
/** Rule RN2: at most one manual run per this many seconds. */
export const RECONCILIATION_MANUAL_COOLDOWN_SECONDS = 5 * 60;
/** S13 data: the offending ids a result keeps, at most. */
export const RECONCILIATION_MAX_OFFENDING_IDS = 50;
/** Rule NT1: the lines of an alert, at most. */
export const RECONCILIATION_ALERT_MAX_LINES = 10;
/** Dashboard: no finished nightly run in this many hours is `reconciliation_missing`. */
export const RECONCILIATION_MISSING_HOURS = 26;
/** Settings bounds: tolerance up to $100 in whole cents, stale days 1–60. */
export const RECONCILIATION_MAX_TOLERANCE_USD_UNITS = 100 * CURRENCY_SCALE.USD;

/**
 * Rule E1: the SYP tolerance is the USD tolerance at today's rate, rounded up to whole pounds;
 * 0 without a rate.
 */
export function sypTolerance(toleranceUsdUnits: number, rate: string | null): number {
  if (rate === null) return 0;
  return ceilToStep(usdToSyp(toleranceUsdUnits, rate, 'up'), CURRENCY_SCALE.SYP);
}

/** Rule C4: the account kinds each journal kind may post to. */
export const JOURNAL_ACCOUNT_KINDS = {
  purchase: ['customer_wallet', 'sales_revenue'],
  refund: ['customer_wallet', 'refunds'],
  cost_of_goods: ['cost_of_goods', 'supplier_prepaid'],
  deposit: [
    'customer_wallet',
    'sham_cash_receipts',
    'currency_exchange',
    'usdt_receipts',
    'deposit_rounding',
  ],
  adjustment: ['customer_wallet', 'adjustments'],
  treasury: [
    'sham_cash_receipts',
    'usdt_receipts',
    'supplier_prepaid',
    'outside_funds',
    'transfer_fees',
    'currency_exchange',
    'supplier_corrections',
  ],
} as const satisfies Record<JournalKind, readonly LedgerAccountKind[]>;

/** What an offending id names, so the panel can link it. */
export const OFFENDING_KINDS = [
  'journal',
  'order',
  'attempt',
  'deposit',
  'adjustment',
  'movement',
  'transfer',
  'customer',
] as const;

export const offendingKindSchema = z.enum(OFFENDING_KINDS).meta({ id: 'OffendingKind' });

export type OffendingKind = z.infer<typeof offendingKindSchema>;

/** The money an external range allows for (rules E2–E4): what is in flight and why. */
export const EXPLANATION_LINE_KINDS = [
  'in_flight_attempt',
  'uncredited_transfer',
  'deposit_in_review',
] as const;

/** A result's details: never personal data (S13 data). */
export const reconciliationDetailsSchema = z
  .object({
    offending: z
      .array(z.object({ kind: offendingKindSchema, id: z.uuid() }))
      .max(RECONCILIATION_MAX_OFFENDING_IDS),
    lines: z
      .array(
        z.object({
          kind: z.enum(EXPLANATION_LINE_KINDS),
          id: z.uuid(),
          amountUnits: z.int(),
        }),
      )
      .max(RECONCILIATION_MAX_OFFENDING_IDS),
    reason: reconciliationSkipReasonSchema.nullable(),
  })
  .meta({ id: 'ReconciliationDetails' });

export type ReconciliationDetails = z.infer<typeof reconciliationDetailsSchema>;

export const reconciliationExplanationSchema = z
  .object({ note: z.string(), adminName: z.string().nullable(), createdAt: z.iso.datetime() })
  .meta({ id: 'ReconciliationExplanation' });

/** One check's result in a run. Amounts are in `currency`; null for checks without amounts. */
export const reconciliationResultSchema = z
  .object({
    id: z.uuid(),
    runId: z.uuid(),
    check: reconciliationCheckSchema,
    /** `ledger`, an account code, `supplier:<code>`, `usdt_trc20`, `sham_cash_syp` … */
    subject: z.string(),
    status: reconciliationResultStatusSchema,
    currency: currencySchema.nullable(),
    booksUnits: z.int().nullable(),
    actualUnits: z.int().nullable(),
    differenceUnits: z.int().nullable(),
    allowedLowUnits: z.int().nullable(),
    allowedHighUnits: z.int().nullable(),
    offendingCount: z.int().nonnegative(),
    details: reconciliationDetailsSchema,
    explanation: reconciliationExplanationSchema.nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'ReconciliationResult' });

export type ReconciliationResult = z.infer<typeof reconciliationResultSchema>;

export const reconciliationRunSchema = z
  .object({
    id: z.uuid(),
    trigger: reconciliationRunTriggerSchema,
    businessDate: z.iso.date().nullable(),
    status: reconciliationRunStatusSchema,
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
    mismatchCount: z.int().nonnegative(),
    warningCount: z.int().nonnegative(),
    recheckAt: z.iso.datetime().nullable(),
    failure: z.string().nullable(),
  })
  .meta({ id: 'ReconciliationRun' });

export type ReconciliationRun = z.infer<typeof reconciliationRunSchema>;

/** `GET /api/admin/reconciliation/runs/:id`, and the answer of a count. */
export const reconciliationRunDetailSchema = reconciliationRunSchema
  .extend({ results: z.array(reconciliationResultSchema) })
  .meta({ id: 'ReconciliationRunDetail' });

export type ReconciliationRunDetail = z.infer<typeof reconciliationRunDetailSchema>;

export const reconciliationRunQuerySchema = cursorQuerySchema
  .extend({ trigger: reconciliationRunTriggerSchema.optional() })
  .meta({ id: 'ReconciliationRunQuery' });

export type ReconciliationRunQuery = z.infer<typeof reconciliationRunQuerySchema>;

export const reconciliationRunPageSchema = cursorPageSchema(
  reconciliationRunSchema,
  'ReconciliationRunPage',
);

export type ReconciliationRunPage = z.infer<typeof reconciliationRunPageSchema>;

/** `PUT /api/admin/reconciliation/settings` and its read. */
export const reconciliationSettingsSchema = z
  .object({
    toleranceUsdUnits: amountUnitsSchema
      .max(RECONCILIATION_MAX_TOLERANCE_USD_UNITS)
      .refine(isWholeCents, 'Expected whole cents'),
    countStaleDays: z.int().min(1).max(60),
  })
  .meta({ id: 'ReconciliationSettings' });

export type ReconciliationSettings = z.infer<typeof reconciliationSettingsSchema>;

/** `POST /api/admin/reconciliation/results/:id/explanation` (rule RN8). */
export const explainResultSchema = z
  .object({ note: z.string().trim().min(5).max(500) })
  .meta({ id: 'ExplainResult' });

export type ExplainResult = z.infer<typeof explainResultSchema>;

/** `POST /api/admin/reconciliation/sham-cash-counts` (rules RN6, E4): what the app shows. */
export const shamCashCountSchema = z
  .object({ currency: currencySchema, countedUnits: amountUnitsSchema })
  .superRefine((input, context) => {
    if (input.currency === 'USD' && !isWholeCents(input.countedUnits)) {
      context.addIssue({ code: 'custom', path: ['countedUnits'], message: 'Expected whole cents' });
    }
  })
  .meta({ id: 'ShamCashCount' });

export type ShamCashCount = z.infer<typeof shamCashCountSchema>;

/** An open mismatch (rule RN7): the newest result of its check and subject, not explained. */
export const openMismatchSchema = reconciliationResultSchema
  .extend({
    /** When this check and subject started mismatching without a break. */
    firstSeenAt: z.iso.datetime(),
  })
  .meta({ id: 'OpenMismatch' });

export type OpenMismatch = z.infer<typeof openMismatchSchema>;

/** `GET /api/admin/reconciliation`. */
export const reconciliationOverviewSchema = z
  .object({
    /** The newest finished or failed nightly run; null before the first. */
    lastNightly: reconciliationRunSchema.nullable(),
    /** The newest finished or failed run of any trigger; null before the first. */
    lastRun: reconciliationRunSchema.nullable(),
    running: reconciliationRunSchema.nullable(),
    /** Internal checks first, then the newest first. */
    openMismatches: z.array(openMismatchSchema),
    /** The warnings of the newest finished run. */
    warnings: z.array(reconciliationResultSchema),
    /** The newest count per currency. */
    shamCashCounts: z.array(
      z.object({
        currency: currencySchema,
        countedUnits: amountUnitsSchema,
        at: z.iso.datetime(),
        status: reconciliationResultStatusSchema,
      }),
    ),
    settings: reconciliationSettingsSchema,
    /** Rule RN2: when the next manual run may start; null when it may start now. */
    manualAvailableAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'ReconciliationOverview' });

export type ReconciliationOverview = z.infer<typeof reconciliationOverviewSchema>;

/** `GET /api/admin/reconciliation/counts`: the navigation badge, open mismatches (rule RN7). */
export const reconciliationCountsSchema = z
  .object({ open: z.int().nonnegative() })
  .meta({ id: 'ReconciliationCounts' });

export type ReconciliationCounts = z.infer<typeof reconciliationCountsSchema>;
