import type { Metadata } from 'next';
import { ShopPage } from '@/features/merchant-shop/shop-page';
import { tm } from '@/features/merchant-tools/i18n';

export const metadata: Metadata = { title: tm('nav.shop'), robots: { index: false } };

/** S26 "متجري": read in the browser with the session cookie. */
export default function MerchantShopRoute() {
  return <ShopPage />;
}
