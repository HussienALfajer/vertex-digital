import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  type AdminTicket,
  formatUsd,
  type TicketMessage,
  ticketMessageSchema,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardTitle,
  cn,
  Dialog,
  DialogContent,
  DialogTitle,
  EmptyState,
  Field,
  FieldError,
  FieldLabel,
  PageHeader,
  Skeleton,
  Textarea,
  useFocusInvalid,
} from '@vertex-digital/ui';
import {
  ArchiveIcon,
  ArrowRightIcon,
  CircleAlertIcon,
  LockIcon,
  RotateCcwIcon,
  SearchXIcon,
  SendIcon,
} from 'lucide-react';
import { type FormEvent, type KeyboardEvent, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { FormAlert } from '../../components/form-alert';
import { useVisibleAgain } from '../../lib/admin-stream';
import { ApiError } from '../../lib/api/client';
import { errorMessage } from '../../lib/errors';
import { formatDateTime, ltr } from '../../lib/format';
import { useIdempotentRequest } from '../../lib/idempotency';
import { actorLabel } from '../audit/audit-labels';
import { CustomerMarks } from '../customers/customer-marks';
import { STATUS_TONES as DEPOSIT_TONES } from '../deposits/deposit-labels';
import { TierChip } from '../merchants/tier-chip';
import { STATUS_TONES as ORDER_TONES } from '../orders/order-labels';
import { ImagePicker } from './image-picker';
import {
  attachmentUrl,
  THREAD_REFRESH_MS,
  ticketHistoryQuery,
  ticketQuery,
  useCloseTicket,
  useReplyTicket,
} from './support.queries';
import { TICKET_STATUS_TONES } from './ticket-labels';

/**
 * One ticket (S12 TK3–TK12): the thread oldest first (the customer at the start side, the store
 * at the end side), images opening full size, the reply box (Ctrl+Enter sends; a reply reopens a
 * closed ticket), "إغلاق", and the side panel: the customer, the linked order or deposit, the
 * ticket's history. Customer text is plain: URLs are never made clickable (phishing). The admin
 * stream carries no tickets, so the thread is read again in the background every minute and when
 * the tab is seen again (audit A07-10); a typed reply stays.
 */
export function TicketPage({ id }: { id: string }) {
  const { t } = useTranslation();
  const ticket = useQuery({ ...ticketQuery(id), refetchInterval: THREAD_REFRESH_MS });
  useVisibleAgain(() => void ticket.refetch());
  const close = useCloseTicket(id);
  const [closing, setClosing] = useState(false);

  const back = (
    <Button variant="ghost" render={<Link to="/support" />}>
      <ArrowRightIcon className="ltr:-scale-x-100" />
      {t('support.thread.back')}
    </Button>
  );

  if (ticket.isPending) {
    return (
      <>
        <PageHeader title={<Skeleton className="h-8 w-40" />} actions={back} />
        <div className="grid gap-6 lg:grid-cols-3" aria-hidden="true">
          <Skeleton className="h-96 w-full lg:col-span-2" />
          <Skeleton className="h-96 w-full" />
        </div>
      </>
    );
  }
  if (!ticket.data) {
    // Audit A07-47: a ticket that does not exist offers the way back, not a retry.
    const missing = ticket.error instanceof ApiError && ticket.error.status === 404;
    return (
      <>
        <PageHeader title={t('support.title')} actions={back} />
        <EmptyState
          icon={missing ? <SearchXIcon /> : <CircleAlertIcon />}
          title={missing ? t('support.thread.notFound') : errorMessage(t, ticket.error)}
          action={
            missing ? (
              <Button variant="outline" render={<Link to="/support" />}>
                {t('support.thread.back')}
              </Button>
            ) : (
              <Button variant="outline" onClick={() => ticket.refetch()}>
                {t('common.retry')}
              </Button>
            )
          }
        />
      </>
    );
  }

  const data = ticket.data;
  // Q28 (audit A07-20): the API refuses a reply on an archived customer's ticket.
  const archived = data.customer.status === 'archived';
  return (
    <>
      <PageHeader
        title={<bdi dir="ltr">{data.number}</bdi>}
        description={<span className="break-words">{data.subject}</span>}
        actions={
          <>
            {data.status !== 'closed' && (
              <Button variant="outline" onClick={() => setClosing(true)}>
                <LockIcon />
                {t('support.thread.close')}
              </Button>
            )}
            {back}
          </>
        }
      />
      {/* A failed background read keeps the thread and the typed reply (audit A07-10). */}
      {ticket.isError && (
        <Callout
          tone="warning"
          icon={<CircleAlertIcon />}
          title={t('support.thread.stale')}
          action={
            <Button variant="outline" onClick={() => ticket.refetch()}>
              {t('common.retry')}
            </Button>
          }
        />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={TICKET_STATUS_TONES[data.status]}>
          {t(`support.statuses.${data.status}`)}
        </Badge>
        <Badge tone="neutral">{t(`support.categories.${data.category}`)}</Badge>
        {data.openedBy === 'admin' && <Badge tone="neutral">{t('support.openedByAdmin')}</Badge>}
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
          <Thread ticket={data} />
          {data.closedAt && data.closedBy && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <LockIcon className="size-4" aria-hidden="true" />
              {t(`support.thread.closedBy.${data.closedBy}`, {
                date: formatDateTime(data.closedAt),
              })}
            </p>
          )}
          {archived ? (
            <Callout
              tone="neutral"
              icon={<ArchiveIcon />}
              title={t('support.reply.archivedTitle')}
              description={t('support.reply.archivedBody')}
            />
          ) : (
            <ReplyBox ticket={data} />
          )}
        </div>
        <SidePanel ticket={data} />
      </div>
      <ConfirmDialog
        open={closing}
        onClose={() => setClosing(false)}
        title={t('support.thread.closeTitle')}
        body={t('support.thread.closeBody', { number: ltr(data.number) })}
        action={t('support.thread.closeConfirm')}
        pending={close.isPending}
        onConfirm={async () => {
          await close.mutateAsync(undefined);
        }}
      />
    </>
  );
}

function Thread({ ticket }: { ticket: AdminTicket }) {
  return (
    <ol className="flex flex-col gap-4">
      {ticket.messages.map((message) => (
        <MessageBubble key={message.id} ticket={ticket} message={message} />
      ))}
    </ol>
  );
}

function MessageBubble({ ticket, message }: { ticket: AdminTicket; message: TicketMessage }) {
  const { t } = useTranslation();
  const [shown, setShown] = useState<string | null>(null);
  const fromAdmin = message.author === 'admin';
  return (
    <li className={cn('flex', fromAdmin ? 'justify-end' : 'justify-start')}>
      <article
        className={cn(
          'flex max-w-[85%] min-w-0 flex-col gap-2 rounded-lg px-4 py-3',
          // Authorship, not a status (audit A07-50): the team on the secondary surface.
          fromAdmin
            ? 'border border-border bg-secondary text-secondary-foreground'
            : 'border border-border bg-surface text-surface-foreground',
        )}
      >
        <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm">
          <span className="font-medium">
            {fromAdmin ? t('support.thread.admin') : ticket.customer.name}
          </span>
          <time dateTime={message.createdAt} className="opacity-80">
            {formatDateTime(message.createdAt)}
          </time>
        </header>
        {/* Plain text: React escapes it, and links stay text (TK7). */}
        <p className="whitespace-pre-wrap break-words">{message.body}</p>
        {message.attachments.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {message.attachments.map((fileId, index) => (
              <li key={fileId}>
                <button
                  type="button"
                  className="block size-24 overflow-hidden rounded-md border border-border bg-muted"
                  aria-label={t('support.thread.openImage', { n: index + 1 })}
                  onClick={() => setShown(fileId)}
                >
                  <img
                    src={attachmentUrl(ticket.id, fileId)}
                    alt={t('support.thread.imageAlt', { n: index + 1 })}
                    className="size-full object-cover"
                    loading="lazy"
                  />
                </button>
              </li>
            ))}
          </ul>
        )}
      </article>
      <Dialog open={shown !== null} onOpenChange={(open) => !open && setShown(null)}>
        {shown && (
          <DialogContent closeLabel={t('common.close')} className="max-w-[min(64rem,95vw)]">
            <DialogTitle>{t('support.thread.imageTitle', { number: ticket.number })}</DialogTitle>
            <img
              src={attachmentUrl(ticket.id, shown)}
              alt={t('support.thread.imageAlt', {
                n: message.attachments.indexOf(shown) + 1,
              })}
              className="max-h-[75vh] w-full object-contain"
            />
          </DialogContent>
        )}
      </Dialog>
    </li>
  );
}

/**
 * Rules TK5, TK7: a reply with up to 3 images; with images only the body becomes "صورة مرفقة".
 * The `Idempotency-Key` is kept while the same reply is retried, new once it changed or was sent
 * (the same words sent again later are a new message). The text and images stay on an error.
 */
function ReplyBox({ ticket }: { ticket: AdminTicket }) {
  const { t } = useTranslation();
  const send = useIdempotentRequest();
  const sent = useRef(0);
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const reply = useReplyTicket(ticket.id, () => {
    sent.current += 1;
    setBody('');
    setFiles([]);
  });
  const [invalid, setInvalid] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { ref, focusInvalid } = useFocusInvalid();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (reply.isPending) return;
    setFailure(null);
    const text = body.trim() === '' && files.length > 0 ? t('support.reply.imageOnly') : body;
    const parsed = ticketMessageSchema.safeParse({ body: text });
    setInvalid(!parsed.success);
    if (!parsed.success) return focusInvalid();
    const signature = {
      sent: sent.current,
      body: parsed.data.body,
      files: files.map((file) => [file.name, file.size, file.lastModified]),
    };
    try {
      await send(signature, (key) => reply.mutateAsync({ body: parsed.data, files, key }));
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      ref.current?.requestSubmit();
    }
  }

  return (
    <Card className="gap-4">
      {ticket.status === 'closed' && (
        <Callout tone="info" icon={<RotateCcwIcon />} title={t('support.reply.reopens')} />
      )}
      <form ref={ref} className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <Field invalid={invalid}>
          <FieldLabel>{t('support.reply.label')}</FieldLabel>
          <Textarea
            name="body"
            rows={4}
            maxLength={2000}
            placeholder={t('support.reply.placeholder')}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={keyDown}
          />
          <FieldError match={invalid}>{t('support.reply.bodyError')}</FieldError>
        </Field>
        <ImagePicker files={files} onChange={setFiles} disabled={reply.isPending} />
        {failure && <FormAlert>{failure}</FormAlert>}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm text-muted-foreground">{t('support.reply.shortcut')}</span>
          <Button type="submit" disabled={reply.isPending}>
            <SendIcon className="rtl:-scale-x-100" />
            {reply.isPending ? t('support.reply.sending') : t('support.reply.send')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function SidePanel({ ticket }: { ticket: AdminTicket }) {
  const { t } = useTranslation();
  const history = useQuery(ticketHistoryQuery(ticket.id));
  const { customer, orderSummary: order, depositSummary: deposit } = ticket;
  return (
    <aside className="flex flex-col gap-4">
      <Card className="gap-3">
        <CardTitle className="text-lg">{t('support.side.customer')}</CardTitle>
        <div className="flex flex-col gap-1">
          <Link
            to="/customers/$id"
            params={{ id: customer.id }}
            className="rounded-sm font-medium underline-offset-4 hover:underline"
          >
            {customer.name}
          </Link>
          {customer.tier && <TierChip tier={customer.tier} />}
          <span dir="ltr" className="text-end text-sm break-all text-muted-foreground">
            {customer.email}
          </span>
          <span dir="ltr" className="text-end text-sm text-muted-foreground">
            {customer.phone}
          </span>
        </div>
        <CustomerMarks customerId={customer.id} marks={customer.marks} isTest={customer.isTest} />
        {customer.isTest && (
          <Badge tone="info" className="self-start">
            {t('customers.chips.test')}
          </Badge>
        )}
      </Card>
      {order && (
        <Card className="gap-3">
          <CardTitle className="text-lg">{t('support.side.order')}</CardTitle>
          {ticket.orderProblem && (
            <div className="flex flex-col gap-1">
              <span className="text-sm text-muted-foreground">{t('support.side.problem')}</span>
              <Badge tone="warning">{t(`support.problems.${ticket.orderProblem}`)}</Badge>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Link
              to="/orders/$id"
              params={{ id: order.id }}
              className="rounded-sm font-medium underline-offset-4 hover:underline"
            >
              <bdi dir="ltr">{order.number}</bdi>
            </Link>
            <Badge tone={ORDER_TONES[order.status]}>{t(`orders.statuses.${order.status}`)}</Badge>
          </div>
          <p className="text-sm">
            <bdi>{order.productNameAr}</bdi> × {order.quantity} ·{' '}
            <bdi dir="ltr" className="tabular-nums">
              {formatUsd(order.totalUsdUnits)}
            </bdi>
          </p>
          <span className="text-sm text-muted-foreground">{formatDateTime(order.createdAt)}</span>
        </Card>
      )}
      {deposit && (
        <Card className="gap-3">
          <CardTitle className="text-lg">{t('support.side.deposit')}</CardTitle>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Link
              to="/deposits/$id"
              params={{ id: deposit.id }}
              className="rounded-sm font-medium underline-offset-4 hover:underline"
            >
              <bdi dir="ltr">{deposit.referenceCode}</bdi>
            </Link>
            <Badge tone={DEPOSIT_TONES[deposit.status]}>
              {t(`deposits.statuses.${deposit.status}`)}
            </Badge>
          </div>
          <p className="text-sm">
            {t(`wallets.methods.${deposit.method}`)} ·{' '}
            <bdi dir="ltr" className="tabular-nums">
              {formatUsd(deposit.declaredUsdUnits)}
            </bdi>
          </p>
          <span className="text-sm text-muted-foreground">{formatDateTime(deposit.createdAt)}</span>
        </Card>
      )}
      <Card className="gap-3">
        <CardTitle className="text-lg">{t('support.side.history')}</CardTitle>
        {history.isPending && <Skeleton className="h-24 w-full" aria-hidden="true" />}
        {history.isError && (
          <div className="flex flex-col items-start gap-2">
            <FormAlert>{errorMessage(t, history.error)}</FormAlert>
            <Button variant="outline" size="sm" className="h-11" onClick={() => history.refetch()}>
              {t('common.retry')}
            </Button>
          </div>
        )}
        {history.data?.items.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('support.side.noHistory')}</p>
        )}
        {history.data && history.data.items.length > 0 && (
          <ol className="flex flex-col divide-y divide-border text-sm">
            {history.data.items.map((entry) => (
              <li key={entry.id} className="flex flex-col gap-0.5 py-2">
                <span className="font-medium">{t(`audit.actions.${entry.action}`)}</span>
                <span className="text-muted-foreground">
                  {actorLabel(t, entry)} · {formatDateTime(entry.occurredAt)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </aside>
  );
}
