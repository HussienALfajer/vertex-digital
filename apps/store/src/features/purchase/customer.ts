'use client';

import type { StoreStatus } from '@vertex-digital/contracts';
import { useCallback, useEffect, useState } from 'react';
import { isMoneyEvent, useNotificationEvents } from '@/features/notifications/live';
import { getWallet } from '@/features/wallet/requests';

/*
 * What the buy box knows about the visitor besides the session (session.ts), read in the browser
 * so the game page stays cached (S09 rule BB4, BB7): the wallet balance (live after a credit,
 * S05 NT7) and the purchase stop (SW7, the status route the banner reads).
 */

export type Balance =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; units: number };

/** The balance while `enabled` (signed in); read again after a credit and on `refresh()`. */
export function useBalance(enabled: boolean): { balance: Balance; refresh: () => void } {
  const [balance, setBalance] = useState<Balance>({ status: 'loading' });
  const [reads, setReads] = useState(0);
  const refresh = useCallback(() => setReads((count) => count + 1), []);
  useNotificationEvents((event) => {
    if (enabled && isMoneyEvent(event)) refresh();
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `reads` is the trigger.
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void getWallet().then((wallet) => {
      if (!live) return;
      setBalance(
        wallet.ok ? { status: 'ready', units: wallet.data.balanceUnits } : { status: 'failed' },
      );
    });
    return () => {
      live = false;
    };
  }, [enabled, reads]);
  return { balance, refresh };
}

/** Rule BB7: purchases stopped (S05 SW7); false until known, the server decides anyway. */
export function usePurchasesStopped(): boolean {
  const [stopped, setStopped] = useState(false);
  useEffect(() => {
    let live = true;
    fetch('/api/store/status', { credentials: 'same-origin' })
      .then((response) => (response.ok ? (response.json() as Promise<StoreStatus>) : null))
      .catch(() => null)
      .then((status) => {
        if (live) setStopped(status?.purchasesStopped === true);
      });
    return () => {
      live = false;
    };
  }, []);
  return stopped;
}
