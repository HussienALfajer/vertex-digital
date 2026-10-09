import { useQuery } from '@tanstack/react-query';
import {
  formatAmountInput,
  formatUsd,
  parseUsd,
  type StoreSwitch,
  type SupplierDetail,
  setSupplierCredentialsSchema,
  supplierHasCatalog,
  updateSupplierSchema,
} from '@vertex-digital/contracts';
import {
  Button,
  Card,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  PasswordInput,
  Skeleton,
  Switch,
} from '@vertex-digital/ui';
import { KeyRoundIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import { switchesQuery, useChangeSwitch } from '../settings/settings.queries';
import { credentialLabel } from './credential-fields';
import { LastRun } from './supplier-parts';
import { useSetCredentials, useUpdateSupplier } from './suppliers.queries';

/**
 * "الاتصال" (S07 screens): the credentials by their hints only (rule SP2) and the connection test
 * that follows a change, the pause switch (rule SP3, the S05 write path) and the low-balance
 * threshold (A07).
 */
export function ConnectionTab({ supplier }: { supplier: SupplierDetail }) {
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <CredentialsCard supplier={supplier} />
      <div className="flex flex-col gap-6">
        <PauseCard supplier={supplier} />
        {supplier.code !== 'manual' && (
          // A new key resets the form to the saved threshold once it changes.
          <ThresholdCard key={supplier.lowBalanceUsdUnits} supplier={supplier} />
        )}
      </div>
    </div>
  );
}

function CredentialsCard({ supplier }: { supplier: SupplierDetail }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const fields = supplier.credentialFields;
  if (fields.length === 0) {
    return (
      <Card className="gap-2">
        <CardTitle>{t('suppliers.credentials.title')}</CardTitle>
        <p className="text-base text-muted-foreground">{t('suppliers.credentials.none')}</p>
      </Card>
    );
  }
  return (
    <Card className="gap-4">
      <div className="flex flex-col gap-1">
        <CardTitle>{t('suppliers.credentials.title')}</CardTitle>
        <p className="text-sm text-muted-foreground">
          {supplier.credentials
            ? t('suppliers.credentials.setAt', { time: formatDateTime(supplier.credentials.setAt) })
            : t('suppliers.credentials.notSet')}
        </p>
      </div>
      <dl className="flex flex-col gap-3 text-sm">
        {fields.map((field) => {
          const hint = supplier.credentials?.hints[field];
          return (
            <div key={field} className="flex flex-wrap items-center justify-between gap-2">
              <dt className="font-medium">{credentialLabel(t, field)}</dt>
              <dd className="text-muted-foreground">
                {supplier.credentials ? (
                  hint ? (
                    <bdi dir="ltr">…{hint}</bdi>
                  ) : (
                    t('suppliers.credentials.hidden')
                  )
                ) : (
                  t('suppliers.credentials.empty')
                )}
              </dd>
            </div>
          );
        })}
      </dl>
      <Button className="self-start" onClick={() => setOpen(true)}>
        <KeyRoundIcon />
        {t('suppliers.credentials.set')}
      </Button>
      {supplierHasCatalog(supplier.code) && supplier.credentials && (
        <section className="flex flex-col gap-2 rounded-lg bg-muted p-4" aria-live="polite">
          <h3 className="text-base font-bold">{t('suppliers.credentials.test')}</h3>
          <LastRun run={supplier.lastRun} />
        </section>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        {open && <CredentialsDialog supplier={supplier} onDone={() => setOpen(false)} />}
      </Dialog>
    </Card>
  );
}

/** Empty password fields, one per credential field; values are never read back (rule SP2). */
function CredentialsDialog({ supplier, onDone }: { supplier: SupplierDetail; onDone: () => void }) {
  const { t } = useTranslation();
  const setCredentials = useSetCredentials(supplier.code);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(supplier.credentialFields.map((field) => [field, ''])),
  );
  const [invalid, setInvalid] = useState<string[]>([]);
  const [failure, setFailure] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const parsed = setSupplierCredentialsSchema.safeParse({ values });
    const found = parsed.success
      ? []
      : supplier.credentialFields.filter((field) =>
          parsed.error.issues.some((issue) => issue.path[1] === field),
        );
    setInvalid(found);
    if (!parsed.success) return;
    try {
      await setCredentials.mutateAsync(parsed.data);
      onDone();
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <DialogContent closeLabel={t('common.close')} className="max-w-lg">
      <DialogHeader>
        <DialogTitle>
          {t('suppliers.credentials.dialogTitle', { name: supplier.nameAr })}
        </DialogTitle>
        <DialogDescription>{t('suppliers.credentials.dialogDescription')}</DialogDescription>
      </DialogHeader>
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        {supplier.credentialFields.map((field) => (
          <Field key={field} invalid={invalid.includes(field)}>
            <FieldLabel>{credentialLabel(t, field)}</FieldLabel>
            <PasswordInput
              name={field}
              dir="ltr"
              // A supplier key is not the panel's password: keep password managers away from it.
              autoComplete="new-password"
              data-1p-ignore
              data-lpignore="true"
              showLabel={t('suppliers.credentials.show')}
              hideLabel={t('suppliers.credentials.hide')}
              value={values[field] ?? ''}
              onChange={(event) =>
                setValues((previous) => ({ ...previous, [field]: event.target.value }))
              }
            />
            <FieldError match={invalid.includes(field)}>
              {t('suppliers.credentials.errors.value')}
            </FieldError>
          </Field>
        ))}
        {failure && <FormAlert>{failure}</FormAlert>}
        <DialogFooter>
          <Button type="submit" disabled={setCredentials.isPending}>
            {setCredentials.isPending
              ? t('suppliers.credentials.saving')
              : t('suppliers.credentials.save')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

/** Rule SP3: the supplier's switch, changed through the S05 dialog and re-authentication. */
function PauseCard({ supplier }: { supplier: SupplierDetail }) {
  const { t } = useTranslation();
  const switches = useQuery(switchesQuery);
  const change = useChangeSwitch();
  const [confirming, setConfirming] = useState(false);
  const name = `${supplier.code}_paused` as StoreSwitch;
  const item = switches.data?.switches.find((entry) => entry.switch === name);
  const value = !supplier.paused;
  const key = `switches.confirm.${name}.${value}` as const;
  return (
    <Card className="gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <CardTitle>
            <label htmlFor="supplier-paused">{t('suppliers.pause.title')}</label>
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {supplier.paused ? t('suppliers.pause.on') : t('suppliers.pause.off')}
          </p>
          {item?.since && supplier.paused && (
            <p className="text-sm text-muted-foreground">
              {t('suppliers.pause.since', { time: formatDateTime(item.since) })}
            </p>
          )}
        </div>
        {switches.isPending ? (
          <Skeleton className="h-6 w-11" />
        ) : (
          <Switch
            id="supplier-paused"
            checked={supplier.paused}
            onCheckedChange={() => setConfirming(true)}
          />
        )}
      </div>
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t(`${key}.title`)}
        body={t(`${key}.body`)}
        action={t(`${key}.action`)}
        destructive={value}
        pending={change.isPending}
        onConfirm={async () => {
          await change.mutateAsync({ switch: name, value });
        }}
      />
    </Card>
  );
}

/** A07: the balance below which the admin is alerted, in whole cents. */
function ThresholdCard({ supplier }: { supplier: SupplierDetail }) {
  const { t } = useTranslation();
  const update = useUpdateSupplier(supplier.code);
  const [text, setText] = useState(() => formatAmountInput('USD', supplier.lowBalanceUsdUnits));
  const [invalid, setInvalid] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    setSaved(false);
    const parsed = updateSupplierSchema.safeParse({ lowBalanceUsdUnits: parseUsd(text) });
    setInvalid(!parsed.success);
    if (!parsed.success) return;
    try {
      await update.mutateAsync(parsed.data);
      setSaved(true);
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <Card className="gap-4">
      <div className="flex flex-col gap-1">
        <CardTitle>{t('suppliers.threshold.title')}</CardTitle>
        <p className="text-sm text-muted-foreground">
          {t('suppliers.threshold.current', { amount: formatUsd(supplier.lowBalanceUsdUnits) })}
        </p>
      </div>
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <Field invalid={invalid}>
          <FieldLabel>{t('suppliers.threshold.label')}</FieldLabel>
          <Input
            name="lowBalance"
            dir="ltr"
            inputMode="decimal"
            autoComplete="off"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setSaved(false);
            }}
          />
          <FieldDescription>{t('suppliers.threshold.hint')}</FieldDescription>
          <FieldError match={invalid}>{t('suppliers.threshold.error')}</FieldError>
        </Field>
        {failure && <FormAlert>{failure}</FormAlert>}
        {saved && (
          <p role="status" className="text-sm font-medium text-status-success-foreground">
            {t('suppliers.threshold.saved')}
          </p>
        )}
        <Button type="submit" className="self-start" disabled={update.isPending}>
          {update.isPending ? t('suppliers.threshold.saving') : t('suppliers.threshold.save')}
        </Button>
      </form>
    </Card>
  );
}
