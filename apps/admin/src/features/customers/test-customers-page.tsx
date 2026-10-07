import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import { useInfiniteQuery } from '@tanstack/react-query';
import {
  type CreateTestCustomer,
  createTestCustomerSchema,
  type TestCustomer,
} from '@vertex-digital/contracts';
import {
  Button,
  Callout,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  PageHeader,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@vertex-digital/ui';
import { KeyRoundIcon, PlusIcon, TriangleAlertIcon, UsersRoundIcon } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { CopyButton } from '../../components/copy-button';
import { FormAlert } from '../../components/form-alert';
import { errorCode, errorMessage } from '../../lib/errors';
import { formatDate } from '../../lib/format';
import {
  testCustomersQuery,
  useCreateTestCustomer,
  useResetTestCustomerPassword,
} from './customers.queries';

/** A generated password on screen: once, for this account (rules T1, T2). */
interface ShownPassword {
  kind: 'created' | 'reset';
  email: string;
  password: string;
}

/**
 * Test customers (rules T1–T4): accounts the admin creates while registration is closed, verified
 * at once, with a generated password shown once.
 */
export function TestCustomersPage() {
  const { t } = useTranslation();
  const list = useInfiniteQuery(testCustomersQuery);
  const reset = useResetTestCustomerPassword();
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<TestCustomer | null>(null);
  const [shown, setShown] = useState<ShownPassword | null>(null);
  const customers = list.data?.pages.flatMap((page) => page.items) ?? [];

  const addButton = (
    <Button onClick={() => setAdding(true)}>
      <PlusIcon />
      {t('testCustomers.add')}
    </Button>
  );

  return (
    <>
      <PageHeader
        title={t('testCustomers.title')}
        description={t('testCustomers.subtitle')}
        actions={customers.length > 0 ? addButton : undefined}
      />
      {list.isPending && (
        <div className="flex flex-col gap-2" aria-hidden="true">
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} className="h-11 w-full" />
          ))}
        </div>
      )}
      {list.isError && (
        <div className="flex flex-col items-start gap-3">
          <FormAlert>{errorMessage(t, list.error)}</FormAlert>
          <Button variant="outline" onClick={() => list.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {list.isSuccess && customers.length === 0 && (
        <EmptyState
          icon={<UsersRoundIcon />}
          title={t('testCustomers.emptyTitle')}
          description={t('testCustomers.emptyBody')}
          action={addButton}
        />
      )}
      {customers.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('testCustomers.columns.name')}</TableHead>
              <TableHead>{t('testCustomers.columns.email')}</TableHead>
              <TableHead>{t('testCustomers.columns.phone')}</TableHead>
              <TableHead>{t('testCustomers.columns.createdAt')}</TableHead>
              <TableHead>
                <span className="sr-only">{t('testCustomers.columns.actions')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {customers.map((customer) => (
              <TableRow key={customer.id}>
                <TableCell className="font-medium">{customer.name}</TableCell>
                <TableCell dir="ltr" className="text-end">
                  {customer.email}
                </TableCell>
                <TableCell dir="ltr" className="text-end whitespace-nowrap">
                  {customer.phone}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatDate(customer.createdAt)}
                </TableCell>
                <TableCell className="text-end">
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={t('testCustomers.reset.label', { name: customer.name })}
                    onClick={() => setResetting(customer)}
                  >
                    <KeyRoundIcon />
                    {t('testCustomers.reset.action')}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {list.hasNextPage && (
        <Button
          variant="outline"
          className="self-center"
          disabled={list.isFetchingNextPage}
          onClick={() => list.fetchNextPage()}
        >
          {list.isFetchingNextPage ? t('common.loadingMore') : t('common.loadMore')}
        </Button>
      )}

      <Dialog open={adding} onOpenChange={setAdding}>
        {adding && (
          <AddTestCustomerDialog
            onCreated={(created) => {
              setAdding(false);
              setShown({ kind: 'created', email: created.email, password: created.password });
            }}
          />
        )}
      </Dialog>
      <ConfirmDialog
        open={!!resetting}
        onClose={() => setResetting(null)}
        title={t('testCustomers.reset.title')}
        body={t('testCustomers.reset.body', { name: resetting?.name ?? '' })}
        action={t('testCustomers.reset.confirm')}
        destructive
        pending={reset.isPending}
        onConfirm={async () => {
          if (!resetting) return;
          const { password } = await reset.mutateAsync(resetting.id);
          setShown({ kind: 'reset', email: resetting.email, password });
        }}
      />
      <PasswordOnceDialog shown={shown} onClose={() => setShown(null)} />
    </>
  );
}

function AddTestCustomerDialog({
  onCreated,
}: {
  onCreated: (created: { email: string; password: string }) => void;
}) {
  const { t } = useTranslation();
  const create = useCreateTestCustomer();
  const [failure, setFailure] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CreateTestCustomer>({
    resolver: standardSchemaResolver(createTestCustomerSchema),
    defaultValues: { name: '', email: '', phone: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFailure(null);
    try {
      onCreated(await create.mutateAsync(values));
    } catch (error) {
      // Rule T3: the email must be unused by any customer.
      if (errorCode(error) === 'EMAIL_TAKEN') {
        return setError('email', { type: 'server', message: errorMessage(t, error) });
      }
      setFailure(errorMessage(t, error));
    }
  });

  return (
    <DialogContent closeLabel={t('common.close')}>
      <DialogHeader>
        <DialogTitle>{t('testCustomers.form.title')}</DialogTitle>
        <DialogDescription>{t('testCustomers.form.description')}</DialogDescription>
      </DialogHeader>
      <form className="flex flex-col gap-5" onSubmit={onSubmit} noValidate>
        <Field invalid={!!errors.name}>
          <FieldLabel>{t('testCustomers.form.name')}</FieldLabel>
          <Input autoComplete="off" autoFocus {...register('name')} />
          <FieldError match={!!errors.name}>{t('testCustomers.form.errors.name')}</FieldError>
        </Field>
        <Field invalid={!!errors.email}>
          <FieldLabel>{t('testCustomers.form.email')}</FieldLabel>
          <Input type="email" dir="ltr" autoComplete="off" {...register('email')} />
          <FieldError match={!!errors.email}>
            {errors.email?.type === 'server'
              ? errors.email.message
              : t('testCustomers.form.errors.email')}
          </FieldError>
        </Field>
        <Field invalid={!!errors.phone}>
          <FieldLabel>{t('testCustomers.form.phone')}</FieldLabel>
          <Input type="tel" dir="ltr" autoComplete="off" {...register('phone')} />
          <FieldDescription>{t('testCustomers.form.phoneHint')}</FieldDescription>
          <FieldError match={!!errors.phone}>{t('testCustomers.form.errors.phone')}</FieldError>
        </Field>
        {failure && <FormAlert>{failure}</FormAlert>}
        <DialogFooter>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? t('testCustomers.form.submitting') : t('testCustomers.form.submit')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

/** A generated password, shown once with a copy button and a warning (rules T1, T2). */
function PasswordOnceDialog({
  shown,
  onClose,
}: {
  shown: ShownPassword | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={!!shown} onOpenChange={(open) => !open && onClose()}>
      {shown && (
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {shown.kind === 'created'
                ? t('testCustomers.password.createdTitle')
                : t('testCustomers.password.resetTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('testCustomers.password.body')}{' '}
              <bdi dir="ltr" className="font-medium text-foreground">
                {shown.email}
              </bdi>
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-3">
            <code dir="ltr" className="flex-1 text-base font-medium break-all select-all">
              {shown.password}
            </code>
            <CopyButton value={shown.password} label={t('testCustomers.password.copy')} />
          </div>
          <Callout
            tone="warning"
            icon={<TriangleAlertIcon />}
            title={t('testCustomers.password.warning')}
          />
          <DialogFooter>
            <Button onClick={onClose}>{t('testCustomers.password.done')}</Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );
}
