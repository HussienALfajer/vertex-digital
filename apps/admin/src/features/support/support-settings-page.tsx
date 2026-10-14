import { useQuery } from '@tanstack/react-query';
import { telegramSupportUrlSchema } from '@vertex-digital/contracts';
import {
  Button,
  Card,
  EmptyState,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  PageHeader,
  Skeleton,
  useFocusInvalid,
} from '@vertex-digital/ui';
import { CircleAlertIcon, CircleCheckIcon, SendIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { supportSettingsQuery, useSaveSupportSettings } from './support.queries';

/**
 * "إعدادات الدعم" (S12 SC1): the Telegram support link the store shows, validated as
 * `https://t.me/<name>` with a preview; saving asks for re-authentication. Empty hides it.
 */
export function SupportSettingsPage() {
  const { t } = useTranslation();
  const settings = useQuery(supportSettingsQuery);
  return (
    <>
      <PageHeader
        title={t('support.settings.title')}
        description={t('support.settings.subtitle')}
      />
      {settings.isPending && <Skeleton className="h-64 w-full max-w-2xl" aria-hidden="true" />}
      {settings.isError && (
        <EmptyState
          icon={<CircleAlertIcon />}
          title={errorMessage(t, settings.error)}
          action={
            <Button variant="outline" onClick={() => settings.refetch()}>
              {t('common.retry')}
            </Button>
          }
        />
      )}
      {settings.data && <SettingsForm saved={settings.data.telegramUrl} />}
    </>
  );
}

function SettingsForm({ saved }: { saved: string | null }) {
  const { t } = useTranslation();
  const save = useSaveSupportSettings();
  const [value, setValue] = useState(saved ?? '');
  const [invalid, setInvalid] = useState(false);
  const { ref, focusInvalid } = useFocusInvalid();
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const trimmed = value.trim();
  const valid = trimmed === '' || telegramSupportUrlSchema.safeParse(trimmed).success;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    setDone(false);
    setInvalid(!valid);
    if (!valid) return focusInvalid();
    try {
      await save.mutateAsync({ telegramUrl: trimmed === '' ? null : trimmed });
      setDone(true);
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <Card className="max-w-2xl gap-6">
      <form ref={ref} className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <Field invalid={invalid}>
          <FieldLabel>{t('support.settings.telegram')}</FieldLabel>
          <Input
            name="telegramUrl"
            type="url"
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://t.me/"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setDone(false);
            }}
          />
          <FieldDescription>{t('support.settings.telegramHint')}</FieldDescription>
          <FieldError match={invalid}>{t('support.settings.telegramError')}</FieldError>
        </Field>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">{t('support.settings.preview')}</span>
          <div className="rounded-md border border-dashed border-border bg-muted px-4 py-3">
            {trimmed && valid ? (
              <a
                href={trimmed}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 font-medium underline-offset-4 hover:underline"
              >
                <SendIcon className="size-4 rtl:-scale-x-100" aria-hidden="true" />
                {t('support.settings.previewLabel')}
                <bdi dir="ltr" className="text-sm font-normal text-muted-foreground">
                  {trimmed}
                </bdi>
              </a>
            ) : (
              <span className="text-sm text-muted-foreground">
                {trimmed ? t('support.settings.telegramError') : t('support.settings.previewEmpty')}
              </span>
            )}
          </div>
        </div>
        {failure && <FormAlert>{failure}</FormAlert>}
        {done && (
          <p role="status" className="flex items-center gap-2 text-status-success-foreground">
            <CircleCheckIcon className="size-5" aria-hidden="true" />
            {t('support.settings.saved')}
          </p>
        )}
        <Button type="submit" className="self-start" disabled={save.isPending}>
          {save.isPending ? t('support.settings.saving') : t('support.settings.save')}
        </Button>
      </form>
    </Card>
  );
}
