import type { MerchantTier } from '@vertex-digital/contracts';
import { TierBadge, TierIcon } from '@vertex-digital/ui/components/tier-badge';
import { tm } from './i18n';

/*
 * The tier as a merchant's customers see it (S23 decision 7, ID5, ID6): from Silver up the tier's
 * badge and "تاجر ذهبي معتمد من Vertex Digital"; Bronze only "تاجر معتمد من Vertex Digital". Inside
 * the merchant area every tier shows its badge (`TierBadge` with `tierBadgeLabel`).
 */

/** "تاجر ذهبي" (the badge inside the merchant area). */
export const tierBadgeLabel = (tier: MerchantTier) => tm(`tier.badge.${tier}`);

/** ID5: "تاجر ذهبي معتمد من Vertex Digital", or the short "تاجر ذهبي معتمد". */
export function approvedLine(tier: MerchantTier, short = false): string {
  if (tier === 'bronze') return tm(short ? 'tier.approvedShortBronze' : 'tier.approvedBronze');
  return tm(short ? 'tier.approvedShort' : 'tier.approved', { name: tm(`tier.names.${tier}`) });
}

/**
 * ID5: the line under the shop's name on a receipt, a verification page or a price list. On paper
 * (`print`) the icon and text are black (thermal printers); on screen Silver and up show the badge.
 */
export function TierLine({
  tier,
  print = false,
  className,
}: {
  tier: MerchantTier;
  print?: boolean;
  className?: string;
}) {
  if (print) {
    return (
      <p
        className={`flex items-center justify-center gap-1 text-xs ${className ?? ''}`}
        data-testid="tier-line"
      >
        {tier !== 'bronze' && <TierIcon tier={tier} className="size-3.5 text-neutral-950" />}
        {approvedLine(tier)}
      </p>
    );
  }
  return (
    <p
      className={`flex flex-wrap items-center gap-2 text-sm ${className ?? ''}`}
      data-testid="tier-line"
    >
      {tier !== 'bronze' && <TierBadge tier={tier} size="sm" label={tm(`tier.names.${tier}`)} />}
      <span>{approvedLine(tier)}</span>
    </p>
  );
}
