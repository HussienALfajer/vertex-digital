import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ShopTicketPage } from '@/features/merchant-shop/tickets-page';
import { tm } from '@/features/merchant-tools/i18n';

export const metadata: Metadata = { title: tm('nav.shopTickets'), robots: { index: false } };

/** S26 TK2–TK4: one shop ticket, read in the browser by the id in the URL (hence the boundary). */
export default function MerchantShopTicketRoute() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <ShopTicketPage />
    </Suspense>
  );
}
