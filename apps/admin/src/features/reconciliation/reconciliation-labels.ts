import {
  type Currency,
  formatSyp,
  formatUsd,
  type OffendingKind,
  type ReconciliationResult,
  type ReconciliationRun,
  supplierOfPlace,
  type TreasuryEndpoint,
  treasuryEndpointOf,
} from '@vertex-digital/contracts';
import type { BadgeProps } from '@vertex-digital/ui';
import type { TFunction } from 'i18next';
import { ltr } from '../../lib/format';

/*
 * How the books read on screen (S13): place and check names, signed amounts in their currency,
 * result and run tones, and where an offending id leads.
 */

/**
 * An amount in its currency, signed when below zero: `−2,000 ل.س`, or `-$25.00` isolated left to
 * right so it stays whole in a sentence. Supplier balances keep their sub-cent digits.
 */
export function money(t: TFunction, currency: Currency, units: number): string {
  if (currency === 'USD') return ltr(formatUsd(units));
  const amount = t('rates.syp', { amount: formatSyp(Math.abs(units)) });
  return units < 0 ? `−${amount}` : amount;
}

/** A place or the corrections' counter side: `شام كاش (دولار)`, `المورد WDGZone`. */
export function placeLabel(t: TFunction, place: TreasuryEndpoint): string {
  const supplier = supplierOfPlace(place);
  if (supplier) {
    return t('reconciliation.places.supplier', { name: t(`suppliers.names.${supplier}`) });
  }
  return t(`reconciliation.places.${place as Exclude<TreasuryEndpoint, `supplier:${string}`>}`);
}

/**
 * A result's subject: a place, a ledger account code (`customer_wallet:<id>` is a wallet), the
 * whole ledger, Sham Cash or the day's orders. Anything else is shown as stored.
 */
export function subjectLabel(t: TFunction, subject: string): string {
  if (subject === 'ledger') return t('reconciliation.subjects.ledger');
  if (subject === 'sham_cash') return t('reconciliation.subjects.shamCash');
  if (subject === 'orders') return t('reconciliation.subjects.orders');
  const endpoint = treasuryEndpointOf(subject) ?? asPlace(subject);
  if (endpoint) return placeLabel(t, endpoint);
  if (subject.startsWith('customer_wallet:')) return t('reconciliation.subjects.wallet');
  return subject;
}

const PLACE_SUBJECTS: readonly string[] = [
  'sham_cash_syp',
  'sham_cash_usd',
  'usdt_trc20',
  'usdt_bep20',
  'supplier:wdgzone',
  'supplier:manual',
  'supplier:fake',
];

const asPlace = (subject: string): TreasuryEndpoint | null =>
  PLACE_SUBJECTS.includes(subject) ? (subject as TreasuryEndpoint) : null;

/** brand/identity.md §2: ok success, mismatch danger, warning warning, skipped neutral. */
export const RESULT_TONES: Record<
  ReconciliationResult['status'],
  NonNullable<BadgeProps['tone']>
> = {
  ok: 'success',
  mismatch: 'danger',
  warning: 'warning',
  skipped: 'neutral',
};

/** A run's tone: running info, failed danger, finished by what it found. */
export function runTone(run: ReconciliationRun): NonNullable<BadgeProps['tone']> {
  if (run.status === 'running') return 'info';
  if (run.status === 'failed' || run.mismatchCount > 0) return 'danger';
  return run.warningCount > 0 ? 'warning' : 'success';
}

/** A result's status, with a skipped check's reason. */
export function resultStatusLabel(t: TFunction, result: ReconciliationResult): string {
  if (result.status === 'skipped' && result.details.reason) {
    return t(`reconciliation.skipReasons.${result.details.reason}`);
  }
  return t(`reconciliation.statuses.${result.status}`);
}

export type OffendingTarget =
  | { to: '/orders/$id'; params: { id: string } }
  | { to: '/deposits/$id'; params: { id: string } }
  | { to: '/customers/$id'; params: { id: string } }
  | { to: '/audit'; search: { entityId: string } }
  | { to: '/deposits/transfers' }
  | { to: '/reconciliation'; search: { tab: 'movements' } };

/** Where an offending id opens; null for ids without a page (journals, attempts). */
export function offendingTarget(kind: OffendingKind, id: string): OffendingTarget | null {
  switch (kind) {
    case 'order':
      return { to: '/orders/$id', params: { id } };
    case 'deposit':
      return { to: '/deposits/$id', params: { id } };
    case 'customer':
      return { to: '/customers/$id', params: { id } };
    case 'adjustment':
      return { to: '/audit', search: { entityId: id } };
    case 'transfer':
      return { to: '/deposits/transfers' };
    case 'movement':
      return { to: '/reconciliation', search: { tab: 'movements' } };
    default:
      return null;
  }
}
