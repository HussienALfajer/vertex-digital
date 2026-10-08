import { z } from 'zod';

/**
 * Currencies of the ledger (ADR 0003). USD is the base currency; `SYP` is the new Syrian pound.
 * USDT is credited 1:1 as USD (ADR 0006), so it is not a ledger currency.
 */
export const CURRENCIES = ['USD', 'SYP'] as const;

export const currencySchema = z.enum(CURRENCIES).meta({ id: 'Currency' });

export type Currency = z.infer<typeof currencySchema>;

/**
 * Integer units per whole currency unit (ADR 0003): USD in micro-dollars, so supplier costs keep
 * their sub-cent precision; SYP with 2 decimals. Every amount is an integer number of units.
 */
export const CURRENCY_SCALE = { USD: 1_000_000, SYP: 100 } as const satisfies Record<
  Currency,
  number
>;

/** One US cent in USD units. Customer-facing USD amounts are whole cents (ADR 0003). */
export const USD_CENT = 10_000;

/** A non-negative amount in integer units of its currency. */
export const amountUnitsSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** A customer-facing USD amount (a price, a deposit credit): USD units in whole cents. */
export const usdCentsSchema = amountUnitsSchema.refine(isWholeCents, 'Expected whole cents');

/** True when `units` is a safe integer number of USD units in whole cents (either sign). */
export function isWholeCents(units: number): boolean {
  return Number.isSafeInteger(units) && units % USD_CENT === 0;
}

const RATE_PATTERN = /^\d{1,8}(\.\d{1,4})?$/;

/** Rates carry up to 4 decimals, so a rate × 10⁴ is an exact integer. */
const RATE_FACTOR = 10_000n;

/**
 * An exchange rate: Syrian pounds per 1 US dollar, above 0, up to 4 decimals, carried as an exact
 * decimal string (`"118.5"`) and stored as `numeric` (ADR 0003). Convert amounts only with
 * `usdToSyp` and `sypToUsd`.
 */
export const exchangeRateSchema = z
  .string()
  .trim()
  .refine((rate) => parseRate(rate) !== null, 'Expected SYP per USD above 0, up to 4 decimals')
  .meta({ id: 'ExchangeRate' });

export type ExchangeRate = z.infer<typeof exchangeRateSchema>;

/** The rate × 10⁴, or null when `rate` is not a valid rate. */
function parseRate(rate: string): bigint | null {
  if (!RATE_PATTERN.test(rate)) return null;
  const dot = rate.indexOf('.');
  const decimals = dot === -1 ? 0 : rate.length - dot - 1;
  const value = BigInt(rate.replace('.', '')) * 10n ** BigInt(4 - decimals);
  return value > 0n ? value : null;
}

function rateOrThrow(rate: string): bigint {
  const value = parseRate(rate);
  if (value === null) throw new RangeError(`Invalid exchange rate: ${rate}`);
  return value;
}

/** Which way a conversion rounds when the exact result is not a whole number of units. */
export type Rounding = 'up' | 'down';

function unitsOrThrow(units: number): bigint {
  if (!Number.isSafeInteger(units) || units < 0) {
    throw new RangeError(`Expected a non-negative safe integer amount, got ${units}`);
  }
  return BigInt(units);
}

function toUnits(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('Amount exceeds the largest safe integer');
  }
  return Number(value);
}

/** `numerator ÷ denominator` for non-negative integers, rounded in the given direction. */
function divide(numerator: bigint, denominator: bigint, rounding: Rounding): bigint {
  const quotient = numerator / denominator;
  return rounding === 'up' && quotient * denominator !== numerator ? quotient + 1n : quotient;
}

const USD_SCALE = BigInt(CURRENCY_SCALE.USD);
const SYP_SCALE = BigInt(CURRENCY_SCALE.SYP);

/** SYP units for `usdUnits` at `rate` (SYP per 1 USD), exact, then rounded as asked. */
export function usdToSyp(usdUnits: number, rate: string, rounding: Rounding): number {
  const numerator = unitsOrThrow(usdUnits) * rateOrThrow(rate) * SYP_SCALE;
  return toUnits(divide(numerator, USD_SCALE * RATE_FACTOR, rounding));
}

/** USD units for `sypUnits` at `rate` (SYP per 1 USD), exact, then rounded as asked. */
export function sypToUsd(sypUnits: number, rate: string, rounding: Rounding): number {
  const numerator = unitsOrThrow(sypUnits) * USD_SCALE * RATE_FACTOR;
  return toUnits(divide(numerator, SYP_SCALE * rateOrThrow(rate), rounding));
}

/** `units` rounded up to the next multiple of `step` (a positive integer number of units). */
export function ceilToStep(units: number, step: number): number {
  if (!Number.isSafeInteger(step) || step <= 0) {
    throw new RangeError(`Expected a positive integer step, got ${step}`);
  }
  return toUnits(divide(unitsOrThrow(units), BigInt(step), 'up') * BigInt(step));
}

/**
 * The SYP price shown for a USD amount (ADR 0003): USD × rate, rounded up to the configured step
 * in SYP units (a step of 5 SYP is 500 units), so the shown price never undercharges.
 */
export function sypDisplayPrice(usdUnits: number, rate: string, stepUnits: number): number {
  return ceilToStep(usdToSyp(usdUnits, rate, 'up'), stepUnits);
}

/**
 * The SYP value shown under a wallet balance (S02 rule W9): USD × rate, rounded **down** to the
 * display step in SYP units, so the store never shows more than the customer holds.
 */
export function walletSypValue(usdUnits: number, rate: string, stepUnits: number): number {
  if (!Number.isSafeInteger(stepUnits) || stepUnits <= 0) {
    throw new RangeError(`Expected a positive integer step, got ${stepUnits}`);
  }
  const step = BigInt(stepUnits);
  return toUnits((BigInt(usdToSyp(usdUnits, rate, 'down')) / step) * step);
}

/**
 * A USD amount for display, with Latin digits: `$1,234.50`, `-$0.25`. Two decimals, more only
 * when the amount has sub-cent precision (system accounts: `$0.000125`). Exact, in BigInt.
 */
export function formatUsd(units: number): string {
  const value = BigInt(unitsOrThrow(Math.abs(units)));
  let fraction = (value % USD_SCALE).toString().padStart(6, '0');
  while (fraction.length > 2 && fraction.endsWith('0')) fraction = fraction.slice(0, -1);
  const whole = (value / USD_SCALE).toLocaleString('en-US');
  return `${units < 0 ? '-' : ''}$${whole}.${fraction}`;
}

const USD_INPUT_PATTERN = /^\d{1,9}(\.\d{1,2})?$/;

/**
 * A USD amount typed by the admin (`25`, `25.5`, `1250.00`; Latin digits, no separators) in USD
 * units, exact, or null when it is not dollars with at most 2 decimals. The inverse of
 * `formatUsd` for whole cents. Up to $999,999,999.99, well within the safe integers.
 */
export function parseUsd(text: string): number | null {
  const value = text.trim();
  if (!USD_INPUT_PATTERN.test(value)) return null;
  const [whole = '0', cents = ''] = value.split('.');
  return toUnits(BigInt(whole) * USD_SCALE + BigInt(cents.padEnd(2, '0')) * BigInt(USD_CENT));
}

/** A signed movement for display: `+$25.00` in, `−$25.00` out (a real minus sign, U+2212). */
export function formatSignedUsd(units: number): string {
  return `${units < 0 ? '−' : '+'}${formatUsd(Math.abs(units))}`;
}
