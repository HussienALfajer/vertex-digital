import type { Metadata } from 'next';
import { ShopTicketsPage } from '@/features/merchant-shop/tickets-page';
import { tm } from '@/features/merchant-tools/i18n';

export const metadata: Metadata = { title: tm('nav.shopTickets'), robots: { index: false } };

/** S26 TK1–TK4 "تذاكر المتجر": read in the browser with the session cookie. */
export default function MerchantShopTicketsRoute() {
  return <ShopTicketsPage />;
}
