'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { countShopVisit } from './requests';

/**
 * SP3: one visit per page view of the shop, counted by the API (bots left out by user agent, no
 * personal data). Sent from the browser, so a cached page still counts its readers.
 */
export function VisitCounter({ slug }: { slug: string }) {
  const pathname = usePathname();
  // biome-ignore lint/correctness/useExhaustiveDependencies: one count per path shown.
  useEffect(() => {
    void countShopVisit(slug);
  }, [slug, pathname]);
  return null;
}
