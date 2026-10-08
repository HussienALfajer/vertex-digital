import { type Currency, type DepositStatus, formatSyp, formatUsd } from '@vertex-digital/contracts';
import type { BadgeProps } from '@vertex-digital/ui';
import type { TFunction } from 'i18next';
import { ltr } from '../../lib/format';

/**
 * An amount in its currency (units, ADR 0003), read right to left like the page: `2,000 ل.س`, or
 * `$25.00` isolated left to right so it stays whole inside a sentence.
 */
export function depositAmount(t: TFunction, currency: Currency, units: number): string {
  return currency === 'SYP' ? t('rates.syp', { amount: formatSyp(units) }) : ltr(formatUsd(units));
}

/** brand/identity.md §2: in review info, credited success, rejected danger, the rest neutral. */
export const STATUS_TONES: Record<DepositStatus, NonNullable<BadgeProps['tone']>> = {
  pending: 'warning',
  submitted: 'info',
  credited: 'success',
  rejected: 'danger',
  expired: 'neutral',
  cancelled: 'neutral',
};
