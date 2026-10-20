import { z } from 'zod';
import { depositMethodSchema } from './deposits.js';
import { currencySchema } from './money.js';
import { refundReasonSchema } from './orders.js';
import { treasuryPlaceSchema } from './reconciliation.js';
import { supplierCodeSchema } from './suppliers.js';
import { adjustmentCategorySchema } from './wallet.js';

/*
 * Reports (S13, F22, ADR 0025, 0027), owned by the api `reports` read module: sales and profit by
 * delivery as the dashboard, breakdowns, deposits, refunds and failures, top customers and the
 * ledger's money movement, by `Asia/Damascus` day. Money is USD units (ADR 0003); costs and
 * profits keep sub-cent precision. Never a phone number, player id, address or code.
 */

export const REPORT_KINDS = [
  'sales',
  'breakdown',
  'deposits',
  'refunds',
  'customers',
  'ledger',
] as const;

export const reportKindSchema = z.enum(REPORT_KINDS).meta({ id: 'ReportKind' });

export type ReportKind = z.infer<typeof reportKindSchema>;

/** S20: `price_list` by the list orders were charged at, `merchant` by merchant account. */
export const REPORT_BREAKDOWNS = ['game', 'product', 'supplier', 'price_list', 'merchant'] as const;

export const reportBreakdownSchema = z.enum(REPORT_BREAKDOWNS).meta({ id: 'ReportBreakdown' });

export type ReportBreakdown = z.infer<typeof reportBreakdownSchema>;

/** Rule RP1: a period covers at most this many days. */
export const REPORT_MAX_DAYS = 366;

/** Rule RP7: the top customers listed. */
export const TOP_CUSTOMERS_LIMIT = 50;

/** Rule X4: exports per minute, at most. */
export const REPORT_EXPORTS_PER_MINUTE = 10;

/** `GET /api/admin/reports/:kind` and its export (rule RP1): `Asia/Damascus` dates, inclusive. */
export const reportQuerySchema = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    /** `breakdown` only; `game` when left out. */
    by: reportBreakdownSchema.optional(),
  })
  .meta({ id: 'ReportQuery' });

export type ReportQuery = z.infer<typeof reportQuerySchema>;

const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;

/** The days a period covers, both ends included. */
export function reportPeriodDays(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from) + 1;
}

/** Rule RP1: `REPORT_PERIOD_INVALID` when `to` is before `from` or the period is too long. */
export function reportPeriodError(from: string, to: string): 'REPORT_PERIOD_INVALID' | null {
  const days = reportPeriodDays(from, to);
  return days >= 1 && days <= REPORT_MAX_DAYS ? null : 'REPORT_PERIOD_INVALID';
}

const units = z.int();
const count = z.int().nonnegative();
const percent = z.number().nullable();

const period = {
  from: z.iso.date(),
  to: z.iso.date(),
  generatedAt: z.iso.datetime(),
};

/** Rule RP3: the dashboard's figures (ADR 0025). */
const salesFigures = {
  /** Orders finished `delivered` or `partially_refunded`. */
  delivered: count,
  salesUsdUnits: units,
  costUsdUnits: units,
  profitUsdUnits: units,
  /** Profit ÷ sales, one decimal; null without sales. */
  marginPercent: percent,
};

/**
 * S16 AP14: owner-funded admin orders, left out of the rows and totals and shown on their own line
 * "طلبات من مال المالك" (sales here is their value at store prices).
 */
const ownerFunded = { ownerFunded: z.object(salesFigures) };

/** R1 (rule RP3). */
export const salesReportSchema = z
  .object({
    ...period,
    rows: z.array(z.object({ date: z.iso.date(), ...salesFigures })),
    totals: z.object(salesFigures),
    ...ownerFunded,
  })
  .meta({ id: 'SalesReport' });

export type SalesReport = z.infer<typeof salesReportSchema>;

const breakdownFigures = {
  ...salesFigures,
  deliveredUnits: count,
  /** `supplier` only (rule RP4): attempts sent, failed, and failed ÷ resolved. */
  attemptsSent: count.nullable(),
  attemptsFailed: count.nullable(),
  failureRatePercent: percent,
};

/** R2 (rule RP4): sorted by sales, descending. */
export const breakdownReportSchema = z
  .object({
    ...period,
    by: reportBreakdownSchema,
    rows: z.array(
      z.object({
        /** A game, product, price list or customer id, or a supplier code. */
        key: z.string(),
        nameAr: z.string(),
        /** `product` only: its game. */
        gameNameAr: z.string().nullable(),
        /** `game` and `product`: the id to link to the catalog. */
        gameId: z.uuid().nullable(),
        supplier: supplierCodeSchema.nullable(),
        ...breakdownFigures,
      }),
    ),
    totals: z.object(breakdownFigures),
    ...ownerFunded,
  })
  .meta({ id: 'BreakdownReport' });

export type BreakdownReport = z.infer<typeof breakdownReportSchema>;

const depositFigures = {
  credited: count,
  creditedUsdUnits: units,
  rejected: count,
  expired: count,
};

/** R3 (rule RP5). */
export const depositsReportSchema = z
  .object({
    ...period,
    rows: z.array(
      z.object({
        method: depositMethodSchema,
        ...depositFigures,
        /** Sham Cash: the pounds received by SYP deposits. */
        receivedSypUnits: units.nullable(),
        /** Sham Cash: the median minutes from submission to decision; null without one. */
        medianReviewMinutes: z.number().nullable(),
      }),
    ),
    /** `manual_deposit` adjustments, net of their reversals (S02 J8). */
    manualDeposits: z.object({ count, usdUnits: units }),
    totals: z.object(depositFigures),
  })
  .meta({ id: 'DepositsReport' });

export type DepositsReport = z.infer<typeof depositsReportSchema>;

/** R4 (rule RP6). */
export const refundsReportSchema = z
  .object({
    ...period,
    byReason: z.array(
      z.object({
        reason: refundReasonSchema,
        /** `refunded` or `partially_refunded` orders. */
        orders: count,
        usdUnits: units,
      }),
    ),
    products: z.array(
      z.object({
        productId: z.uuid(),
        nameAr: z.string(),
        gameNameAr: z.string(),
        gameId: z.uuid(),
        finished: count,
        refunded: count,
        refundRatePercent: percent,
      }),
    ),
    suppliers: z.array(
      z.object({
        supplier: supplierCodeSchema,
        nameAr: z.string(),
        resolved: count,
        failed: count,
        failureRatePercent: percent,
      }),
    ),
    totals: z.object({ orders: count, usdUnits: units }),
  })
  .meta({ id: 'RefundsReport' });

export type RefundsReport = z.infer<typeof refundsReportSchema>;

const customerFigures = {
  delivered: count,
  salesUsdUnits: units,
  profitUsdUnits: units,
  depositsUsdUnits: units,
};

/** R5 (rule RP7): name and email only. */
export const customersReportSchema = z
  .object({
    ...period,
    rows: z.array(
      z.object({ customerId: z.uuid(), name: z.string(), email: z.string(), ...customerFigures }),
    ),
    totals: z.object(customerFigures),
  })
  .meta({ id: 'CustomersReport' });

export type CustomersReport = z.infer<typeof customersReportSchema>;

/**
 * The lines of R6 (rule RP8). Amounts are what moved, positive; `supplier_correction` is signed
 * (an increase positive). `detail` names the deposit method or the adjustment category.
 */
export const LEDGER_REPORT_LINES = [
  'deposit',
  'purchase',
  'refund',
  'cost_of_goods',
  'adjustment_credit',
  'adjustment_debit',
  /** A place to a supplier. */
  'treasury_funding',
  /** A place to outside. */
  'treasury_withdrawal',
  /** Outside to a place. */
  'treasury_injection',
  /** Any other place to place. */
  'treasury_transfer',
  'transfer_fee',
  'supplier_correction',
  'rounding_gain',
  /** S16 AM2, AM3: owner-funded orders paid, and their refunds back to owner drawings. */
  'owner_drawing',
  'owner_drawing_refund',
] as const;

export const ledgerReportLineSchema = z.enum(LEDGER_REPORT_LINES).meta({ id: 'LedgerReportLine' });

export type LedgerReportLine = z.infer<typeof ledgerReportLineSchema>;

const ledgerLine = {
  line: ledgerReportLineSchema,
  detail: z.union([depositMethodSchema, adjustmentCategorySchema]).nullable(),
  /** Real customers, or everything for lines that touch no wallet; USD units. */
  usdUnits: units,
  /** Test customers' share of a line that touches a wallet; null for the others. */
  testUsdUnits: units.nullable(),
};

/** R6 (rule RP8): the ledger by journal time, and each place at the start and the end. */
export const ledgerReportSchema = z
  .object({
    ...period,
    rows: z.array(z.object({ date: z.iso.date(), ...ledgerLine })),
    totals: z.array(z.object(ledgerLine)),
    places: z.array(
      z.object({
        place: treasuryPlaceSchema,
        currency: currencySchema,
        startUnits: units,
        endUnits: units,
      }),
    ),
    /** S16: what the owner took in goods (owner drawings, held), at the start and the end. */
    ownerDrawings: z.object({ startUnits: units, endUnits: units }),
  })
  .meta({ id: 'LedgerReport' });

export type LedgerReport = z.infer<typeof ledgerReportSchema>;

export const REPORT_SCHEMAS = {
  sales: salesReportSchema,
  breakdown: breakdownReportSchema,
  deposits: depositsReportSchema,
  refunds: refundsReportSchema,
  customers: customersReportSchema,
  ledger: ledgerReportSchema,
} as const satisfies Record<ReportKind, z.ZodType>;

export type Report<Kind extends ReportKind> = z.infer<(typeof REPORT_SCHEMAS)[Kind]>;
