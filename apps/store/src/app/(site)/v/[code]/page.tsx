import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { tm } from '@/features/merchant-tools/i18n';
import { VerifyPage } from '@/features/merchant-tools/verify-page';

type Props = { params: Promise<{ code: string }> };

export const metadata: Metadata = {
  title: tm('verify.title'),
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

/** S21 VF2: a receipt's verification page, phone first, rendered per request, never indexed. */
export default function VerifyRoute({ params }: Props) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col px-4 py-10 md:py-16">
      <Suspense fallback={<Skeleton className="h-96 w-full rounded-xl" />}>
        <VerifyPage params={params} />
      </Suspense>
    </div>
  );
}
