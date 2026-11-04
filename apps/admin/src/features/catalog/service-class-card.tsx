import { type GameDetail, SERVICE_CLASSES, type ServiceClass } from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Card,
  Field,
  FieldDescription,
  FieldLabel,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@vertex-digital/ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { ApiError } from '../../lib/api/client';
import { errorMessage } from '../../lib/errors';
import { useSetServiceClass } from './catalog.queries';

/**
 * The game page's "قسم الرصيد والفواتير" card (S25 CL1): the service class puts the game in the
 * section and under its limits. The API refuses `credit` and `cash` for a game without exactly one
 * required number or digits field (the recipient).
 */
export function ServiceClassCard({ game }: { game: GameDetail }) {
  const { t } = useTranslation();
  const save = useSetServiceClass(game.id);
  const [value, setValue] = useState<ServiceClass>(game.serviceClass);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const label = t('catalog.serviceClass.label');

  async function submit() {
    setFailure(null);
    setSaved(false);
    try {
      await save.mutateAsync(value);
      setSaved(true);
    } catch (error) {
      setFailure(
        error instanceof ApiError && error.code === 'VALIDATION_FAILED'
          ? t('catalog.serviceClass.needsRecipient')
          : errorMessage(t, error),
      );
    }
  }

  return (
    <Card className="gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="flex flex-wrap items-center gap-2 font-bold">
          {t('catalog.serviceClass.title')}
          {game.serviceClass !== 'none' && (
            <Badge tone={game.serviceClass === 'cash' ? 'warning' : 'info'}>
              {t(`catalog.serviceClass.classes.${game.serviceClass}`)}
            </Badge>
          )}
        </h3>
        <p className="text-sm text-muted-foreground">{t('catalog.serviceClass.hint')}</p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Field className="w-full max-w-xs">
          <FieldLabel>{label}</FieldLabel>
          <Select
            items={SERVICE_CLASSES.map((item) => ({
              value: item,
              label: t(`catalog.serviceClass.classes.${item}`),
            }))}
            value={value}
            disabled={game.archivedAt !== null}
            onValueChange={(next) => {
              setValue(next as ServiceClass);
              setFailure(null);
              setSaved(false);
            }}
          >
            <SelectTrigger aria-label={label}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SERVICE_CLASSES.map((item) => (
                <SelectItem key={item} value={item}>
                  {t(`catalog.serviceClass.classes.${item}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FieldDescription>{t(`catalog.serviceClass.hints.${value}`)}</FieldDescription>
        </Field>
        <Button
          variant="outline"
          disabled={save.isPending || value === game.serviceClass || game.archivedAt !== null}
          onClick={submit}
        >
          {t('catalog.actions.save')}
        </Button>
      </div>
      {failure && <FormAlert>{failure}</FormAlert>}
      {saved && (
        <p role="status" className="text-sm font-medium text-status-success-foreground">
          {t('catalog.serviceClass.saved')}
        </p>
      )}
    </Card>
  );
}
