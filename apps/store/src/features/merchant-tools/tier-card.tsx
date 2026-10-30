'use client';

import {
  formatUsd,
  type MerchantTierSummary,
  type TierPrivileges,
} from '@vertex-digital/contracts';
import { Button } from '@vertex-digital/ui/components/button';
import { AscentMeter } from '@vertex-digital/ui/components/meter';
import { TierBadge, tierSurfaceVariants } from '@vertex-digital/ui/components/tier-badge';
import { CheckIcon, PiggyBankIcon } from 'lucide-react';
import Link from 'next/link';
import { formatDate, ltr } from '@/lib/format';
import { tm } from './i18n';
import { tierBadgeLabel } from './tier-parts';

/** A Damascus day (`YYYY-MM-DD`) in words. */
export const dayLabel = (day: string) => formatDate(`${day}T12:00:00Z`);

/**
 * ID3: "فئتك" on a flat tint of the tier's metal: the badge and since when, this month's progress
 * toward the next tier on the 60° steps (PG1), the keep line (TR7), the savings (PG6) and what the
 * tier grants (TS2). The tier page shows it without its link.
 */
export function TierCard({
  tier,
  withLink = true,
}: {
  tier: MerchantTierSummary;
  withLink?: boolean;
}) {
  const { progress } = tier;
  const reached = ltr(formatUsd(Math.max(tier.thisMonthUsdUnits, 0)));
  return (
    <section
      className={`flex flex-col gap-4 rounded-xl p-5 ${tierSurfaceVariants({ tier: tier.tier })}`}
      data-testid="tier-card"
      aria-labelledby="tier-card-title"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="tier-card-title" className="text-lg font-bold">
          {tm('tier.cardTitle')}
        </h2>
        <TierBadge tier={tier.tier} size="lg" label={tierBadgeLabel(tier.tier)} />
      </header>
      <p className="text-sm text-muted-foreground">
        {tm('tier.since', { date: formatDate(tier.since) })}
      </p>
      <div className="flex flex-col gap-2">
        <AscentMeter
          max={10}
          value={Math.floor(progress.reachedPermille / 100)}
          aria-label={tm('tier.thisMonth')}
        />
        {progress.next ? (
          <p className="text-md">
            {progress.next.missingUsdUnits > 0
              ? tm('tier.progress', {
                  reached,
                  threshold: ltr(formatUsd(progress.next.thresholdUsdUnits)),
                  missing: ltr(formatUsd(progress.next.missingUsdUnits)),
                  name: tm(`tier.names.${progress.next.tier}`),
                })
              : tm('tier.progressReached', { name: tm(`tier.names.${progress.next.tier}`) })}
          </p>
        ) : (
          <p className="flex flex-col gap-1 text-md">
            <span className="font-medium">{tm('tier.top')}</span>
            {progress.keep && (
              <span className="text-sm text-muted-foreground">
                {progress.keep.missingUsdUnits > 0
                  ? tm('tier.keep', { amount: ltr(formatUsd(progress.keep.missingUsdUnits)) })
                  : tm('tier.kept')}
              </span>
            )}
          </p>
        )}
        {tier.keptUntil && (
          <p className="text-sm text-muted-foreground">
            {tm('tier.keptUntil', { date: dayLabel(tier.keptUntil) })}
          </p>
        )}
      </div>
      {tier.savingsUsdUnits !== null && tier.savingsUsdUnits > 0 && (
        <p className="flex items-center gap-2 text-md font-medium text-status-success-foreground">
          <PiggyBankIcon className="size-5" aria-hidden="true" />
          {tm('tier.savings', { amount: ltr(formatUsd(tier.savingsUsdUnits)) })}
        </p>
      )}
      <TierGrants privileges={tier.privileges} />
      {withLink && (
        <Button
          variant="outline"
          size="xl"
          className="self-start"
          render={<Link href="/merchant/tier" prefetch={false} />}
        >
          {tm('tier.toPage')}
        </Button>
      )}
    </section>
  );
}

/** TS2: what a tier grants, in plain lines (the tier card, the celebration, the tier table). */
export function TierGrants({
  privileges,
  withTitle = true,
  className,
}: {
  privileges: TierPrivileges;
  withTitle?: boolean;
  className?: string;
}) {
  return (
    <div className={`flex flex-col gap-2 ${className ?? ''}`}>
      {withTitle && <h3 className="text-sm font-bold">{tm('tier.grantsTitle')}</h3>}
      <ul className="flex flex-col gap-1.5 text-sm">
        {tierGrantLines(privileges).map((line) => (
          <li key={line} className="flex items-start gap-2">
            <CheckIcon className="mt-0.5 size-4 shrink-0 text-accent-text" aria-hidden="true" />
            <span>{line}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The privileges this release delivers, in order (the queue priorities follow with S23 PR 3). */
export function tierGrantLines(privileges: TierPrivileges): string[] {
  const lines = [
    tm('tier.grants.deposit', {
      per: ltr(formatUsd(privileges.perDepositUsdUnits)),
      daily: ltr(formatUsd(privileges.dailyDepositUsdUnits)),
    }),
    tm('tier.grants.bulk', { count: privileges.bulkLinesMax }),
    tm('tier.grants.codes', { count: privileges.orderUnitsMax }),
    tm('tier.grants.checks', { count: privileges.playerChecksPerHour }),
  ];
  if (privileges.receiptWelcome) lines.push(tm('tier.grants.welcome'));
  if (privileges.receiptLargeLogo) lines.push(tm('tier.grants.largeLogo'));
  return lines;
}
