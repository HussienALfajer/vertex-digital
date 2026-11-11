import {
  type BrandColorProblem,
  brandColorProblem,
  parseUsd,
  parseWholeSyp,
  SHOP_TRANSFER_MIN_USD_UNITS,
  type ShopTransferCurrency,
  shopSlugSchema,
  shopTransferUsd,
} from '@vertex-digital/contracts';

/*
 * "متجري"'s pure rules (S26 PR 4): what the merchant's forms show before the server answers.
 * The server checks everything again under its locks; these only explain early.
 */

/** Why a typed slug cannot be requested (SH2), before the availability check; null when valid. */
export function slugProblem(typed: string): 'invalid' | 'reserved' | null {
  const parsed = shopSlugSchema.safeParse(typed);
  if (parsed.success) return null;
  return parsed.error.issues.some((issue) => issue.message === 'SLUG_RESERVED')
    ? 'reserved'
    : 'invalid';
}

/** ST1: a typed color as the API reads it (`#rrggbb`), or null when it is not one. */
export function normalizeColor(typed: string): string | null {
  const value = typed.trim().toLowerCase();
  const withHash = value.startsWith('#') ? value : `#${value}`;
  return /^#[0-9a-f]{6}$/.test(withHash) ? withHash : null;
}

/** ST1: the hex field's verdict: invalid, refused with its reason, or accepted. */
export function colorVerdict(typed: string): 'invalid' | BrandColorProblem | 'ok' {
  const color = normalizeColor(typed);
  if (color === null) return 'invalid';
  return brandColorProblem(color) ?? 'ok';
}

/** The typed confirmation of a far rate (ST3): «أؤكد» as written, spaces around ignored. */
export const CONFIRM_WORD = 'أؤكد';

export function confirmWordTyped(typed: string): boolean {
  return typed.trim() === CONFIRM_WORD;
}

/** WL2: the amount field as units of its currency, or null: whole pounds, or dollars to the cent. */
export function enteredUnits(currency: ShopTransferCurrency, typed: string): number | null {
  return currency === 'syp' ? parseWholeSyp(typed) : parseUsd(typed);
}

export type TransferPreview =
  | { kind: 'empty' }
  | { kind: 'invalid' }
  | { kind: 'no_rate' }
  | { kind: 'below_minimum'; usdUnits: number }
  | { kind: 'ok'; amountUnits: number; usdUnits: number };

/**
 * WL2: what a transfer of `typed` credits, shown before the slide: SYP ÷ the shop's rate rounded
 * down to whole cents (`shopTransferUsd`), at least $0.10.
 */
export function transferPreview(
  currency: ShopTransferCurrency,
  typed: string,
  rate: string | null,
): TransferPreview {
  if (typed.trim() === '') return { kind: 'empty' };
  if (currency === 'syp' && rate === null) return { kind: 'no_rate' };
  const amountUnits = enteredUnits(currency, typed);
  if (amountUnits === null || amountUnits <= 0) return { kind: 'invalid' };
  const usdUnits = shopTransferUsd(currency, amountUnits, rate);
  if (usdUnits === null) return { kind: 'invalid' };
  if (usdUnits < SHOP_TRANSFER_MIN_USD_UNITS) return { kind: 'below_minimum', usdUnits };
  return { kind: 'ok', amountUnits, usdUnits };
}

/** WL3: what is left of today's transfers, never below zero. */
export function remainingToday(dailyCapUsdUnits: number, transferredUsdUnits: number): number {
  return Math.max(0, dailyCapUsdUnits - transferredUsdUnits);
}

/** WL4: whether the password check still covers a transfer at `now`. */
export function checkHolds(checkedUntil: string | null, now: number): boolean {
  return checkedUntil !== null && Date.parse(checkedUntil) > now;
}

/** The shop's public link (SP2: the sticker's QR points to the same). */
export function shopUrl(origin: string, slug: string): string {
  return `${origin}/s/${slug}`;
}

/**
 * WL5: a return request's amount, typed in dollars: whole cents above zero, at most the
 * customer's balance; null otherwise.
 */
export function returnAmount(typed: string, balanceUsdUnits: number): number | null {
  const units = parseUsd(typed);
  if (units === null || units <= 0 || units > balanceUsdUnits) return null;
  return units;
}

/** SP3: a day's bar as a share of the period's highest day (0–1); all zero gives zero. */
export function barShares(values: readonly number[]): number[] {
  const highest = Math.max(0, ...values);
  return values.map((value) => (highest === 0 ? 0 : value / highest));
}
