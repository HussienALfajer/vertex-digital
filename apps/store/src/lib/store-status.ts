'use client';

import type { StoreStatus } from '@vertex-digital/contracts';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

/**
 * Bumps when the tab is seen again, so a read that depends on it runs once more then.
 */
export function useVisibleAgain(): number {
  const [seen, setSeen] = useState(0);
  useEffect(() => {
    const onChange = () => {
      if (document.visibilityState === 'visible') setSeen((count) => count + 1);
    };
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return seen;
}

/**
 * The store's switches (S05 rules SW1, SW9; BB7): read in the browser on mount, again on every
 * client navigation (the layout stays mounted across them) and when the tab is seen again, so the
 * banner and the buy box follow a stop or a reopen without a reload (audit A09-22). The API lets
 * the browser keep the answer for 10 seconds. Null until known or when the read fails.
 */
export function useStoreStatus(): StoreStatus | null {
  const pathname = usePathname();
  const seen = useVisibleAgain();
  const [status, setStatus] = useState<StoreStatus | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: path and visibility are triggers.
  useEffect(() => {
    let active = true;
    fetch('/api/store/status', { credentials: 'same-origin' })
      .then((response) => (response.ok ? (response.json() as Promise<StoreStatus>) : null))
      .catch(() => null)
      .then((value) => {
        // A failed read keeps what is shown: the server decides anyway.
        if (active && value) setStatus(value);
      });
    return () => {
      active = false;
    };
  }, [pathname, seen]);
  return status;
}
