import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { TelegramLinkCode, TelegramLinkStatus } from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardTitle,
  PageHeader,
  Skeleton,
  toast,
} from '@vertex-digital/ui';
import { CircleCheckIcon, ExternalLinkIcon, ServerCogIcon, TriangleAlertIcon } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { CopyButton } from '../../components/copy-button';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import {
  telegramLinkPollQuery,
  telegramStatusQuery,
  useCreateLinkCode,
  useSendTelegramTest,
  useUnlinkTelegram,
} from './telegram.queries';

/** The server variables the bot needs (rule TG1, `docs/deployment.md`). */
const SERVER_VARIABLES = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_BOT_USERNAME',
  'TELEGRAM_WEBHOOK_SECRET',
  'TELEGRAM_WEBHOOK_URL',
];

/**
 * "تيليجرام" (S05, F07): the bot's state. Not configured: the server variables it needs. Not
 * linked: a single-use link with its QR code and countdown, then the page waits for the phone
 * (rule TG3). Linked: who, since when, the last message, a test and unlinking.
 */
export function TelegramPage() {
  const { t } = useTranslation();
  const status = useQuery(telegramStatusQuery);
  return (
    <>
      <PageHeader title={t('telegram.title')} description={t('telegram.subtitle')} />
      {status.isPending && <Skeleton className="h-64 w-full" aria-hidden="true" />}
      {status.isError && (
        <div className="flex flex-col items-start gap-3">
          <FormAlert>{errorMessage(t, status.error)}</FormAlert>
          <Button variant="outline" onClick={() => status.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {status.isSuccess &&
        (!status.data.configured ? (
          <NotConfigured />
        ) : status.data.link ? (
          <Linked status={status.data} link={status.data.link} />
        ) : (
          <NotLinked />
        ))}
    </>
  );
}

function NotConfigured() {
  const { t } = useTranslation();
  return (
    <Card className="max-w-2xl gap-4">
      <Callout
        tone="warning"
        icon={<ServerCogIcon />}
        title={t('telegram.notConfigured.title')}
        description={t('telegram.notConfigured.body')}
      />
      <ul className="flex flex-col gap-1 self-start text-sm" dir="ltr">
        {SERVER_VARIABLES.map((name) => (
          <li key={name}>
            <code>{name}</code>
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-1 text-sm text-muted-foreground">
        <p>{t('telegram.notConfigured.where')}</p>
        <code dir="ltr" className="self-start">
          {t('telegram.notConfigured.whereRef')}
        </code>
      </div>
    </Card>
  );
}

function NotLinked() {
  const { t } = useTranslation();
  const create = useCreateLinkCode();
  const [code, setCode] = useState<TelegramLinkCode | null>(null);
  return (
    <Card className="max-w-2xl gap-4">
      <div className="flex flex-col gap-1">
        <CardTitle>{t('telegram.notLinked.title')}</CardTitle>
        <p className="text-sm text-muted-foreground">{t('telegram.notLinked.body')}</p>
      </div>
      {create.isError && <FormAlert>{errorMessage(t, create.error)}</FormAlert>}
      {code ? (
        <LinkCode
          code={code}
          renewing={create.isPending}
          onRenew={() => create.mutate(undefined, { onSuccess: setCode })}
        />
      ) : (
        <Button
          className="self-start"
          disabled={create.isPending}
          onClick={() => create.mutate(undefined, { onSuccess: setCode })}
        >
          {t('telegram.notLinked.link')}
        </Button>
      )}
    </Card>
  );
}

/** The deep link, its QR code and the countdown; polls the status until the chat is linked. */
function LinkCode({
  code,
  renewing,
  onRenew,
}: {
  code: TelegramLinkCode;
  renewing: boolean;
  onRenew: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const remaining = useSecondsUntil(code.expiresAt);
  const expired = remaining <= 0;
  const poll = useQuery({ ...telegramLinkPollQuery, enabled: !expired });
  const linked = Boolean(poll.data?.link);
  useEffect(() => {
    if (!linked || !poll.data) return;
    queryClient.setQueryData(telegramStatusQuery.queryKey, poll.data);
    toast.add({ title: t('telegram.notLinked.linked'), type: 'success' });
  }, [linked, poll.data, queryClient, t]);

  if (expired) {
    return (
      <div className="flex flex-col items-start gap-3">
        <FormAlert>{t('telegram.notLinked.expired')}</FormAlert>
        <Button disabled={renewing} onClick={onRenew}>
          {t('telegram.notLinked.renew')}
        </Button>
      </div>
    );
  }
  const minutes = Math.floor(remaining / 60);
  const seconds = String(remaining % 60).padStart(2, '0');
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
      {/* Scanners need dark modules on a light ground, in both themes. */}
      <div className="shrink-0 self-start rounded-lg border border-border bg-white p-3">
        <QRCodeSVG
          value={code.deepLink}
          size={168}
          role="img"
          aria-label={t('telegram.notLinked.qrLabel')}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <p className="text-sm">{t('telegram.notLinked.steps')}</p>
        <div className="flex items-center gap-1">
          <a
            href={code.deepLink}
            target="_blank"
            rel="noreferrer"
            dir="ltr"
            className="min-w-0 truncate text-sm text-primary underline-offset-4 hover:underline"
          >
            {code.deepLink}
          </a>
          <CopyButton value={code.deepLink} label={t('telegram.notLinked.copy')} />
        </div>
        <Button
          variant="outline"
          className="self-start"
          render={<a href={code.deepLink} target="_blank" rel="noreferrer" />}
        >
          <ExternalLinkIcon />
          {t('telegram.notLinked.open')}
        </Button>
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {t('telegram.notLinked.countdown', { time: `${minutes}:${seconds}` })}
        </p>
        <p className="text-sm text-muted-foreground">{t('telegram.notLinked.waiting')}</p>
      </div>
    </div>
  );
}

/** Whole seconds from now until `iso`, ticking every second; 0 once past. */
function useSecondsUntil(iso: string): number {
  const [seconds, setSeconds] = useState(() => secondsUntil(iso));
  useEffect(() => {
    setSeconds(secondsUntil(iso));
    const timer = setInterval(() => setSeconds(secondsUntil(iso)), 1000);
    return () => clearInterval(timer);
  }, [iso]);
  return seconds;
}

const secondsUntil = (iso: string) =>
  Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 1000));

const MESSAGE_TONES = {
  sent: 'success',
  pending: 'info',
  skipped: 'neutral',
  failed: 'danger',
} as const;

function Linked({
  status,
  link,
}: {
  status: TelegramLinkStatus;
  link: NonNullable<TelegramLinkStatus['link']>;
}) {
  const { t } = useTranslation();
  const test = useSendTelegramTest();
  const unlink = useUnlinkTelegram();
  const [confirming, setConfirming] = useState(false);
  const last = status.lastMessage;
  return (
    <Card className="max-w-2xl gap-4">
      <div className="flex items-start gap-3">
        <CircleCheckIcon
          className="mt-0.5 size-5 shrink-0 text-status-success-foreground"
          aria-hidden="true"
        />
        <div className="flex min-w-0 flex-col gap-1">
          <CardTitle>{t('telegram.linked.title')}</CardTitle>
          <p className="text-sm text-muted-foreground">
            {link.username ? (
              <>
                {t('telegram.linked.account')} <span dir="ltr">@{link.username}</span>
              </>
            ) : (
              t('telegram.linked.noUsername')
            )}
          </p>
          <p className="text-sm text-muted-foreground">
            {t('telegram.linked.since', { time: formatDateTime(link.since) })}
          </p>
        </div>
      </div>
      <div className="flex flex-col gap-2 rounded-lg border border-border p-4">
        <p className="text-sm font-medium">{t('telegram.linked.lastMessage')}</p>
        {last ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={MESSAGE_TONES[last.status]}>
                {t(`telegram.messageStatus.${last.status}`)}
              </Badge>
              <span className="text-sm text-muted-foreground">
                {t(`telegram.messageKind.${last.kind}`)} ·{' '}
                {formatDateTime(last.sentAt ?? last.createdAt)}
              </span>
            </div>
            {last.error && (
              <p className="flex items-start gap-2 text-sm text-destructive-text">
                <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span dir="ltr" className="break-all">
                  {last.error}
                </span>
              </p>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t('telegram.linked.noMessage')}</p>
        )}
      </div>
      {test.isError && <FormAlert>{errorMessage(t, test.error)}</FormAlert>}
      <div className="flex flex-wrap gap-3">
        <Button
          disabled={test.isPending}
          onClick={() =>
            test.mutate(undefined, {
              onSuccess: () =>
                toast.add({ title: t('telegram.linked.testQueued'), type: 'success' }),
            })
          }
        >
          {t('telegram.linked.test')}
        </Button>
        <Button variant="outline" onClick={() => setConfirming(true)}>
          {t('telegram.linked.unlink')}
        </Button>
      </div>
      {confirming && (
        <ConfirmDialog
          open
          onClose={() => setConfirming(false)}
          title={t('telegram.unlink.title')}
          body={t('telegram.unlink.body')}
          action={t('telegram.unlink.action')}
          destructive
          pending={unlink.isPending}
          onConfirm={async () => {
            await unlink.mutateAsync();
          }}
        />
      )}
    </Card>
  );
}
