import { z } from 'zod';
import { cursorPageSchema, cursorQuerySchema } from './lists.js';
import {
  amountUnitsSchema,
  CURRENCY_SCALE,
  currencySchema,
  exchangeRateSchema,
  usdCentsSchema,
} from './money.js';

/**
 * Kinds of ledger account (ADR 0003): one USD wallet per customer, and the system accounts. A
 * customer wallet never goes negative; the system accounts may.
 */
export const LEDGER_ACCOUNT_KINDS = [
  'customer_wallet',
  'sham_cash_receipts',
  'usdt_receipts',
  'supplier_prepaid',
  'sales_revenue',
  'cost_of_goods',
  'refunds',
  'adjustments',
] as const;

export const ledgerAccountKindSchema = z
  .enum(LEDGER_ACCOUNT_KINDS)
  .meta({ id: 'LedgerAccountKind' });

export type LedgerAccountKind = z.infer<typeof ledgerAccountKindSchema>;

/** Kinds of money event, one journal each (ADR 0003, F03 timeline). */
export const JOURNAL_KINDS = [
  'deposit',
  'purchase',
  'refund',
  'cost_of_goods',
  'adjustment',
] as const;

export const journalKindSchema = z.enum(JOURNAL_KINDS).meta({ id: 'JournalKind' });

export type JournalKind = z.infer<typeof journalKindSchema>;

/*
 * The customer wallet (S02, F03), owned by the api `wallet` module: the balance and timeline the
 * customer sees, the admin's view of a wallet, and the admin's manual adjustments (rules J1–J10,
 * R1–R5) and ledger summary (rules L1, L2).
 */

/** Which way an adjustment moves money: `credit` adds to the wallet, `debit` takes from it. */
export const ADJUSTMENT_DIRECTIONS = ['credit', 'debit'] as const;

export const adjustmentDirectionSchema = z
  .enum(ADJUSTMENT_DIRECTIONS)
  .meta({ id: 'AdjustmentDirection' });

export type AdjustmentDirection = z.infer<typeof adjustmentDirectionSchema>;

export const ADJUSTMENT_CATEGORIES = [
  'compensation',
  'correction',
  'cash_refund',
  'manual_deposit',
  'test_funds',
] as const;

export const adjustmentCategorySchema = z
  .enum(ADJUSTMENT_CATEGORIES)
  .meta({ id: 'AdjustmentCategory' });

export type AdjustmentCategory = z.infer<typeof adjustmentCategorySchema>;

/**
 * The directions a new adjustment of each category may take (rule J1). A reversal always takes
 * the opposite of its original's direction (rule R1), whatever this table says.
 */
export const ADJUSTMENT_CATEGORY_DIRECTIONS = {
  compensation: ['credit'],
  correction: ['credit', 'debit'],
  cash_refund: ['debit'],
  manual_deposit: ['credit'],
  test_funds: ['credit', 'debit'],
} as const satisfies Record<AdjustmentCategory, readonly AdjustmentDirection[]>;

/** True when a new adjustment of `category` may move money in `direction` (rule J1). */
export function isAllowedAdjustment(
  category: AdjustmentCategory,
  direction: AdjustmentDirection,
): boolean {
  return (ADJUSTMENT_CATEGORY_DIRECTIONS[category] as readonly AdjustmentDirection[]).includes(
    direction,
  );
}

/** How a payment recorded by hand reached the store (rule J8). */
export const MANUAL_DEPOSIT_METHODS = ['sham_cash', 'usdt_trc20', 'usdt_bep20'] as const;

export const manualDepositMethodSchema = z
  .enum(MANUAL_DEPOSIT_METHODS)
  .meta({ id: 'ManualDepositMethod' });

export type ManualDepositMethod = z.infer<typeof manualDepositMethodSchema>;

/** Adjustments above $100 need the amount typed twice (rule J6); exactly $100 does not. */
export const ADJUSTMENT_CONFIRMATION_THRESHOLD_USD_UNITS = 100 * CURRENCY_SCALE.USD;

/**
 * The refusal of an adjustment's typed confirmation (rule J6, edge case 10), or null: above the
 * threshold the confirmation is required and must equal the amount; below it, a confirmation
 * that was sent must still equal the amount.
 */
export function amountConfirmationError(
  amountUnits: number,
  confirmationUnits: number | undefined,
): 'AMOUNT_CONFIRMATION_REQUIRED' | 'AMOUNT_CONFIRMATION_MISMATCH' | null {
  if (confirmationUnits === undefined) {
    return amountUnits > ADJUSTMENT_CONFIRMATION_THRESHOLD_USD_UNITS
      ? 'AMOUNT_CONFIRMATION_REQUIRED'
      : null;
  }
  return confirmationUnits === amountUnits ? null : 'AMOUNT_CONFIRMATION_MISMATCH';
}

/** An adjustment amount: whole cents above zero (rule J10). */
export const adjustmentAmountSchema = usdCentsSchema.refine(
  (units) => units > 0,
  'Expected an amount above zero',
);

const reasonSchema = z.string().trim().min(5).max(500);
const customerNoteSchema = z.string().trim().min(1).max(200);

/** `POST /api/admin/wallets/:customerId/adjustments` (rules J1, J6, J8, J10). */
export const createAdjustmentSchema = z
  .object({
    direction: adjustmentDirectionSchema,
    amountUnits: adjustmentAmountSchema,
    /** The amount typed a second time; required above the threshold (rule J6). */
    amountConfirmationUnits: amountUnitsSchema.optional(),
    category: adjustmentCategorySchema,
    /** Internal: never shown to the customer; also the audit entry's reason. */
    reason: reasonSchema,
    /** Shown to the customer on the timeline. */
    customerNote: customerNoteSchema.optional(),
    /** `manual_deposit` only, and then required (rule J8). */
    depositMethod: manualDepositMethodSchema.optional(),
    /** The Sham Cash transaction number or the TXID; with `depositMethod` only. */
    externalReference: z.string().trim().min(1).max(100).optional(),
  })
  .superRefine((input, context) => {
    if (!isAllowedAdjustment(input.category, input.direction)) {
      context.addIssue({
        code: 'custom',
        path: ['direction'],
        message: `A ${input.category} adjustment cannot be a ${input.direction}`,
      });
    }
    const manual = input.category === 'manual_deposit';
    for (const key of ['depositMethod', 'externalReference'] as const) {
      if (manual === (input[key] === undefined)) {
        context.addIssue({
          code: 'custom',
          path: [key],
          message: manual ? `A manual deposit needs ${key}` : `Only a manual deposit takes ${key}`,
        });
      }
    }
  })
  .meta({ id: 'CreateAdjustment' });

export type CreateAdjustment = z.input<typeof createAdjustmentSchema>;

/** `POST /api/admin/wallet-adjustments/:id/reverse` (rules R1–R5). */
export const reverseAdjustmentSchema = z
  .object({
    reason: reasonSchema,
    customerNote: customerNoteSchema.optional(),
    amountConfirmationUnits: amountUnitsSchema.optional(),
  })
  .meta({ id: 'ReverseAdjustment' });

export type ReverseAdjustment = z.input<typeof reverseAdjustmentSchema>;

/** An adjustment as written, with the wallet's balance right after its journal. */
export const adjustmentSchema = z
  .object({
    id: z.uuid(),
    customerId: z.uuid(),
    direction: adjustmentDirectionSchema,
    amountUnits: amountUnitsSchema,
    category: adjustmentCategorySchema,
    reason: z.string(),
    customerNote: z.string().nullable(),
    depositMethod: manualDepositMethodSchema.nullable(),
    externalReference: z.string().nullable(),
    /** Set on a reversal: the adjustment it reverses. */
    reversesAdjustmentId: z.uuid().nullable(),
    journalId: z.uuid(),
    createdAt: z.iso.datetime(),
    balanceAfterUnits: amountUnitsSchema,
  })
  .meta({ id: 'Adjustment' });

export type Adjustment = z.infer<typeof adjustmentSchema>;

/**
 * A wallet's balance (rules W2, W9). `syp` is the balance's value in Syrian pounds at today's
 * rate, rounded down (`walletSypValue`); null until a rate exists (S03).
 */
export const walletSchema = z
  .object({
    balanceUnits: amountUnitsSchema,
    syp: z.object({ valueUnits: amountUnitsSchema, rate: exchangeRateSchema }).nullable(),
  })
  .meta({ id: 'Wallet' });

export type Wallet = z.infer<typeof walletSchema>;

const timelineEntry = {
  occurredAt: z.iso.datetime(),
  kind: journalKindSchema,
  /** The net signed amount the journal moved on the wallet (rule W3). */
  amountUnits: z.int(),
  /** The wallet's balance right after this entry (rule W4). */
  balanceAfterUnits: amountUnitsSchema,
};

/** What the customer sees of an adjustment (rules W5, W6): never the reason or the admin. */
const walletAdjustmentExtras = z.object({
  category: adjustmentCategorySchema,
  customerNote: z.string().nullable(),
  reversal: z.boolean(),
});

/** One timeline entry as the customer sees it: no journal id, account or internal reason. */
export const walletEntrySchema = z
  .object({ ...timelineEntry, adjustment: walletAdjustmentExtras.nullable() })
  .meta({ id: 'WalletEntry' });

export type WalletEntry = z.infer<typeof walletEntrySchema>;

/** The timeline query (rule W7): 30 entries by default. */
export const walletEntryQuerySchema = cursorQuerySchema
  .extend({ limit: z.coerce.number().int().min(1).max(100).default(30) })
  .meta({ id: 'WalletEntryQuery' });

export type WalletEntryQuery = z.infer<typeof walletEntryQuerySchema>;

export const walletEntryPageSchema = cursorPageSchema(walletEntrySchema, 'WalletEntryPage');

export type WalletEntryPage = z.infer<typeof walletEntryPageSchema>;

/** One timeline entry as the admin sees it, with the adjustment's internal details. */
export const adminWalletEntrySchema = z
  .object({
    ...timelineEntry,
    journalId: z.uuid(),
    adjustment: walletAdjustmentExtras
      .extend({
        id: z.uuid(),
        direction: adjustmentDirectionSchema,
        reason: z.string(),
        adminName: z.string().nullable(),
        depositMethod: manualDepositMethodSchema.nullable(),
        externalReference: z.string().nullable(),
        /** On a reversal: the adjustment it reverses. */
        reversesAdjustmentId: z.uuid().nullable(),
        /** The reversal of this adjustment, once reversed (rule R2). */
        reversedByAdjustmentId: z.uuid().nullable(),
      })
      .nullable(),
  })
  .meta({ id: 'AdminWalletEntry' });

export type AdminWalletEntry = z.infer<typeof adminWalletEntrySchema>;

export const adminWalletEntryPageSchema = cursorPageSchema(
  adminWalletEntrySchema,
  'AdminWalletEntryPage',
);

export type AdminWalletEntryPage = z.infer<typeof adminWalletEntryPageSchema>;

/** The customer a wallet belongs to, as the admin wallet screens show them. */
export const walletCustomerSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    email: z.string(),
    phone: z.string(),
    isTest: z.boolean(),
  })
  .meta({ id: 'WalletCustomer' });

export type WalletCustomer = z.infer<typeof walletCustomerSchema>;

/** `GET /api/admin/wallets`: email or phone prefix, or part of the name; 3 characters at least. */
export const walletSearchQuerySchema = cursorQuerySchema
  .extend({ q: z.string().trim().min(3).max(100) })
  .meta({ id: 'WalletSearchQuery' });

export type WalletSearchQuery = z.infer<typeof walletSearchQuerySchema>;

export const walletSearchResultSchema = walletCustomerSchema
  .extend({ balanceUnits: amountUnitsSchema })
  .meta({ id: 'WalletSearchResult' });

export type WalletSearchResult = z.infer<typeof walletSearchResultSchema>;

export const walletSearchPageSchema = cursorPageSchema(
  walletSearchResultSchema,
  'WalletSearchPage',
);

export type WalletSearchPage = z.infer<typeof walletSearchPageSchema>;

/** `GET /api/admin/wallets/:customerId`. */
export const adminWalletSchema = walletSchema
  .extend({ customer: walletCustomerSchema, adjustmentCount: z.int().nonnegative() })
  .meta({ id: 'AdminWallet' });

export type AdminWallet = z.infer<typeof adminWalletSchema>;

/** A system account and its balance; system accounts may be negative (ADR 0003). */
export const systemAccountBalanceSchema = z
  .object({
    kind: ledgerAccountKindSchema,
    code: z.string(),
    currency: currencySchema,
    balanceUnits: z.int(),
  })
  .meta({ id: 'SystemAccountBalance' });

/** `GET /api/admin/ledger/summary` (rule L1): what the store owes its customers. */
export const ledgerSummarySchema = z
  .object({
    owedToCustomersUnits: amountUnitsSchema,
    owedToTestCustomersUnits: amountUnitsSchema,
    walletsWithBalance: z.int().nonnegative(),
    systemAccounts: z.array(systemAccountBalanceSchema),
  })
  .meta({ id: 'LedgerSummary' });

export type LedgerSummary = z.infer<typeof ledgerSummarySchema>;
