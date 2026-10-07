import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { describeUserAgent, type AdminSession as OwnSession } from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  FieldError,
  FieldLabel,
  PageHeader,
  PasswordInput,
  Skeleton,
  toast,
} from '@vertex-digital/ui';
import { DownloadIcon, MonitorSmartphoneIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { FormAlert } from '../../components/form-alert';
import { leaveSession } from '../../lib/auth';
import { errorMessage, type Failure, passwordFailure } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import { accountSessionsQuery, useGenerateBackupCodes, useRevokeSession } from './account.queries';
import { BackupCodes } from './backup-codes';
import { ChangePasswordForm } from './change-password-form';

/** The admin's own account (rules D7): password, backup codes and open sessions. */
export function AccountPage() {
  const { t } = useTranslation();
  return (
    <>
      <PageHeader title={t('account.title')} description={t('account.subtitle')} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t('account.password.title')}</CardTitle>
            <CardDescription>{t('account.password.description')}</CardDescription>
          </CardHeader>
          <ChangePasswordForm
            submitClassName="self-start"
            onChanged={() => {
              toast.add({ title: t('changePassword.changed'), type: 'success' });
            }}
          />
        </Card>
        <BackupCodesCard />
      </div>
      <SessionsCard />
    </>
  );
}

/** Rule D7: new backup codes need the password and are shown once. */
function BackupCodesCard() {
  const { t } = useTranslation();
  const [codes, setCodes] = useState<string[] | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const generateCodes = useGenerateBackupCodes();

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const password = String(new FormData(form).get('password') ?? '');
    if (!password) return setFailure({ message: t('changePassword.errors.current'), field: true });
    setFailure(null);
    try {
      setCodes(await generateCodes.mutateAsync(password));
      form.reset();
    } catch (error) {
      setFailure(passwordFailure(t, error));
    }
  }

  function download(values: string[]) {
    const url = URL.createObjectURL(new Blob([`${values.join('\n')}\n`], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = t('account.backupCodes.fileName');
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('account.backupCodes.title')}</CardTitle>
        <CardDescription>{t('account.backupCodes.description')}</CardDescription>
      </CardHeader>
      {codes ? (
        <div className="flex flex-col gap-4">
          <p role="status" className="text-sm font-medium">
            {t('account.backupCodes.shown')}
          </p>
          <BackupCodes codes={codes} />
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => download(codes)}>
              <DownloadIcon />
              {t('account.backupCodes.download')}
            </Button>
            <Button variant="ghost" onClick={() => setCodes(null)}>
              {t('account.backupCodes.done')}
            </Button>
          </div>
        </div>
      ) : (
        <form className="flex flex-col gap-5" onSubmit={generate} noValidate>
          <Field invalid={failure?.field}>
            <FieldLabel>{t('account.backupCodes.password')}</FieldLabel>
            <PasswordInput
              name="password"
              showLabel={t('common.showPassword')}
              hideLabel={t('common.hidePassword')}
              autoComplete="current-password"
            />
            <FieldError match={!!failure?.field}>{failure?.message}</FieldError>
          </Field>
          {failure && !failure.field && <FormAlert>{failure.message}</FormAlert>}
          <Button type="submit" className="self-start" disabled={generateCodes.isPending}>
            {generateCodes.isPending
              ? t('account.backupCodes.generating')
              : t('account.backupCodes.generate')}
          </Button>
        </form>
      )}
    </Card>
  );
}

/** The admin's own sessions; signing out the current one ends on the sign-in page. */
function SessionsCard() {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const sessions = useQuery(accountSessionsQuery);
  const revoke = useRevokeSession();
  const [target, setTarget] = useState<OwnSession | null>(null);

  const deviceOf = (session: OwnSession) => {
    const { browser, system } = describeUserAgent(session.userAgent);
    const unknown = t('common.unknown');
    return t('account.sessions.device', {
      browser: browser === 'Unknown' ? unknown : browser,
      system: system === 'Unknown' ? unknown : system,
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('account.sessions.title')}</CardTitle>
        <CardDescription>{t('account.sessions.description')}</CardDescription>
      </CardHeader>
      {sessions.isPending && (
        <div className="flex flex-col gap-3" aria-hidden="true">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      )}
      {sessions.isError && (
        <div className="flex flex-col items-start gap-3">
          <FormAlert>{errorMessage(t, sessions.error)}</FormAlert>
          <Button variant="outline" onClick={() => sessions.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {sessions.data && (
        <ul className="flex flex-col">
          {sessions.data.map((session) => {
            const device = deviceOf(session);
            return (
              <li
                key={session.id}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 first:pt-0 last:border-b-0 last:pb-0"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <MonitorSmartphoneIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{device}</span>
                      {session.current && (
                        <Badge tone="success">{t('account.sessions.thisSession')}</Badge>
                      )}
                    </div>
                    <span className="text-sm text-muted-foreground">
                      {t('account.sessions.signedIn', { date: formatDateTime(session.createdAt) })}
                      {' · '}
                      {t('account.sessions.lastActive', {
                        date: formatDateTime(session.lastActiveAt),
                      })}
                    </span>
                    {session.ipAddress && (
                      <span className="text-sm text-muted-foreground">
                        {t('account.sessions.ip', { ip: session.ipAddress })}
                      </span>
                    )}
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={t('account.sessions.signOutLabel', { device })}
                  onClick={() => setTarget(session)}
                >
                  {t('account.sessions.signOut')}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog
        open={!!target}
        onClose={() => setTarget(null)}
        title={t('account.sessions.confirmTitle')}
        body={
          target?.current
            ? t('account.sessions.confirmCurrentBody')
            : t('account.sessions.confirmBody')
        }
        action={t('account.sessions.signOut')}
        destructive
        pending={revoke.isPending}
        onConfirm={async () => {
          if (!target) return;
          await revoke.mutateAsync(target.id);
          if (target.current) {
            await leaveSession(queryClient, () => router.navigate({ to: '/login' }));
          }
        }}
      />
    </Card>
  );
}
