import {
  type CustomerLimitSource,
  type CustomerStatus,
  formatAmountInput,
  type MerchantTier,
  parseUsd,
} from '@vertex-digital/contracts';
import type { TFunction } from 'i18next';

/*
 * How the panel names a customer's state (S12 screens): the status chips, the limit sources
 * (rule LM3) and the limit fields, typed in dollars and sent in USD units, never floats.
 */

/** A chip beside the customer's name: the status (active shows none), test, new or trusted. */
export type CustomerChip = 'frozen' | 'archived' | 'test' | 'new' | 'established';

export const CHIP_TONES = {
  frozen: 'danger',
  archived: 'neutral',
  test: 'info',
  new: 'warning',
  established: 'success',
} as const satisfies Record<CustomerChip, string>;

/** The status chips, archived first (an archived customer may still be frozen, rule AR2). */
export function statusChips(status: CustomerStatus, isTest: boolean): CustomerChip[] {
  const chips: CustomerChip[] = [];
  if (status === 'archived') chips.push('archived');
  if (status === 'frozen') chips.push('frozen');
  if (isTest) chips.push('test');
  return chips;
}

/** The label key of a limit's source (rule LM3). */
export const LIMIT_SOURCE_KEYS = {
  default_new: 'customers.limits.sources.default_new',
  default_established: 'customers.limits.sources.default_established',
  default_merchant: 'customers.limits.sources.default_merchant',
  custom: 'customers.limits.sources.custom',
  none: 'customers.limits.sources.none',
} as const satisfies Record<CustomerLimitSource, string>;

/**
 * A limit's source as the profile shows it; S23 TS3: a merchant's default names the tier
 * ("الافتراضي: تاجر ذهبي").
 */
export function limitSourceLabel(
  t: TFunction,
  source: CustomerLimitSource,
  tier: MerchantTier | null,
): string {
  if (source === 'default_merchant' && tier) {
    return t('customers.limits.sources.default_merchant_tier', {
      tier: t(`merchants.tierNames.${tier}`),
    });
  }
  return t(LIMIT_SOURCE_KEYS[source]);
}

/** An override as its field shows it: dollars (`500`, `12.50`), empty when not set. */
export const limitInput = (units: number | null): string =>
  units === null ? '' : formatAmountInput('USD', units);

/**
 * A limit field as typed: empty clears the override (null), dollars with at most 2 decimals are
 * USD units, anything else is `undefined` (invalid). The contract checks the range.
 */
export function parseLimitInput(text: string): number | null | undefined {
  if (text.trim() === '') return null;
  return parseUsd(text) ?? undefined;
}
