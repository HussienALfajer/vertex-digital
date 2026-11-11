import type { Metadata } from 'next';
import { tm } from '@/features/merchant-tools/i18n';
import { PriceListPage } from '@/features/merchant-tools/price-list-page';

export const metadata: Metadata = { title: tm('nav.priceList'), robots: { index: false } };

/** S21 F36: read in the browser with the session cookie. */
export default function MerchantPriceListRoute() {
  return <PriceListPage />;
}
