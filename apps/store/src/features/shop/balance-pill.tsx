'use client';

import { formatSyp, formatUsd } from '@vertex-digital/contracts';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { LogInIcon, WalletIcon } from 'lucide-react';
import Link from 'next/link';
import { ts } from './i18n';
import { balanceSyp } from './money';
import { shopPath } from './paths';
import { useShopCustomer } from './session';
import { useShopWallet } from './wallet';

/**
 * The header's balance (S26 screens): SYP first at the shop's rate, linking to "رصيدي"; "تسجيل
 * الدخول" for a visitor. Read in the browser, so the shop's pages stay cached.
 */
export function BalancePill({ slug }: { slug: string }) {
  const customer = useShopCustomer(slug);
  const signedIn = customer.status === 'signedIn';
  const { state } = useShopWallet(slug, signedIn);
  if (customer.status === 'loading' || customer.status === 'failed') {
    return <Skeleton className="h-11 w-28" />;
  }
  if (!signedIn) {
    return (
      <Link
        href={shopPath(slug, '/sign-in')}
        prefetch={false}
        className="inline-flex min-h-11 items-center gap-2 rounded-full border border-border px-4 text-sm font-medium"
      >
        <LogInIcon className="size-4" aria-hidden="true" />
        {ts('nav.signIn')}
      </Link>
    );
  }
  if (state.status !== 'ready') return <Skeleton className="h-11 w-28" />;
  const { balanceUsdUnits, rate } = state.wallet;
  const syp = balanceSyp(balanceUsdUnits, rate);
  return (
    <Link
      href={shopPath(slug, '/wallet')}
      prefetch={false}
      aria-label={ts('balance.label')}
      className="inline-flex min-h-11 items-center gap-2 rounded-full bg-(--shop-brand) px-3 text-sm font-bold text-white tabular-nums sm:px-4"
    >
      <WalletIcon className="hidden size-4 sm:block" aria-hidden="true" />
      {syp === null ? (
        <bdi dir="ltr">{formatUsd(balanceUsdUnits)}</bdi>
      ) : (
        <span>{ts('balance.syp', { amount: formatSyp(syp) })}</span>
      )}
    </Link>
  );
}
