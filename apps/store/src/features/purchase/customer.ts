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
  | {
      status: 'ready';
      units: number;
      /** S22 BG1: the open reservations, which A02 pays before a new one. */
      reservedUnits: number;
      /** The rate and step a gap's pounds use; null without a rate. */
      syp: { rate: string; stepUnits: number } | null;
    };

/** The balance while `enabled` (signed in); read again after a credit and on `refresh()`. */
export function useBalance(enabled: boolean): { balance: Balance; refresh: () => void } {
  const [balance, setBalance] = useState<Balance>({ status: 'loading' });
  const [reads, setReads] = useState(0);
  const refresh = useCallback(() => setReads((count) => count + 1), []);
  // Signed out, no stream: it would answer 401 (audit A07-2).
  useNotificationEvents((event) => {
    if (isMoneyEvent(event)) refresh();
  }, enabled);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `reads` is the trigger.
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void getWallet().then((wallet) => {
      if (!live) return;
      setBalance(
        wallet.ok
          ? {
              status: 'ready',
              units: wallet.data.balanceUnits,
              reservedUnits: wallet.data.reservedUsdUnits,
              syp: wallet.data.syp && {
                rate: wallet.data.syp.rate,
                stepUnits: wallet.data.syp.displayStepSypUnits,
              },
            }
          : { status: 'failed' },
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
