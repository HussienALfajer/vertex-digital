import { useQuery } from '@tanstack/react-query';
import {
  ADJUSTMENT_CONFIRMATION_THRESHOLD_USD_UNITS,
  type Currency,
  formatAmountInput,
  parseUsd,
  parseWholeSyp,
  supplierOfPlace,
  sypToUsd,
  TREASURY_ACCOUNTS,
  type TreasuryPlace,
} from '@vertex-digital/contracts';
import type { TFunction } from 'i18next';
import { ApiError } from '../../lib/api/client';
import { errorMessage } from '../../lib/errors';
import { rateBannerQuery } from '../rates/rates.queries';

/*
 * What the movement, correction and reverse dialogs share (S13 rules T3, T7): amounts read in a
 * place's currency and precision, the typed confirmation above $100, and where a refusal shows.
 */

export type TreasuryField =
  | 'from'
  | 'to'
  | 'sent'
  | 'received'
  | 'category'
  | 'opening'
  | 'reference'
  | 'order'
  | 'reason'
  | 'confirm';

export type TreasuryFieldErrors = Partial<Record<TreasuryField, string>>;

/** Codes that belong under one field rather than above the buttons. */
const FIELD_OF_CODE: Partial<Record<string, TreasuryField>> = {
  TREASURY_PLACES_INVALID: 'to',
  MOVEMENT_RECEIVED_EXCEEDS_SENT: 'received',
  OPENING_BALANCE_EXISTS: 'opening',
  EXTERNAL_REFERENCE_TAKEN: 'reference',
  RETURN_RECEIPT_MISSING: 'reference',
  AMOUNT_CONFIRMATION_REQUIRED: 'confirm',
  AMOUNT_CONFIRMATION_MISMATCH: 'confirm',
  NOT_FOUND: 'order',
};

/** A refused movement, and where to show it. */
export function treasuryFailure(
  t: TFunction,
  error: unknown,
  fields: readonly TreasuryField[],
): { field?: TreasuryField; message: string } {
  const code = error instanceof ApiError ? error.code : undefined;
  const field = code ? FIELD_OF_CODE[code] : undefined;
  const shown = field && fields.includes(field) ? field : undefined;
  return {
    field: shown,
    // Under the order number, "not found" names the order, not a record to reload (A09-32).
    message:
      shown === 'order' && code === 'NOT_FOUND'
        ? t('reconciliation.correction.errors.orderNotFound')
        : errorMessage(t, error),
  };
}

/** Supplier balances are sub-cent (rule T3); the other USD places whole cents; SYP whole pounds. */
const subCent = (place: TreasuryPlace) => supplierOfPlace(place) !== null;

export const placeCurrency = (place: TreasuryPlace): Currency => TREASURY_ACCOUNTS[place].currency;

/** An amount typed for a place, in its units, or null when it is not valid there. */
export function parsePlaceAmount(place: TreasuryPlace, text: string): number | null {
  const units =
    placeCurrency(place) === 'SYP'
      ? parseWholeSyp(text)
      : parseUsd(text, { subCent: subCent(place) });
  return units !== null && units > 0 ? units : null;
}

/** An amount as a place's field shows it, or empty when it cannot be typed there. */
export function placeAmountText(place: TreasuryPlace, units: number): string {
  try {
    return formatAmountInput(placeCurrency(place), units, { subCent: subCent(place) });
  } catch {
    return '';
  }
}

/**
 * Rule T7: the confirmation field shows above $100, SYP converted at today's rate; without a rate
 * a pounds amount always asks. The API has the last word: its refusal shows the field too.
 */
export function useNeedsConfirmation(currency: Currency, units: number | null): boolean {
  const rates = useQuery(rateBannerQuery);
  if (units === null) return false;
  if (currency === 'USD') return units > ADJUSTMENT_CONFIRMATION_THRESHOLD_USD_UNITS;
  const rate = rates.data?.current?.sypPerUsd;
  return !rate || sypToUsd(units, rate, 'up') > ADJUSTMENT_CONFIRMATION_THRESHOLD_USD_UNITS;
}
