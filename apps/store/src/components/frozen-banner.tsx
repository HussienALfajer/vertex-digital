'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { isFrozen, readSession } from '@/lib/session';

// Downloaded only for a frozen customer: the first load stays within its budget.
const FrozenNotice = dynamic(() => import('./frozen-notice').then((module) => module.FrozenNotice));

/**
 * S12 rule CF5: under the header on every page while a frozen customer is signed in, with a link
 * to a ticket about the account. The reason is never shown (the session does not carry it).
 * Read in the browser with the session the header reads, so every page stays static.
 */
export function FrozenBanner() {
  const [frozen, setFrozen] = useState(false);
  useEffect(() => {
    let active = true;
    void readSession().then((session) => {
      if (active) setFrozen(isFrozen(session));
    });
    return () => {
      active = false;
    };
  }, []);
  return frozen ? <FrozenNotice /> : null;
}
