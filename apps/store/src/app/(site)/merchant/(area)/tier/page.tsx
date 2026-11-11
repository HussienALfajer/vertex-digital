import type { Metadata } from 'next';
import { tm } from '@/features/merchant-tools/i18n';
import { TierPage } from '@/features/merchant-tools/tier-page';

export const metadata: Metadata = { title: tm('nav.tier'), robots: { index: false } };

/** S23 PG2: read in the browser with the session cookie. */
export default function MerchantTierRoute() {
  return <TierPage />;
}
