import {
  CURRENCY_SCALE,
  type Currency,
  type Deposit,
  type DepositLimitBreach,
  type DepositStatus,
  formatAmountInput,
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

/** The USDT presets, in USD (S04 screens: $10, $25, $50, $100, within the limits). */
export const USDT_PRESETS_USD = [10, 25, 50, 100].map((dollars) => dollars * CURRENCY_SCALE.USD);

/** One cent in USD units: `DEPOSIT_AMOUNT_BUSY` offers the amount one cent up or down (U3). */
export const ONE_CENT_UNITS = CURRENCY_SCALE.USD / 100;

/**
 * The exact amount to send split for display (rule U3): the dollars and cents the customer asked
 * for, and the two tail digits that make it unique (`25.00` and `37` of `25.0037`).
 */
export function splitPayAmount(payAmount: string): { head: string; tail: string } {
  return { head: payAmount.slice(0, -2), tail: payAmount.slice(-2) };
}

/** An address in groups of 4 characters, so the customer can check it by eye. */
export function addressGroups(address: string): string[] {
  return address.match(/.{1,4}/g) ?? [];
}

/** A deposit's status in words; a USDT one waits for a transfer, not a receipt (S04 screens). */
export function statusText(deposit: Pick<Deposit, 'status' | 'usdt'>): string {
  if (deposit.usdt && deposit.status === 'pending') return t('deposits.usdt.statuses.pending');
  if (deposit.usdt && deposit.status === 'submitted' && deposit.usdt.checkStatus !== 'review') {
    return t('deposits.usdt.statuses.checking');
  }
  return t(`deposits.statuses.${deposit.status}`);
}

/*
 * The wizard's `?amount=` (S09 rule BB8): a USD amount in whole cents, as digits, so a link from
 * the buy box can prefill the shortfall. Strings only: the money math stays the contracts'.
 */

/** `$12.05` as `1205`. */
export function centsParam(usdUnits: number): string {
  const [whole = '0', cents = ''] = formatAmountInput('USD', usdUnits).split('.');
  return `${whole}${cents.padEnd(2, '0')}`.replace(/^0+(?=\d)/, '');
}

/** `1205` as `$12.05` in units; null for anything but 1 to 11 digits above zero. */
export function amountFromCentsParam(param: string | null): number | null {
  if (!param || !/^\d{1,11}$/.test(param)) return null;
  const digits = param.padStart(3, '0');
  const units = parseUsd(`${digits.slice(0, -2)}.${digits.slice(-2)}`);
  return units === 0 ? null : units;
}

/**
 * The amount field's first text when the wizard was opened from a reservation (rule BB8): the
 * larger of the shortfall and the method's minimum, in dollars; empty without a shortfall.
 */
export function prefillText(prefillUnits: number | null, minUnits: number | undefined): string {
  if (prefillUnits === null) return '';
  const units = minUnits !== undefined && minUnits > prefillUnits ? minUnits : prefillUnits;
  return formatAmountInput('USD', units);
}
