import { formatSyp, formatUsd, walletSypValue } from '@vertex-digital/contracts';
import { ts } from './i18n';

/*
 * Money in a shop (S26 decision 5, ST4): SYP first at the shop's rate, the USD after "≈" small;
 * USD alone while the shop has no rate (edge case 9). A price carries its own SYP (rounded up by
 * the server); a balance is converted here, rounded **down** to whole pounds (S02 W9), so the
 * shop never shows more than the customer holds.
 */

/** Whole Syrian pounds, in SYP units. */
const POUND = 100;

/** A balance's SYP at the shop's rate, or null without one. */
export function balanceSyp(usdUnits: number, rate: string | null): number | null {
  return rate === null ? null : walletSypValue(usdUnits, rate, POUND);
}

export function ShopMoney({
  usd,
  syp,
  size = 'md',
}: {
  usd: number;
  syp: number | null;
  size?: 'sm' | 'md' | 'lg';
}) {
  const large = { sm: 'text-base', md: 'text-xl', lg: 'text-3xl' }[size];
  if (syp === null) {
    return (
      <bdi dir="ltr" className={`font-bold tabular-nums ${large}`}>
        {formatUsd(usd)}
      </bdi>
    );
  }
  return (
    <span className="inline-flex flex-col">
      <span className={`font-bold tabular-nums ${large}`}>
        {ts('balance.syp', { amount: formatSyp(syp) })}
      </span>
      <span className="text-sm text-muted-foreground tabular-nums">
        ≈ <bdi dir="ltr">{formatUsd(usd)}</bdi>
      </span>
    </span>
  );
}
