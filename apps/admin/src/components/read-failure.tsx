import { Button } from '@vertex-digital/ui';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '../lib/errors';
import { FormAlert } from './form-alert';

/** A failed read inside a dialog or beside a field, with a retry (audit A05-27, A05-36). */
export function ReadFailure({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-start gap-2">
      <FormAlert>{errorMessage(t, error)}</FormAlert>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {t('common.retry')}
      </Button>
    </div>
  );
}
