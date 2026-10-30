import {
  type AlertSettings,
  alertSettingsSchema,
  formatAmountInput,
  parseUsd,
  parseWholeSyp,
  type SaleCurrency,
  type SellingPriceInput,
  sellingPriceInputSchema,
} from '@vertex-digital/contracts';

/*
 * The merchant area's fields as typed (S21 SP1, SP2, AL5): pure, checked with the contracts'
 * schemas the API uses. `undefined` is an invalid field; `null` an empty one that clears.
 */

const PERCENT = /^(\d{1,3})(?:\.(\d{1,2}))?$/;

/** SP1: a markup typed in percent (`10`, `12.5`) as basis points; empty is none. */
export function parseMarkup(text: string): number | null | undefined {
  const value = text.trim();
  if (value === '') return null;
  const match = PERCENT.exec(value);
  if (!match) return undefined;
  const bp = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  return bp <= 10_000 ? bp : undefined;
}

/** SP1: basis points as the field shows them (`1250` → `12.5`). */
export function markupInput(bp: number | null): string {
  if (bp === null) return '';
  const whole = Math.floor(bp / 100);
  const fraction = String(bp % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

/** SP2: a selling price in the chosen currency, or undefined when invalid. */
export function parseSellingPrice(
  currency: SaleCurrency,
  text: string,
): SellingPriceInput | undefined {
  const amountUnits = currency === 'usd' ? parseUsd(text) : parseWholeSyp(text);
  if (amountUnits === null) return undefined;
  const parsed = sellingPriceInputSchema.safeParse({ currency, amountUnits });
  return parsed.success ? parsed.data : undefined;
}

/** SP2: a stored price as its field shows it. */
export function sellingPriceInput(price: SellingPriceInput): string {
  return formatAmountInput(price.currency === 'usd' ? 'USD' : 'SYP', price.amountUnits);
}

/** A selling price the API already computed, in both currencies (null where it has none). */
export interface ReadyPrice {
  usdUnits: number | null;
  sypUnits: number | null;
}

/** A selling price field: its currency, what it shows, and whether the merchant typed in it. */
export interface SalePriceDraft {
  currency: SaleCurrency;
  amount: string;
  typed: boolean;
}

function readyAmount(ready: ReadyPrice, currency: SaleCurrency): string {
  const units = currency === 'usd' ? ready.usdUnits : ready.sypUnits;
  return units === null ? '' : formatAmountInput(currency === 'usd' ? 'USD' : 'SYP', units);
}

/** The field untouched: the ready amount in `currency` (USD leads, owner 2026-10-30). */
export function salePriceStart(ready: ReadyPrice, currency: SaleCurrency = 'usd'): SalePriceDraft {
  return { currency, amount: readyAmount(ready, currency), typed: false };
}

/**
 * A currency change. Untouched, the field shows the API's ready amount in the other currency;
 * typed, it is cleared: an amount never changes currency, or 730 SYP would become $730.
 */
export function switchSaleCurrency(
  draft: SalePriceDraft,
  currency: SaleCurrency,
  ready: ReadyPrice,
): SalePriceDraft {
  if (currency === draft.currency) return draft;
  return draft.typed
    ? { currency, amount: '', typed: true }
    : { currency, amount: readyAmount(ready, currency), typed: false };
}

/**
 * PS3: the sale's own price (`manual`) from the confirmation's field: null when the field was not
 * typed in, is empty, or holds the ready amount (the pack's price or markup is the sale's then,
 * SP4); undefined when what was typed is not a price.
 */
export function manualSalePrice(
  draft: SalePriceDraft,
  ready: ReadyPrice,
): SellingPriceInput | null | undefined {
  if (!draft.typed || draft.amount.trim() === '') return null;
  const input = parseSellingPrice(draft.currency, draft.amount);
  if (input === undefined) return undefined;
  const readyUnits = draft.currency === 'usd' ? ready.usdUnits : ready.sypUnits;
  return input.amountUnits === readyUnits ? null : input;
}

/** AL5: the low-balance threshold in dollars; empty turns it off. */
export function parseAlertSettings(
  threshold: string,
  dailyEmail: boolean,
): AlertSettings | undefined {
  const lowBalanceUsdUnits = threshold.trim() === '' ? null : parseUsd(threshold);
  if (lowBalanceUsdUnits === null && threshold.trim() !== '') return undefined;
  const parsed = alertSettingsSchema.safeParse({ lowBalanceUsdUnits, dailyEmail });
  return parsed.success ? parsed.data : undefined;
}
