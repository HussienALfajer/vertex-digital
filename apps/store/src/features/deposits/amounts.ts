import {
  CURRENCY_SCALE,
  type Currency,
  type DepositLimitBreach,
  type DepositStatus,
  formatSyp,
  formatUsd,
  parseUsd,
  parseWholeSyp,
  sypDepositUsd,
  sypDisplayPrice,
} from '@vertex-digital/contracts';
import { ltr } from '@/lib/format';
import { t } from '@/lib/i18n';

/*
 * The deposit wizard's amounts (S03 screens): what the customer types, the presets, and the
 * words for amounts, statuses and limits. The money math itself is the contracts' (ADR 0003).
 */

/** The presets, in USD (the spec: $5, $10, $25, $50). */
export const PRESETS_USD = [5, 10, 25, 50].map((dollars) => dollars * CURRENCY_SCALE.USD);

/** The typed amount in units: whole pounds, or dollars with up to 2 decimals; else null. */
export function parseDepositAmount(currency: Currency, text: string): number | null {
  const units = currency === 'SYP' ? parseWholeSyp(text) : parseUsd(text);
  return units === null || units === 0 ? null : units;
}

/** A preset's amount in the currency: pounds rounded up to the display step (rule FX3). */
export function presetUnits(
  currency: Currency,
  usdUnits: number,
  rate: { sypPerUsd: string; displayStepSypUnits: number } | null,
): number | null {
  if (currency === 'USD') return usdUnits;
  if (!rate) return null;
  return sypDisplayPrice(usdUnits, rate.sypPerUsd, rate.displayStepSypUnits);
}

/** What a SYP amount gets in USD (rule FX6), for the live preview. */
export function previewUsd(sypUnits: number, rate: string): number {
  return sypDepositUsd(sypUnits, rate);
}

/** A USD amount kept whole inside an Arabic sentence (`$25.00`, never `25.00$`). */
export const usdText = (units: number) => ltr(formatUsd(units));

/**
 * An amount with its currency, read right to left like the rest of the page: `2,000 ل.س`, or
 * `$25.00` isolated left to right.
 */
export function amountText(currency: Currency, units: number): string {
  return currency === 'SYP' ? t('deposits.syp', { amount: formatSyp(units) }) : usdText(units);
}

/** brand/identity.md §2: in review info, credited success, rejected danger, the rest neutral. */
export const STATUS_TONES = {
  pending: 'warning',
  submitted: 'info',
  credited: 'success',
  rejected: 'danger',
  expired: 'neutral',
  cancelled: 'neutral',
} as const satisfies Record<DepositStatus, string>;

/** `DEPOSIT_LIMIT_EXCEEDED` in words, from its `details` (rule SC3); null when unreadable. */
export function limitText(details: unknown): string | null {
  const breach = details as Partial<DepositLimitBreach> | undefined;
  if (!Number.isSafeInteger(breach?.limitUnits) || !Number.isSafeInteger(breach?.remainingUnits)) {
    return null;
  }
  const limit = usdText(breach?.limitUnits as number);
  const remaining = usdText(breach?.remainingUnits as number);
  switch (breach?.limit) {
    case 'minimum':
      return t('deposits.limits.minimum', { limit });
    case 'per_deposit':
      return t('deposits.limits.perDeposit', { limit });
    case 'daily':
      return t('deposits.limits.daily', { limit, remaining });
    default:
      return null;
  }
}
