import type { Metadata } from 'next';
import { tm } from '@/features/merchant-tools/i18n';
import { PricesPage } from '@/features/merchant-tools/prices-page';

export const metadata: Metadata = { title: tm('nav.prices'), robots: { index: false } };

/** S21 F31: read in the browser with the session cookie. */
export default function MerchantPricesRoute() {
  return <PricesPage />;
}
