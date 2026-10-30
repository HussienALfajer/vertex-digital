import { cva, type VariantProps } from 'class-variance-authority';
import { CrownIcon, GemIcon, MedalIcon, ShieldIcon } from 'lucide-react';
import type * as React from 'react';
import { cn } from '../lib/cn';

/*
 * The merchant tier's badge (S23 ID1, brand/identity.md §2 "Merchant tiers"): the tier's icon and
 * its name on a flat tint of the tier's metal. The name comes in as `label` (the app translates
 * it). Tier colors tint this badge and the tier surfaces only, never buttons, prices or status.
 */

export const TIER_BADGE_TIERS = ['bronze', 'silver', 'gold', 'diamond'] as const;

export type TierBadgeTier = (typeof TIER_BADGE_TIERS)[number];

const TIER_ICONS = {
  bronze: ShieldIcon,
  silver: MedalIcon,
  gold: CrownIcon,
  diamond: GemIcon,
} as const satisfies Record<TierBadgeTier, React.ComponentType<{ className?: string }>>;

const tierBadgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center gap-1.5 rounded-sm border font-medium whitespace-nowrap',
  {
    variants: {
      tier: {
        bronze: 'border-tier-bronze/40 bg-tier-bronze/10 text-tier-bronze-text',
        silver: 'border-tier-silver/40 bg-tier-silver/10 text-tier-silver-text',
        gold: 'border-tier-gold/40 bg-tier-gold/10 text-tier-gold-text',
        diamond: 'border-tier-diamond/40 bg-tier-diamond/10 text-tier-diamond-text',
      },
      size: {
        sm: 'h-6 px-2 text-xs [&>svg]:size-3.5',
        md: 'h-8 px-2.5 text-sm [&>svg]:size-4',
        lg: 'h-11 px-4 text-md [&>svg]:size-5',
      },
    },
    defaultVariants: { size: 'md' },
  },
);

/** The tier's mark color as a text color, for an icon or a line drawn outside the badge. */
const tierTextVariants = cva('', {
  variants: {
    tier: {
      bronze: 'text-tier-bronze-text',
      silver: 'text-tier-silver-text',
      gold: 'text-tier-gold-text',
      diamond: 'text-tier-diamond-text',
    },
  },
});

/** A flat tint of the tier's metal for a tier surface (the tier card, the certificate frame). */
const tierSurfaceVariants = cva('border', {
  variants: {
    tier: {
      bronze: 'border-tier-bronze/40 bg-tier-bronze/10',
      silver: 'border-tier-silver/40 bg-tier-silver/10',
      gold: 'border-tier-gold/40 bg-tier-gold/10',
      diamond: 'border-tier-diamond/40 bg-tier-diamond/10',
    },
  },
});

type TierBadgeProps = Omit<React.ComponentProps<'span'>, 'children'> &
  VariantProps<typeof tierBadgeVariants> & {
    tier: TierBadgeTier;
    label: string;
  };

function TierBadge({ tier, label, size, className, ...props }: TierBadgeProps) {
  const Icon = TIER_ICONS[tier];
  return (
    <span
      data-slot="tier-badge"
      data-tier={tier}
      className={cn(tierBadgeVariants({ tier, size }), className)}
      {...props}
    >
      <Icon aria-hidden="true" />
      {label}
    </span>
  );
}

/** The tier's icon alone, in the tier's color. */
function TierIcon({
  tier,
  className,
  ...props
}: Omit<React.ComponentProps<'svg'>, 'ref'> & { tier: TierBadgeTier }) {
  const Icon = TIER_ICONS[tier];
  return (
    <Icon
      data-slot="tier-icon"
      aria-hidden="true"
      className={cn(tierTextVariants({ tier }), className)}
      {...props}
    />
  );
}

export {
  TIER_ICONS,
  TierBadge,
  type TierBadgeProps,
  TierIcon,
  tierBadgeVariants,
  tierSurfaceVariants,
  tierTextVariants,
};
