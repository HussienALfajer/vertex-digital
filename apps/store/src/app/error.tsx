'use client';

import { Button } from '@vertex-digital/ui/components/button';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { isChunkLoadError } from '@/lib/chunk-error';
import { t } from '@/lib/i18n';

export default function ErrorPage({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // A failed server read (the catalog, S09) is only fetched again by a refresh: `reset()` alone
  // re-renders the same failed payload (audit A03-7). A chunk of an earlier release needs a full
  // reload: the refresh would ask for it again (audit A10-7).
  function retry() {
    if (isChunkLoadError(error)) {
      window.location.reload();
      return;
    }
    startTransition(() => {
      router.refresh();
      reset();
    });
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-16">
      <EmptyState
        titleAs="h1"
        title={t('error.title')}
        description={t('error.body')}
        action={
          <Button size="xl" onClick={retry} disabled={pending}>
            {t('error.retry')}
          </Button>
        }
      />
    </div>
  );
}
