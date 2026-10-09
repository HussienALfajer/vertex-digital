'use client';

import { formatUsd } from '@vertex-digital/contracts';
import { Button } from '@vertex-digital/ui/components/button';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { WalletIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { isMoneyEvent, useNotificationEvents } from '@/features/notifications/live';
import { t } from '@/lib/i18n';
import { getWallet } from './requests';

type State = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; units: number };

/**
 * The signed-in customer's balance in the header, linking to the wallet (rule W8). Read in the
 * browser, so every page stays cached. The header stays mounted across client navigations, so the
 * chip reads again on each one (the spec: "refreshes on navigation"), keeping the last balance on
 * screen meanwhile, and on each credit or adjustment from the notification stream (S05 rule NT7).
 * A failed read hides the chip: the page still works.
 */
export function BalanceChip() {
  const pathname = usePathname();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [changes, setChanges] = useState(0);

  useNotificationEvents((event) => {
    if (isMoneyEvent(event)) setChanges((count) => count + 1);
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: path and changes are triggers.
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
  }, [pathname, changes]);

  if (state.status === 'failed') return null;
  if (state.status === 'loading') return <Skeleton className="h-11 w-24" aria-hidden="true" />;
  const balance = formatUsd(state.units);
  return (
    <Button
      variant="ghost"
      size="xl"
      className="px-2 sm:px-3"
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
