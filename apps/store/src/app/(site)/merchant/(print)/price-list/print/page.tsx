import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { tm } from '@/features/merchant-tools/i18n';
import { PriceListPrintPage } from '@/features/merchant-tools/price-list-print-page';

export const metadata: Metadata = { title: tm('priceList.title'), robots: { index: false } };

/**
 * S21 PL3: the price list to print, outside the merchant area's frame; the options in the URL
 * (hence the boundary); the layout's header and footer are hidden here.
 */
export default function PriceListPrintRoute() {
  return (
    <Suspense fallback={<Skeleton className="mx-auto my-10 h-96 w-full max-w-[180mm]" />}>
      <PriceListPrintPage />
    </Suspense>
  );
}
