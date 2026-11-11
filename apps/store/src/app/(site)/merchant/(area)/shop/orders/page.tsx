import type { Metadata } from 'next';
import { ShopOrdersPage } from '@/features/merchant-shop/orders-page';
import { tm } from '@/features/merchant-tools/i18n';

export const metadata: Metadata = { title: tm('nav.shopOrders'), robots: { index: false } };

/** S26 PR9 "طلبات المتجر": read in the browser with the session cookie. */
export default function MerchantShopOrdersRoute() {
  return <ShopOrdersPage />;
}
