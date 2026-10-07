'use client';

import { Button } from '@vertex-digital/ui/components/button';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { t } from '@/lib/i18n';

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-16">
      <EmptyState
        title={t('error.title')}
        description={t('error.body')}
        action={
          <Button size="xl" onClick={reset}>
            {t('error.retry')}
          </Button>
        }
      />
    </div>
  );
}
