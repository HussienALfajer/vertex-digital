import { Button } from '@vertex-digital/ui/components/button';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import type { Metadata } from 'next';
import Link from 'next/link';
import { t } from '@/lib/i18n';

// The tab and the screen reader say what happened (audit A10-60).
export const metadata: Metadata = { title: t('notFound.title'), robots: { index: false } };

export default function NotFound() {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-16">
      <EmptyState
        titleAs="h1"
        title={t('notFound.title')}
        description={t('notFound.body')}
        action={
          <Button size="xl" render={<Link href="/" />}>
            {t('notFound.back')}
          </Button>
        }
      />
    </div>
  );
}
