import {
  formatAmountInput,
  parseUsd,
  type ReconciliationSettings,
  reconciliationSettingsSchema,
} from '@vertex-digital/contracts';
import {
  Button,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  Sheet,
  SheetContent,
  SheetTitle,
  toast,
} from '@vertex-digital/ui';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { useUpdateSettings } from './reconciliation.queries';

/**
 * The settings drawer (rules E1, E5): the tolerance of the external checks in dollars and the days
 * without a Sham Cash count before a warning. Saved after re-authentication.
 */
export function SettingsSheet({
  open,
  settings,
  onClose,
}: {
  open: boolean;
  settings: ReconciliationSettings;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent className="w-[min(28rem,100vw)] max-w-none overflow-y-auto bg-surface p-6">
        <SheetTitle className="mb-1 text-xl font-bold">
          {t('reconciliation.settings.title')}
        </SheetTitle>
        <p className="mb-6 text-sm text-muted-foreground">
          {t('reconciliation.settings.description')}
        </p>
        {open && <SettingsForm settings={settings} onDone={onClose} />}
      </SheetContent>
    </Sheet>
  );
}

function SettingsForm({
  settings,
  onDone,
}: {
  settings: ReconciliationSettings;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const update = useUpdateSettings();
  const [errors, setErrors] = useState<{ tolerance?: boolean; days?: boolean }>({});
  const [failure, setFailure] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const data = new FormData(event.currentTarget);
    const days = String(data.get('countStaleDays') ?? '').trim();
    const parsed = reconciliationSettingsSchema.safeParse({
      toleranceUsdUnits: parseUsd(String(data.get('tolerance') ?? '')) ?? Number.NaN,
      countStaleDays: /^\d{1,3}$/.test(days) ? Number(days) : Number.NaN,
    });
    const paths = new Set(parsed.error?.issues.map((issue) => issue.path[0]));
    setErrors({ tolerance: paths.has('toleranceUsdUnits'), days: paths.has('countStaleDays') });
    if (!parsed.success) return;
    try {
      await update.mutateAsync(parsed.data);
      toast.add({ title: t('reconciliation.settings.saved'), type: 'success' });
      onDone();
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
      <Field invalid={errors.tolerance}>
        <FieldLabel>{t('reconciliation.settings.tolerance')}</FieldLabel>
        <Input
          name="tolerance"
          dir="ltr"
          inputMode="decimal"
          autoComplete="off"
          defaultValue={formatAmountInput('USD', settings.toleranceUsdUnits)}
        />
        <FieldDescription>{t('reconciliation.settings.toleranceHint')}</FieldDescription>
        <FieldError match={!!errors.tolerance}>
          {t('reconciliation.settings.errors.tolerance')}
        </FieldError>
      </Field>
      <Field invalid={errors.days}>
        <FieldLabel>{t('reconciliation.settings.staleDays')}</FieldLabel>
        <Input
          name="countStaleDays"
          dir="ltr"
          inputMode="numeric"
          autoComplete="off"
          defaultValue={String(settings.countStaleDays)}
        />
        <FieldDescription>{t('reconciliation.settings.staleDaysHint')}</FieldDescription>
        <FieldError match={!!errors.days}>{t('reconciliation.settings.errors.days')}</FieldError>
      </Field>
      {failure && <FormAlert>{failure}</FormAlert>}
      <div className="flex gap-2">
        <Button type="submit" disabled={update.isPending}>
          {update.isPending ? t('reconciliation.saving') : t('reconciliation.settings.submit')}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}
