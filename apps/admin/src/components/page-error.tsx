import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { AscentBar, Button } from '@vertex-digital/ui';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { reportClientError } from '../lib/report-error';

/** A failed load of one of the build's chunks: after a deploy, only a full reload helps. */
export const isChunkLoadError = (error: unknown) =>
  error instanceof Error &&
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(
    error.message,
  );

/**
 * A page that failed to render, inside the shell (the router's `defaultErrorComponent`, audit
 * A10-27): the sidebar stays, the error goes to Sentry, and "أعد المحاولة" renders the page again
 * after reading its data again; a chunk of an earlier release reloads the panel instead.
 */
export function PageError({ error, reset }: { error: unknown; reset: () => void }) {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  useEffect(() => reportClientError(error), [error]);
  const retry = () => {
    if (isChunkLoadError(error)) {
      window.location.reload();
      return;
    }
    // The failed page's queries are inactive now: dropped, so it reads its data again instead of
    // rendering the same answer that broke it.
    queryClient.removeQueries({ type: 'inactive' });
    reset();
    void router.invalidate();
  };
  return (
    <div role="alert" className="flex max-w-md flex-col items-start gap-4 py-8">
      <div className="flex items-center gap-3">
        <AscentBar />
        <h1 className="text-2xl font-bold">{t('common.errorTitle')}</h1>
      </div>
      <p className="text-muted-foreground">{t('common.pageErrorBody')}</p>
      <Button onClick={retry}>{t('common.retry')}</Button>
    </div>
  );
}
