import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import type { Metadata } from 'next';
import { Suspense } from 'react';
import { CertificatePublicPage } from '@/features/merchant-tools/certificate-public-page';
import { tm } from '@/features/merchant-tools/i18n';

type Props = { params: Promise<{ code: string }> };

export const metadata: Metadata = {
  title: tm('tier.public.title'),
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

/** S23 ID7: a merchant certificate's page, phone first, rendered per request, never indexed. */
export default function CertificateRoute({ params }: Props) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col px-4 py-10 md:py-16">
      <Suspense fallback={<Skeleton className="h-80 w-full rounded-xl" />}>
        <CertificatePublicPage params={params} />
      </Suspense>
    </div>
  );
}
