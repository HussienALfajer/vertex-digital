import type { Metadata } from 'next';
import { ShopStatsPage } from '@/features/merchant-shop/stats-page';
import { tm } from '@/features/merchant-tools/i18n';

export const metadata: Metadata = { title: tm('nav.shopStats'), robots: { index: false } };

/** S26 SP3 "الإحصاءات": read in the browser with the session cookie. */
export default function MerchantShopStatsRoute() {
  return <ShopStatsPage />;
}
