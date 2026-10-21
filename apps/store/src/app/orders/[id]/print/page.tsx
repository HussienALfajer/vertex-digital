import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { tm } from '@/features/merchant-tools/i18n';
import { PrintPage } from '@/features/merchant-tools/print-page';

export const metadata: Metadata = { title: tm('print.bar'), robots: { index: false } };

/**
 * S21 PR1: the order's receipt or codes to print, read in the browser with the session cookie by
 * the id in the URL (hence the boundary); the layout's header and footer are hidden here.
 */
export default function OrderPrintRoute() {
  return (
    <Suspense fallback={<Skeleton className="mx-auto my-10 h-96 w-full max-w-[80mm]" />}>
      <PrintPage />
    </Suspense>
  );
}
