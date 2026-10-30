import type { MerchantTier } from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui';
import { useTranslation } from 'react-i18next';

/** The panel's tones per tier until the tier colours arrive (S23 PR 2, decision 6). */
const TIER_TONES = {
  bronze: 'outline',
  silver: 'neutral',
  gold: 'gold',
  diamond: 'brand',
} as const satisfies Record<MerchantTier, string>;

/** S23 AD1, MG2: a merchant's tier, with "ممنوحة" when the admin granted it. */
export function TierChip({ tier, granted = false }: { tier: MerchantTier; granted?: boolean }) {
  const { t } = useTranslation();
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Badge tone={TIER_TONES[tier]}>{t(`merchants.tierNames.${tier}`)}</Badge>
      {granted && <Badge tone="info">{t('merchants.tiers.grantedMark')}</Badge>}
    </span>
  );
}
