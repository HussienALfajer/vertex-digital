import { z } from 'zod';
import { depositMethodSchema, zoneDayStart } from './deposits.js';
import { exchangeRateSchema } from './money.js';
import { supplierCodeSchema, supplierHealthStateSchema, syncRunStatusSchema } from './suppliers.js';

/*
 * The admin panel's home page (S11, F18), owned by the api `dashboard` read module: today against
 * yesterday at the same hour in Damascus, the live counts, deposits, suppliers, the rate and what
 * needs the admin. Money is USD units (ADR 0003); it reads and writes nothing of its own.
 */

/** The days of the sales line (rule DB3): the last 6 full days and today. */
export const SALES_LINE_DAYS = 7;

export interface DayBounds {
  todayStart: Date;
  /** Yesterday at the clock time of `now` (rule DB1). */
  sameTimeYesterday: Date;
  yesterdayStart: Date;
  /** The starts of the last `SALES_LINE_DAYS` days, oldest first, today last. */
  days: Date[];
}

/** Rule DB1: the `Asia/Damascus` calendar days around `now`. */
export function damascusDayBounds(now: Date): DayBounds {
  const todayStart = zoneDayStart(now);
  const yesterdayStart = zoneDayStart(now, 1);
  const elapsed = now.getTime() - todayStart.getTime();
  return {
    todayStart,
    sameTimeYesterday: new Date(Math.min(yesterdayStart.getTime() + elapsed, todayStart.getTime())),
    yesterdayStart,
    days: Array.from({ length: SALES_LINE_DAYS }, (_, index) =>
      zoneDayStart(now, SALES_LINE_DAYS - 1 - index),
    ),
  };
}

/** Rule DB2: today's change against yesterday in percent, one decimal; null when yesterday is 0. */
export function deltaPercent(today: number, yesterday: number): number | null {
  if (yesterday === 0) return null;
  return Math.round(((today - yesterday) * 1000) / Math.abs(yesterday)) / 10;
}

/** Rule DB2: profit ÷ sales in percent, one decimal; null when there were no sales. */
export function marginPercent(profitUsdUnits: number, salesUsdUnits: number): number | null {
  if (salesUsdUnits === 0) return null;
  return Math.round((profitUsdUnits * 1000) / salesUsdUnits) / 10;
}

/** What the attention list may hold, in its order (rule DB6). */
export const ATTENTION_KINDS = [
  'orders_review',
  'orders_manual',
  'deposits_overdue',
  'deposits_flagged',
  'usdt_unmatched',
  'supplier_down',
  'supplier_degraded',
  'supplier_balance_low',
  'supplier_sync_failing',
  'validation_quota_reached',
  'price_reviews',
  'rate_stale',
  'switches_active',
  'order_conflicts',
  'telegram_unlinked',
] as const;

export const attentionKindSchema = z.enum(ATTENTION_KINDS).meta({ id: 'AttentionKind' });

export type AttentionKind = z.infer<typeof attentionKindSchema>;

/** One line of "يحتاج انتباهك" (rule DB6): hidden at zero. */
export const attentionItemSchema = z
  .object({
    kind: attentionKindSchema,
    count: z.int().positive(),
    oldestAt: z.iso.datetime().nullable(),
    /** The panel path the line links to. */
    target: z.string(),
    /** What the sentence names: a supplier's code and name, a switch. */
    params: z.record(z.string(), z.string()),
    /** `order_conflicts`: the newest five orders, each linked to its page. */
    orders: z.array(z.object({ id: z.uuid(), number: z.string() })),
  })
  .meta({ id: 'AttentionItem' });

export type AttentionItem = z.infer<typeof attentionItemSchema>;

/** A number today, yesterday to the same hour, and the change (rule DB2). */
const comparedSchema = z.object({
  today: z.int(),
  yesterday: z.int(),
  deltaPercent: z.number().nullable(),
});

export type Compared = z.infer<typeof comparedSchema>;

export function compared(today: number, yesterday: number): Compared {
  return { today, yesterday, deltaPercent: deltaPercent(today, yesterday) };
}

const countSchema = z.int().nonnegative();

/** `GET /api/admin/dashboard` (rules DB1–DB8). */
export const dashboardSchema = z
  .object({
    generatedAt: z.iso.datetime(),
    /** Real customers only (rule DB1). */
    sales: comparedSchema,
    profit: comparedSchema,
    /** Today's profit ÷ sales; null without sales. */
    marginPercent: z.number().nullable(),
    delivered: comparedSchema,
    refunds: comparedSchema,
    refundedUsd: comparedSchema,
    /** Today's median delivery time (nearest rank); null without deliveries. */
    medianDeliveryMs: z.int().nonnegative().nullable(),
    /** Rule DB3: oldest first, today last. */
    salesLine: z.array(z.object({ date: z.iso.date(), salesUsdUnits: z.int().nonnegative() })),
    /** Rule DB4: test orders included in the counts, not in the value. */
    now: z.object({
      atSupplier: countSchema,
      manual: countSchema,
      review: countSchema,
      finished: countSchema,
      awaitingBalance: countSchema,
      openValueUsdUnits: z.int().nonnegative(),
    }),
    /** Rule DB5. */
    deposits: z.object({
      shamCashWaiting: countSchema,
      shamCashOldestAt: z.iso.datetime().nullable(),
      shamCashFlagged: countSchema,
      usdtWaiting: countSchema,
      unmatchedTransfers: countSchema,
      creditedToday: z.array(
        z.object({
          method: depositMethodSchema,
          count: countSchema,
          usdUnits: z.int().nonnegative(),
        }),
      ),
    }),
    /** Rule DB7: unarchived suppliers. */
    suppliers: z.array(
      z.object({
        code: supplierCodeSchema,
        nameAr: z.string(),
        health: supplierHealthStateSchema,
        healthSince: z.iso.datetime().nullable(),
        paused: z.boolean(),
        /** The newest balance in USD units and when it was read; null for none or `manual`. */
        balanceUsdUnits: z.int().nullable(),
        balanceAt: z.iso.datetime().nullable(),
        lowBalanceUsdUnits: z.int().nonnegative(),
        balanceLow: z.boolean(),
        lastSync: z.object({ status: syncRunStatusSchema, at: z.iso.datetime() }).nullable(),
      }),
    ),
    /** Rule DB8: null before any rate. */
    rate: z
      .object({ sypPerUsd: exchangeRateSchema, setAt: z.iso.datetime(), stale: z.boolean() })
      .nullable(),
    attention: z.array(attentionItemSchema),
  })
  .meta({ id: 'Dashboard' });

export type Dashboard = z.infer<typeof dashboardSchema>;
