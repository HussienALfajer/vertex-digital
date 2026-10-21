'use client';

import { formatSyp, formatUsd, sypDisplayPrice } from '@vertex-digital/contracts';
import { Button } from '@vertex-digital/ui/components/button';
import Link from 'next/link';
import { centsParam } from '@/features/deposits/amounts';
import { tq } from '@/features/quick-buy/i18n';
import { ltr } from '@/lib/format';
import type { Balance } from './customer';

/**
 * "ينقصك" (S22 BG1, BG2, BG5) in place of the slide when the balance is short: the gap with its
 * pounds, then "احجز واشحن الفرق" (an S09 reservation, then the deposit form) and "اشحن فقط"; with
 * no reservation possible (the cart, or three open already) only the deposit.
 */
export function GapBlock({
  balance,
  gapUnits,
  onReserve,
}: {
  balance: Extract<Balance, { status: 'ready' }>;
  gapUnits: number;
  /** Null when no reservation can be made. */
  onReserve: (() => void) | null;
}) {
  const href = `/wallet/deposit?gap=${centsParam(gapUnits)}`;
  const missing = ltr(formatUsd(gapUnits));
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <p className="text-lg font-bold">
        {balance.syp
          ? tq('gap.missingSyp', {
              missing,
              syp: formatSyp(sypDisplayPrice(gapUnits, balance.syp.rate, balance.syp.stepUnits)),
            })
          : tq('gap.missing', { missing })}
      </p>
      <p className="text-sm text-muted-foreground">
        {tq(balance.reservedUnits > 0 ? 'gap.balanceReserved' : 'gap.balance', {
          balance: ltr(formatUsd(balance.units)),
          reserved: ltr(formatUsd(balance.reservedUnits)),
        })}
      </p>
      {onReserve ? (
        <>
          <Button size="xl" onClick={onReserve}>
            {tq('gap.reserve')}
          </Button>
          <Button variant="outline" size="xl" render={<Link href={href} />}>
            {tq('gap.depositOnly')}
          </Button>
        </>
      ) : (
        <Button size="xl" render={<Link href={href} />}>
          {tq('gap.deposit')}
        </Button>
      )}
    </div>
  );
}
