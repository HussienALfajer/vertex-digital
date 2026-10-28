import { Button, Skeleton } from '@vertex-digital/ui';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';

/** The reconciliation's loading and error blocks, shared by its tabs and the run page. */

export function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-start gap-3">
      <FormAlert>{errorMessage(t, error)}</FormAlert>
      <Button variant="outline" onClick={onRetry}>
        {t('common.retry')}
      </Button>
    </div>
  );
}

export function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      {Array.from({ length: 4 }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholders without identity.
        <Skeleton key={index} className="h-11 w-full" />
      ))}
    </div>
  );
}

/**
 * A run's failure is the worker's English error: labelled in Arabic, kept left to right so its
 * punctuation stays in place (audit A09-35).
 */
export function FailureLine({ failure }: { failure: string }) {
  const { t } = useTranslation();
  return (
    <p className="text-sm text-muted-foreground">
      {t('reconciliation.status.failure')} <bdi dir="ltr">{failure}</bdi>
    </p>
  );
}
