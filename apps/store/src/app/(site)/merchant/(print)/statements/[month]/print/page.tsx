import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { tm } from '@/features/merchant-tools/i18n';
import { StatementPrintPage } from '@/features/merchant-tools/statement-print-page';

export const metadata: Metadata = { title: tm('statements.title'), robots: { index: false } };

/**
 * S21 ST3: a month's statement to print, outside the merchant area's frame, by the month in the
 * URL (hence the boundary); the layout's header and footer are hidden here.
 */
export default function StatementPrintRoute() {
  return (
    <Suspense fallback={<Skeleton className="mx-auto my-10 h-96 w-full max-w-[180mm]" />}>
      <StatementPrintPage />
    </Suspense>
  );
}
