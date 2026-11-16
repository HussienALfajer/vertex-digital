import { z } from 'zod';
import type { LedgerAccountKind } from './wallet.js';

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

/**
 * S13 rule RP9: a report's amount rounded half-up to the cent (away from zero), as `formatUsd`
 * shows it. Costs and profits keep sub-cent precision in the data; screens show cents.
 */
export function formatUsdCents(units: number): string {
  const value = BigInt(unitsOrThrow(Math.abs(units)));
  const cent = BigInt(USD_CENT);
  const rounded = ((value + cent / 2n) / cent) * cent;
  return formatUsd(units < 0 ? -toUnits(rounded) : toUnits(rounded));
}

const USD_INPUT_PATTERN = /^\d{1,9}(\.\d{1,2})?$/;
const SUB_CENT_INPUT_PATTERN = /^\d{1,9}(\.\d{1,6})?$/;

/**
 * A USD amount typed by the admin (`25`, `25.5`, `1250.00`; Latin digits, no separators) in USD
 * units, exact, or null when it is not dollars with at most 2 decimals. The inverse of
 * `formatUsd` for whole cents. Up to $999,999,999.99, well within the safe integers. With
 * `subCent` (S13: supplier balances, rule T3) up to 6 decimals, a micro-dollar.
 */
export function parseUsd(text: string, options: { subCent?: boolean } = {}): number | null {
  const value = text.trim();
  if (!(options.subCent ? SUB_CENT_INPUT_PATTERN : USD_INPUT_PATTERN).test(value)) return null;
  const [whole = '0', fraction = ''] = value.split('.');
  return toUnits(BigInt(whole) * USD_SCALE + BigInt(fraction.padEnd(6, '0')));
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
 * Null when the pounds are worth more than the largest safe number of USD units (edge case 12):
 * the caller refuses the amount (the per-deposit limit) instead of failing on it (F3-7).
 */
export function sypDepositUsd(sypUnits: number, rate: string): number | null {
  const usd = divide(
    unitsOrThrow(sypUnits) * USD_SCALE * RATE_FACTOR,
    SYP_SCALE * rateOrThrow(rate),
    'down',
  );
  return usd > BigInt(Number.MAX_SAFE_INTEGER) ? null : floorToWholeCents(Number(usd));
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
export function formatAmountInput(
  currency: Currency,
  units: number,
  options: { subCent?: boolean } = {},
): string {
  const value = BigInt(unitsOrThrow(units));
  if (currency === 'SYP') {
    if (value % SYP_SCALE !== 0n) throw new RangeError(`Not whole pounds: ${units}`);
    return (value / SYP_SCALE).toString();
  }
  if (!isWholeCents(units)) {
    if (!options.subCent) throw new RangeError(`Not whole cents: ${units}`);
    // S13: a supplier balance, the inverse of `parseUsd(text, { subCent: true })`.
    const fraction = (value % USD_SCALE).toString().padStart(6, '0').replace(/0+$/, '');
    return `${value / USD_SCALE}.${fraction}`;
  }
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

/*
 * S13: held amounts, ranges and implied rates (rules LS2, E1, M2).
 */

/**
 * Accounts whose balance is shown flipped (rule LS2): money the store holds (receipts, supplier
 * prepaid) and money spent (cost of goods, refunds, adjustments, transfer fees) grow negative, so
 * the panel shows −balance. `outside_funds` is shown as stored: a transfer from outside posts
 * +sent on it (rule M1), so its balance is what the owner and others brought in, net.
 */
const FLIPPED_ACCOUNT_KINDS: ReadonlySet<LedgerAccountKind> = new Set<LedgerAccountKind>([
  'sham_cash_receipts',
  'usdt_receipts',
  'supplier_prepaid',
  'cost_of_goods',
  'refunds',
  'adjustments',
  'transfer_fees',
  'owner_drawings',
]);

/** The amount the panel shows for an account's raw balance (rule LS2): held, spent or as stored. */
export function heldUnits(kind: LedgerAccountKind, balanceUnits: number): number {
  if (!Number.isSafeInteger(balanceUnits)) {
    throw new RangeError(`Expected a safe integer balance, got ${balanceUnits}`);
  }
  return FLIPPED_ACCOUNT_KINDS.has(kind) ? -balanceUnits || 0 : balanceUnits;
}

/**
 * Rule E1: true when `low − tolerance ≤ actual ≤ high + tolerance`. All amounts in units of one
 * currency; `low ≤ high` and a tolerance at or above zero.
 */
export function withinRange(actual: number, low: number, high: number, tolerance: number): boolean {
  if (low > high || tolerance < 0) throw new RangeError('Expected low ≤ high and a tolerance ≥ 0');
  return actual >= low - tolerance && actual <= high + tolerance;
}

/** Decimals of an implied rate: as many as a store rate (`exchangeRateSchema`). */
const IMPLIED_RATE_DECIMALS = 4n;

/**
 * Rule M2: the SYP per USD implied by a two-currency movement, `sypUnits` against `usdUnits`, as a
 * decimal string with up to 4 decimals, rounded half-up (`"13050.25"`, `"118.5"`). Computed in
 * BigInt; the postings carry the exact amounts, the rate is what the panel shows beside today's.
 */
export function impliedRate(sypUnits: number, usdUnits: number): string {
  const syp = unitsOrThrow(sypUnits);
  const usd = unitsOrThrow(usdUnits);
  if (syp === 0n || usd === 0n) throw new RangeError('Expected both amounts above zero');
  const factor = 10n ** IMPLIED_RATE_DECIMALS;
  // (syp ÷ SYP scale) ÷ (usd ÷ USD scale), × 10⁴, rounded half-up.
  const numerator = syp * USD_SCALE * factor * 2n;
  const denominator = usd * SYP_SCALE;
  const scaled = (numerator / denominator + 1n) / 2n;
  const whole = scaled / factor;
  let fraction = (scaled % factor).toString().padStart(Number(IMPLIED_RATE_DECIMALS), '0');
  while (fraction.endsWith('0')) fraction = fraction.slice(0, -1);
  return fraction === '' ? whole.toString() : `${whole}.${fraction}`;
}

/** A rate × 10⁴ as a rate string without trailing zeros (`1315000n` → `"131.5"`). */
function formatScaledRate(scaled: bigint): string {
  const whole = scaled / RATE_FACTOR;
  const fraction = (scaled % RATE_FACTOR).toString().padStart(4, '0').replace(/0+$/, '');
  return fraction === '' ? whole.toString() : `${whole}.${fraction}`;
}

/**
 * S27: the distance from rate `from` to rate `to` in basis points of `from` (1 bp = 0.01%), as a
 * magnitude rounded up: exactly 2% is 200 and anything above it at least 201, so comparing with a
 * whole threshold (`≤ 200`) is exact.
 */
export function basisPointsBetween(from: string, to: string): number {
  const before = rateOrThrow(from);
  const change = rateOrThrow(to) - before;
  const magnitude = change < 0n ? -change : change;
  return Number(divide(magnitude * 10_000n, before, 'up'));
}

/** How a rate source's text is read (S27 `rate_sources.parser`). */
export interface SourceFigureParser {
  /** The line must contain it (`دمشق`), for posts that list several cities; null reads any line. */
  cityWord: string | null;
  /** The figure is the first number after it on the line (`مبيع`). */
  sellWord: string;
  /** Old pounds are divided by 100 (ADR 0003: new pounds are the unit). */
  unit: 'new_syp' | 'old_syp';
}

/** A figure read from a source: the rate in new pounds and the line it came from. */
export interface SourceFigure {
  sypPerUsd: string;
  /** At most 300 characters of the matched line, for the admin to check. */
  excerpt: string;
}

export const SOURCE_EXCERPT_MAX = 300;

/** Arabic-Indic (U+0660) and Persian (U+06F0) digits as ASCII; the Arabic separators as `.`, `,`. */
function normaliseDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.')
    .replace(/٬/g, ',');
}

const SOURCE_NUMBER = /\d[\d,]*(?:\.\d+)?/;

/**
 * S27 SR2, SR5: the sell figure of a source's text, or null. Lines are read in order; the first
 * line that contains the city keyword (when set) and the sell keyword, followed on that line by a
 * number, gives the figure. Keywords are matched as plain text, never as patterns. Digits in
 * Arabic-Indic or Persian are read, thousands separators dropped, decimals beyond 4 cut; old pounds
 * are divided by 100 rounding up (the higher rate protects the store). A zero or a number too
 * large to be a rate reads as no figure.
 */
export function parseSourceFigure(text: string, parser: SourceFigureParser): SourceFigure | null {
  for (const rawLine of text.split('\n')) {
    const line = normaliseDigits(rawLine).replace(/\s+/g, ' ').trim();
    if (parser.cityWord !== null && !line.includes(parser.cityWord)) continue;
    const at = line.indexOf(parser.sellWord);
    if (at < 0) continue;
    const match = SOURCE_NUMBER.exec(line.slice(at + parser.sellWord.length));
    if (!match) continue;
    const [whole = '', decimals = ''] = match[0].replace(/,/g, '').split('.');
    if (whole.length > 10) return null;
    let scaled = BigInt(whole) * RATE_FACTOR + BigInt(decimals.slice(0, 4).padEnd(4, '0'));
    if (parser.unit === 'old_syp') scaled = divide(scaled, 100n, 'up');
    const sypPerUsd = formatScaledRate(scaled);
    if (scaled === 0n || parseRate(sypPerUsd) === null) return null;
    const start = Math.max(0, Math.min(at - 100, line.length - SOURCE_EXCERPT_MAX));
    return { sypPerUsd, excerpt: line.slice(start, start + SOURCE_EXCERPT_MAX) };
  }
  return null;
}

/** Orders two valid rates by value: negative when `a` is lower, 0 when equal, positive when higher. */
export function compareRates(a: string, b: string): number {
  const left = rateOrThrow(a);
  const right = rateOrThrow(b);
  return left === right ? 0 : left < right ? -1 : 1;
}
