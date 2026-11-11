import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { tm } from '@/features/merchant-tools/i18n';
import { StatementPage } from '@/features/merchant-tools/statements-page';

export const metadata: Metadata = { title: tm('nav.statements'), robots: { index: false } };

/** S21 ST2: read in the browser by the month in the URL (hence the boundary). */
export default function MerchantStatementRoute() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <StatementPage />
    </Suspense>
  );
}
