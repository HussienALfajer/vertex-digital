import { CURRENCY_SCALE } from '@vertex-digital/contracts';

/*
 * S25 ZD4, ADR 0003: a zddk price as exact USD units. Prices arrive as JSON numbers (`0.0074375`)
 * or decimal strings (`"1.2604800000000000"`); a number is read from its shortest text (exact for
 * the supplier's figures, which have far fewer than 15 digits), never computed in floating point.
 * The price times the offer's multiplier (a value list's value, 100 for an amount offer) must be a
 * whole number of micro-dollars, or the offer is not sold (`cost_precision`): never rounded.
 */

/** A non-negative decimal: `digits / 10^scale`. */
interface Decimal {
  digits: bigint;
  scale: number;
}

/** Plain (`12.5`) or exponent (`1.5e-7`, as JavaScript writes small numbers) notation. */
const DECIMAL_TEXT = /^(\d{1,15})(?:\.(\d{1,30}))?(?:e([+-]?\d{1,2}))?$/i;

/** The decimal a supplier wrote, or null when it is negative, empty or not a number. */
export function decimalOf(value: number | string): Decimal | null {
  if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) return null;
  const match = DECIMAL_TEXT.exec(String(value).trim());
  if (!match) return null;
  const [, whole = '', fraction = '', exponent = '0'] = match;
  const scale = fraction.length - Number(exponent);
  const digits = BigInt(whole + fraction);
  return scale >= 0 ? { digits, scale } : { digits: digits * 10n ** BigInt(-scale), scale: 0 };
}

/**
 * `price × multiplier` in USD units (micro-dollars), exactly; null when it is not a whole number
 * of units, not a decimal, or beyond the safe integers. With `roundUp`, a fraction of a unit is
 * rounded up instead: only to show the cost of an offer that is never sold (`cost_precision`).
 */
export function usdUnitsOf(
  price: number | string,
  multiplier: number | string = 1,
  options: { roundUp?: boolean } = {},
): number | null {
  const a = decimalOf(price);
  const b = decimalOf(multiplier);
  if (!a || !b) return null;
  const numerator = a.digits * b.digits * BigInt(CURRENCY_SCALE.USD);
  const divisor = 10n ** BigInt(a.scale + b.scale);
  const exact = numerator % divisor === 0n;
  if (!exact && !options.roundUp) return null;
  const units = numerator / divisor + (exact ? 0n : 1n);
  return units <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(units) : null;
}
