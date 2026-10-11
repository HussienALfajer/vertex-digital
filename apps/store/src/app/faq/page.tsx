import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ContentPageSkeleton } from '@/features/content/content-page';
import { FaqView } from '@/features/content/faq-page';
import { t } from '@/lib/i18n';

export const metadata: Metadata = {
  title: t('content.faq.title'),
  description: t('content.faq.description'),
};

/** S14 FQ5: the published FAQ from the `content` cache; 404 while unpublished or empty. */
export default function FaqRoute() {
  return (
    <Suspense fallback={<ContentPageSkeleton />}>
      <FaqView />
    </Suspense>
  );
}
