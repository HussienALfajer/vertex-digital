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

/** A rate stored as `numeric(12,4)`, as PostgreSQL writes it (`118.5000`), without trailing zeros. */
export function rateFromNumeric(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}

/** True when `a` and `b` are valid rates of the same value (`"130"` and `"130.00"`). */
export function isSameRate(a: string, b: string): boolean {
  const left = parseRate(a);
  return left !== null && left === parseRate(b);
}

/**
 * The change from `oldRate` to `newRate` in percent of the old rate (S03 rule FX2), signed, with 2
 * decimals rounded away from zero: `"10.17"`, `"-3.25"`. A change of exactly 5% is `"5.00"`; any
 * change above it reads at least `"5.01"`, so comparing the result with a whole threshold is exact.
 */
export function rateChangePercent(oldRate: string, newRate: string): string {
  const before = rateOrThrow(oldRate);
  const change = rateOrThrow(newRate) - before;
  const magnitude = change < 0n ? -change : change;
  const hundredths = divide(magnitude * 10_000n, before, 'up');
  const sign = change < 0n ? '-' : '';
  return `${sign}${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}`;
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

/** `usdUnits` rounded down to whole cents (S03 rule FX6): the store never credits a fraction. */
export function floorToWholeCents(usdUnits: number): number {
  const units = unitsOrThrow(usdUnits);
  return toUnits((units / BigInt(USD_CENT)) * BigInt(USD_CENT));
}

/**
 * The USD a customer gets for `sypUnits` at `rate` (S03 rule FX6): converted rounding down, then
 * floored to whole cents, so a credit is never worth more than the pounds received (rule M3).
 */
export function sypDepositUsd(sypUnits: number, rate: string): number {
  return floorToWholeCents(sypToUsd(sypUnits, rate, 'down'));
}

/**
 * A SYP amount for display, with Latin digits and no currency sign (the screens add "ل.س"):
 * `2,000`, `1,250.50`. Decimals only when the amount has a fraction of a pound. Exact.
 */
export function formatSyp(units: number): string {
  const value = BigInt(unitsOrThrow(units));
  const whole = (value / SYP_SCALE).toLocaleString('en-US');
  const fraction = value % SYP_SCALE;
  return fraction === 0n ? whole : `${whole}.${fraction.toString().padStart(2, '0')}`;
}

/** A rate for display (`13,000`, `118.5`): the whole part grouped, its decimals as stored. */
export function formatRate(rate: string): string {
  rateOrThrow(rate);
  const [whole = '', decimals] = rate.split('.');
  const grouped = BigInt(whole).toLocaleString('en-US');
  return decimals === undefined ? grouped : `${grouped}.${decimals}`;
}

const SYP_INPUT_PATTERN = /^\d{1,12}$/;

/**
 * Whole Syrian pounds typed by a customer or the admin (`2000`; Latin digits, no separators) in
 * SYP units, or null for anything else: deposits are declared in whole pounds (S03 rule SC2).
 */
export function parseWholeSyp(text: string): number | null {
  const value = text.trim();
  if (!SYP_INPUT_PATTERN.test(value)) return null;
  return toUnits(BigInt(value) * SYP_SCALE);
}

/**
 * An amount as a field shows it for editing or copying (the amount to send in Sham Cash, an
 * approval's prefill, a limit): whole pounds (`2000`), or dollars (`25`, `25.50`). The exact
 * inverse of `parseWholeSyp` and `parseUsd`; an amount that is not whole pounds or whole cents is
 * refused, never rounded.
 */
export function formatAmountInput(currency: Currency, units: number): string {
  const value = BigInt(unitsOrThrow(units));
  if (currency === 'SYP') {
    if (value % SYP_SCALE !== 0n) throw new RangeError(`Not whole pounds: ${units}`);
    return (value / SYP_SCALE).toString();
  }
  if (!isWholeCents(units)) throw new RangeError(`Not whole cents: ${units}`);
  const cents = value / BigInt(USD_CENT);
  const whole = (cents / 100n).toString();
  return cents % 100n === 0n ? whole : `${whole}.${(cents % 100n).toString().padStart(2, '0')}`;
}

/*
 * USDT (S04, ADR 0006): 1 USDT = 1 USD, so a USDT amount is carried in USD units. USD units have
 * 6 decimals, as TRON USDT does; BSC USDT has 18, so its raw amounts are scaled down.
 */

/**
 * A USDT amount for display and copying, Latin digits, no grouping, at least 4 decimals (`25.0037`,
 * `10.0000`); more only when the amount is finer than 0.0001 (`24.003712`). Exact, in BigInt.
 */
export function formatUsdtAmount(units: number): string {
  const value = BigInt(unitsOrThrow(units));
  let fraction = (value % USD_SCALE).toString().padStart(6, '0');
  while (fraction.length > 4 && fraction.endsWith('0')) fraction = fraction.slice(0, -1);
  return `${value / USD_SCALE}.${fraction}`;
}

function scaleOrThrow(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 6 || decimals > 36) {
    throw new RangeError(`Expected token decimals from 6 to 36, got ${decimals}`);
  }
  return 10n ** BigInt(decimals - 6);
}

/** A raw on-chain token amount in USD units, floored (rule M2: never credit a fraction more). */
export function rawToUsdUnits(raw: bigint, decimals: number): number {
  if (raw < 0n) throw new RangeError('Expected a non-negative raw amount');
  return toUnits(raw / scaleOrThrow(decimals));
}

/** The exact raw on-chain amount of `units` USD units for a token with `decimals` (rule U7). */
export function usdtRawForUnits(units: number, decimals: number): bigint {
  return unitsOrThrow(units) * scaleOrThrow(decimals);
}
