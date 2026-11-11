import type { Metadata } from 'next';
import { CustomersPage } from '@/features/merchant-shop/customers-page';
import { tm } from '@/features/merchant-tools/i18n';

export const metadata: Metadata = { title: tm('nav.shopCustomers'), robots: { index: false } };

/** S26 "الزبائن": read in the browser with the session cookie. */
export default function MerchantShopCustomersRoute() {
  return <CustomersPage />;
}
