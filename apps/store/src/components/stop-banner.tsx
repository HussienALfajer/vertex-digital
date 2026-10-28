'use client';

import dynamic from 'next/dynamic';
import { useStoreStatus } from '@/lib/store-status';

// Downloaded only while something is stopped: the first load stays within its budget.
const StopNotice = dynamic(() => import('./stop-notice').then((module) => module.StopNotice));

/**
 * The emergency stop notice (S05 rule SW9): a calm fixed text under the header on every page
 * while purchases or deposits are stopped, naming what is stopped. Read in the browser so every
 * page stays static, again on each page and when the tab is seen (audit A09-22).
 */
export function StopBanner() {
  const status = useStoreStatus();

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
