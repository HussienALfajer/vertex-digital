import { explainResultSchema, type OpenMismatch } from '@vertex-digital/contracts';
import {
  Button,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Textarea,
  useFocusInvalid,
} from '@vertex-digital/ui';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { useExplainResult } from './reconciliation.queries';
import { subjectLabel } from './reconciliation-labels';

/**
 * "شرح" (rule RN8): a note on an open mismatch closes it; the same difference found by a later
 * run opens again.
 */
export function ExplainDialog({ result, onDone }: { result: OpenMismatch; onDone: () => void }) {
  const { t } = useTranslation();
  const explain = useExplainResult();
  const [invalid, setInvalid] = useState(false);
  const { ref, focusInvalid } = useFocusInvalid();
  const [failure, setFailure] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const parsed = explainResultSchema.safeParse({
      note: String(new FormData(event.currentTarget).get('note') ?? ''),
    });
    setInvalid(!parsed.success);
    if (!parsed.success) return focusInvalid();
    try {
      await explain.mutateAsync({ id: result.id, body: parsed.data });
      onDone();
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <DialogContent closeLabel={t('common.close')}>
      <DialogHeader>
        <DialogTitle>{t('reconciliation.explain.title')}</DialogTitle>
        <DialogDescription>
          {t('reconciliation.explain.description', {
            check: t(`reconciliation.checks.${result.check}`),
            subject: subjectLabel(t, result.subject),
          })}
        </DialogDescription>
      </DialogHeader>
      <form ref={ref} className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <Field invalid={invalid}>
          <FieldLabel>{t('reconciliation.explain.note')}</FieldLabel>
          <Textarea name="note" rows={3} maxLength={500} autoFocus />
          <FieldDescription>{t('reconciliation.explain.noteHint')}</FieldDescription>
          <FieldError match={invalid}>{t('reconciliation.explain.error')}</FieldError>
        </Field>
        {failure && <FormAlert>{failure}</FormAlert>}
        <DialogFooter>
          <Button type="submit" disabled={explain.isPending}>
            {explain.isPending ? t('reconciliation.saving') : t('reconciliation.explain.submit')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
