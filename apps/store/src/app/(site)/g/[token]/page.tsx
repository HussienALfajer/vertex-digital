import type { Metadata } from 'next';
import { Suspense } from 'react';
import { shareMetadata } from '@/features/shares/metadata';
import { SharePage, ShareSkeleton } from '@/features/shares/share-page';

type Props = { params: Promise<{ token: string }> };

export function generateMetadata({ params }: Props): Promise<Metadata> {
  return shareMetadata('gift', params);
}

/** The public gift link (S10): rendered per request, never cached, so a revocation shows. */
export default function GiftRoute({ params }: Props) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col px-4 py-10 md:py-16">
      <Suspense fallback={<ShareSkeleton />}>
        <SharePage kind="gift" params={params} />
      </Suspense>
    </div>
  );
}
