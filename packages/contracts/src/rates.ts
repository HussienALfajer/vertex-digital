import { z } from 'zod';
import { cursorPageSchema } from './lists.js';
import { CURRENCY_SCALE, exchangeRateSchema, isSameRate, rateChangePercent } from './money.js';

/*
 * The admin's USD→SYP exchange rate (S03, F04; ADR 0003, 0017), owned by the api `rates`
 * module. One rate for display and SYP deposits (rule FX1); every change is a new row.
 */

/** A change above this percent of the current rate needs the rate typed twice (rule FX2). */
export const RATE_CONFIRMATION_THRESHOLD_PERCENT = 5;

/** The panel's banner shows while the newest rate is older than this (rule FX7). */
export const RATE_STALE_AFTER_HOURS = 48;

/** A SYP deposit's quote locks the rate for this long (rule FX5, A12). */
export const QUOTE_LOCK_MINUTES = 15;

/** The display step's bounds in SYP units: 1 to 50 pounds (rule FX3). */
export const DISPLAY_STEP_MIN_SYP_UNITS = 1 * CURRENCY_SCALE.SYP;
export const DISPLAY_STEP_MAX_SYP_UNITS = 50 * CURRENCY_SCALE.SYP;

/** The step SYP displays round to (rule FX3): whole pounds, 1 to 50. */
export const displayStepSchema = z
  .int()
  .min(DISPLAY_STEP_MIN_SYP_UNITS)
  .max(DISPLAY_STEP_MAX_SYP_UNITS)
  .refine((units) => units % CURRENCY_SCALE.SYP === 0, 'Expected whole pounds');

/** One saved rate, as the panel's history shows it. */
export const exchangeRateRecordSchema = z
  .object({
    id: z.uuid(),
    sypPerUsd: exchangeRateSchema,
    displayStepSypUnits: displayStepSchema,
    /** Against the rate before it (`rateChangePercent`); null for the first rate. */
    changePercent: z.string().nullable(),
    /** The admin who saved it; null once that admin account was replaced. */
    adminName: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'ExchangeRateRecord' });

export type ExchangeRateRecord = z.infer<typeof exchangeRateRecordSchema>;

/** `POST /api/admin/rates` (rules FX1–FX3). */
export const changeRateSchema = z
  .object({
    sypPerUsd: exchangeRateSchema,
    displayStepSypUnits: displayStepSchema,
    /** The rate typed a second time; required for a change above 5% (rule FX2). */
    rateConfirmation: z.string().trim().max(20).optional(),
  })
  .meta({ id: 'ChangeRate' });

export type ChangeRate = z.infer<typeof changeRateSchema>;

/**
 * The refusal of a rate change's typed confirmation (rule FX2), or null: the first rate and a
 * change of at most 5% need none; above 5% it is required and must equal the new rate.
 */
export function rateConfirmationError(
  currentRate: string | null,
  input: Pick<ChangeRate, 'sypPerUsd' | 'rateConfirmation'>,
): 'RATE_CONFIRMATION_REQUIRED' | 'RATE_CONFIRMATION_MISMATCH' | null {
  if (currentRate === null) return null;
  const percent = Math.abs(Number(rateChangePercent(currentRate, input.sypPerUsd)));
  if (percent <= RATE_CONFIRMATION_THRESHOLD_PERCENT) return null;
  if (input.rateConfirmation === undefined) return 'RATE_CONFIRMATION_REQUIRED';
  return isSameRate(input.rateConfirmation, input.sypPerUsd) ? null : 'RATE_CONFIRMATION_MISMATCH';
}

export const ratePageSchema = cursorPageSchema(exchangeRateRecordSchema, 'RatePage');

export type RatePage = z.infer<typeof ratePageSchema>;

/** `GET /api/admin/rates`: the current rate, whether it is stale (rule FX7), and the history. */
export const ratesOverviewSchema = z
  .object({
    current: exchangeRateRecordSchema.nullable(),
    /** No rate yet counts as stale. */
    stale: z.boolean(),
    history: ratePageSchema,
  })
  .meta({ id: 'RatesOverview' });

export type RatesOverview = z.infer<typeof ratesOverviewSchema>;

/** True when the newest rate is older than 48 hours at `now`, or there is none (rule FX7). */
export function isRateStale(createdAt: Date | null, now: Date): boolean {
  if (createdAt === null) return true;
  return now.getTime() - createdAt.getTime() > RATE_STALE_AFTER_HOURS * 60 * 60 * 1000;
}
