'use client';

import type { StoreStatus } from '@vertex-digital/contracts';
import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';

// Downloaded only while something is stopped: the first load stays within its budget.
const StopNotice = dynamic(() => import('./stop-notice').then((module) => module.StopNotice));

/**
 * The emergency stop notice (S05 rule SW9): a calm fixed text under the header on every page
 * while purchases or deposits are stopped, naming what is stopped. Read in the browser so every
 * page stays static; the API lets the browser keep the answer for 10 seconds.
 */
export function StopBanner() {
  const [status, setStatus] = useState<StoreStatus | null>(null);

  useEffect(() => {
    let active = true;
    fetch('/api/store/status', { credentials: 'same-origin' })
      .then((response) => (response.ok ? (response.json() as Promise<StoreStatus>) : null))
      .catch(() => null)
      .then((value) => {
        if (active) setStatus(value);
      });
    return () => {
      active = false;
    };
  }, []);

  const stopped =
    status?.purchasesStopped && status.depositsStopped
      ? 'both'
      : status?.purchasesStopped
        ? 'purchases'
        : status?.depositsStopped
          ? 'deposits'
          : null;
  return stopped ? <StopNotice stopped={stopped} /> : null;
}
