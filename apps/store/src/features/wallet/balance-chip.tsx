'use client';

import { formatUsd } from '@vertex-digital/contracts';
import { Button } from '@vertex-digital/ui/components/button';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { WalletIcon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { t } from '@/lib/i18n';
import { getWallet } from './requests';

type State = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; units: number };

/**
 * The signed-in customer's balance in the header, linking to the wallet (rule W8). Read in the
 * browser, so every page stays cached; refreshed on each page load. A failed read hides the chip:
 * the page still works.
 */
export function BalanceChip() {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    void getWallet().then((wallet) => {
      if (!active) return;
      setState(
        wallet.ok ? { status: 'ready', units: wallet.data.balanceUnits } : { status: 'failed' },
      );
    });
    return () => {
      active = false;
    };
  }, []);

  if (state.status === 'failed') return null;
  if (state.status === 'loading') return <Skeleton className="h-11 w-24" aria-hidden="true" />;
  const balance = formatUsd(state.units);
  return (
    <Button
      variant="ghost"
      size="xl"
      className="px-3"
      aria-label={t('header.balance', { balance })}
      render={<Link href="/wallet" />}
    >
      <WalletIcon />
      <bdi dir="ltr" className="font-bold tabular-nums">
        {balance}
      </bdi>
    </Button>
  );
}
