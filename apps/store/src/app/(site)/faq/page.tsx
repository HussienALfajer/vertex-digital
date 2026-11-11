import type { Metadata } from 'next';
import { connection } from 'next/server';
import { Suspense } from 'react';
import { ContentPageSkeleton } from '@/features/content/content-page';
import { getPublishedFaq } from '@/features/content/data';
import { FaqView } from '@/features/content/faq-page';
import { t } from '@/lib/i18n';

/** "not found" with `noindex` while unpublished or empty, as the pages (audit A08-39). */
export async function generateMetadata(): Promise<Metadata> {
  await connection();
  const faq = await getPublishedFaq().catch(() => undefined);
  if (faq === null || faq?.sections.length === 0) {
    return { title: t('notFound.title'), robots: { index: false } };
  }
  return { title: t('content.faq.title'), description: t('content.faq.description') };
}

/** S14 FQ5: the published FAQ from the `content` cache; 404 while unpublished or empty. */
export default function FaqRoute() {
  return (
    <Suspense fallback={<ContentPageSkeleton />}>
      <FaqView />
    </Suspense>
  );
}
