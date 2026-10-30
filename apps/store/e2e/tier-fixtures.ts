import { type MerchantTierSummary, TIER_SETTINGS_DEFAULTS } from '@vertex-digital/contracts';

/*
 * The merchant's tier as `GET /api/merchant/tier` answers it (S23 ID3): a Bronze merchant with
 * nothing bought this month by default, which every merchant page reads through the area's layout.
 */

const USD = 1_000_000;

export const tierSummary = (changes: Partial<MerchantTierSummary> = {}): MerchantTierSummary => ({
  tier: 'bronze',
  since: '2026-10-01T09:00:00.000Z',
  keptUntil: null,
  month: '2026-10',
  thisMonthUsdUnits: 0,
  progress: {
    next: { tier: 'silver', thresholdUsdUnits: 300 * USD, missingUsdUnits: 300 * USD },
    reachedPermille: 0,
    keep: null,
  },
  forecast: null,
  savingsUsdUnits: null,
  privileges: TIER_SETTINGS_DEFAULTS.bronze,
  celebrate: false,
  contact: null,
  ...changes,
});
