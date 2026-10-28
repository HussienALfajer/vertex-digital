'use client';

import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { isFrozen, readSession } from '@/lib/session';
import { useVisibleAgain } from '@/lib/store-status';

// Downloaded only for a frozen customer: the first load stays within its budget.
const FrozenNotice = dynamic(() => import('./frozen-notice').then((module) => module.FrozenNotice));

/**
 * S12 rule CF5: under the header on every page while a frozen customer is signed in, with a link
 * to a ticket about the account. The reason is never shown (the session does not carry it).
 * Read in the browser with the session the header reads, so every page stays static; again on
 * each page and when the tab is seen, so a freeze or an unfreeze shows without a reload (A09-22).
 */
export function FrozenBanner() {
  const pathname = usePathname();
  const seen = useVisibleAgain();
  const [frozen, setFrozen] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: path and visibility are triggers.
  useEffect(() => {
    let active = true;
    void readSession().then((session) => {
      if (active) setFrozen(isFrozen(session));
    });
    return () => {
      active = false;
    };
  }, [pathname, seen]);
  return frozen ? <FrozenNotice /> : null;
}
