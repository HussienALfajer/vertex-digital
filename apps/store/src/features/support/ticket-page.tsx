'use client';

import { customerCanReply, type Ticket, type TicketMessage } from '@vertex-digital/contracts';
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@vertex-digital/ui/components/alert-dialog';
import { Badge } from '@vertex-digital/ui/components/badge';
import { Button } from '@vertex-digital/ui/components/button';
import { Card } from '@vertex-digital/ui/components/card';
import { Dialog, DialogContent, DialogTitle } from '@vertex-digital/ui/components/dialog';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { Field, FieldError, FieldLabel } from '@vertex-digital/ui/components/field';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { Textarea } from '@vertex-digital/ui/components/textarea';
import {
  ArrowRightIcon,
  CircleAlertIcon,
  LoaderCircleIcon,
  LockIcon,
  MessageSquarePlusIcon,
  SendIcon,
} from 'lucide-react';
import Link from 'next/link';
import { notFound, useParams, useRouter } from 'next/navigation';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { CopyButton } from '@/features/deposits/copy-button';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { t } from '@/lib/i18n';
import { attemptSignature, BODY_MAX, bodyLength, bodyValid, messageBody } from './form';
import { ImagePicker } from './image-picker';
import { categoryText, newTicketHref, STATUS_TONES, statusText } from './labels';
import { OnTicketReplied } from './on-ticket-replied';
import { attachmentUrl, closeTicket, getTicket, replyToTicket } from './requests';

type State =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'missing' }
  | { status: 'ready'; ticket: Ticket };

/**
 * One ticket (S12 screens, TK3–TK7, TK11): the header with its number, subject, type, link and
 * status; the thread oldest first, the customer's messages at the start side and the team's at the
 * end side under the store's name, plain text only; the images opening full size; the reply box
 * with images; "إغلاق التذكرة" with a confirmation. Closed, a reply within 7 days reopens it;
 * later the page offers a new ticket of the same type and link. Read in the browser with the
 * session, never cached; another customer's ticket is the 404 page. A reply arrives live.
 */
export function TicketPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<State>({ status: 'loading' });

  const load = useCallback(async () => {
    const result = await getTicket(id);
    if (!result.ok && result.reason === 'UNAUTHORIZED') {
      router.replace(`/sign-in?next=${encodeURIComponent(`/support/${id}`)}`);
      return;
    }
    if (!result.ok) {
      return setState({ status: result.reason === 'NOT_FOUND' ? 'missing' : 'failed' });
    }
    setState({ status: 'ready', ticket: result.data });
  }, [id, router]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.status === 'missing') notFound();
  if (state.status === 'loading') return <TicketSkeleton />;
  if (state.status === 'failed') {
    return (
      <EmptyState
        icon={<CircleAlertIcon />}
        title={t('support.ticket.loadFailed')}
        action={
          <Button
            variant="outline"
            size="xl"
            onClick={() => {
              setState({ status: 'loading' });
              void load();
            }}
          >
            {t('support.retry')}
          </Button>
        }
      />
    );
  }

  const { ticket } = state;
  const update = (next: Ticket) => setState({ status: 'ready', ticket: next });
  // TK4: the API's answer, and the clock for a page left open past the 7 days.
  const canReply =
    ticket.canReply &&
    customerCanReply(
      { status: ticket.status, closedAt: ticket.closedAt ? new Date(ticket.closedAt) : null },
      new Date(),
    );
  return (
    <div className="flex flex-col gap-6">
      <OnTicketReplied ticketId={ticket.id} onReply={() => void load()} />
      <Button
        variant="link"
        size="xl"
        className="self-start px-0"
        render={<Link href="/support" />}
      >
        <ArrowRightIcon className="ltr:rotate-180" aria-hidden="true" />
        {t('support.ticket.back')}
      </Button>
      <TicketHeader ticket={ticket} onChange={update} />
      <section className="flex flex-col gap-3" aria-label={t('support.ticket.conversation')}>
        <ol className="flex flex-col gap-4">
          {ticket.messages.map((message) => (
            <MessageBubble key={message.id} ticketId={ticket.id} message={message} />
          ))}
        </ol>
        {ticket.status === 'closed' && ticket.closedAt && (
          <p className="flex items-center justify-center gap-2 text-center text-sm text-muted-foreground">
            <LockIcon className="size-4 shrink-0" aria-hidden="true" />
            {ticket.closedBy === 'system'
              ? t('support.ticket.autoClosed')
              : t('support.ticket.closedAt', { time: formatDateTime(ticket.closedAt) })}
          </p>
        )}
      </section>
      {canReply ? (
        <ReplyBox key={ticket.id} ticket={ticket} onSent={update} onStale={() => void load()} />
      ) : (
        <EmptyState
          icon={<LockIcon />}
          title={t('support.ticket.closedTitle')}
          description={t('support.ticket.closedBody')}
          action={
            <Button size="xl" render={<Link href={newTicketHref(ticket)} />}>
              <MessageSquarePlusIcon aria-hidden="true" />
              {t('support.ticket.newTicket')}
            </Button>
          }
        />
      )}
    </div>
  );
}

function TicketHeader({ ticket, onChange }: { ticket: Ticket; onChange: (next: Ticket) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  const close = async () => {
    setBusy(true);
    setFailure(null);
    const result = await closeTicket(ticket.id);
    setBusy(false);
    if (!result.ok) return setFailure(result.reason);
    setConfirming(false);
    onChange(result.data);
  };

  return (
    <Card className="gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <p className="text-sm text-muted-foreground">
            <bdi dir="ltr" className="font-medium text-foreground">
              {ticket.number}
            </bdi>
          </p>
          <CopyButton value={ticket.number} label={t('support.ticket.copyNumber')} />
        </div>
        <Badge tone={STATUS_TONES[ticket.status]}>{statusText(ticket.status)}</Badge>
      </div>
      <h2 className="text-xl font-bold break-words">
        <bdi>{ticket.subject}</bdi>
      </h2>
      <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
        <span>{categoryText(ticket.category)}</span>
        {ticket.order && (
          <>
            <span aria-hidden="true">·</span>
            <Link
              href={`/orders/${ticket.order.id}`}
              className="text-primary underline-offset-4 hover:underline"
            >
              <bdi dir="ltr">{ticket.order.number}</bdi>
            </Link>
          </>
        )}
        {ticket.deposit && (
          <>
            <span aria-hidden="true">·</span>
            <Link
              href={`/wallet/deposits/${ticket.deposit.id}`}
              className="text-primary underline-offset-4 hover:underline"
            >
              <bdi dir="ltr">{ticket.deposit.referenceCode}</bdi>
            </Link>
          </>
        )}
      </p>
      {ticket.status !== 'closed' && (
        <Button
          variant="outline"
          size="xl"
          className="self-start"
          onClick={() => setConfirming(true)}
        >
          <LockIcon aria-hidden="true" />
          {t('support.ticket.close')}
        </Button>
      )}
      {failure && <FormAlert>{errorText(failure)}</FormAlert>}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('support.ticket.closeTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('support.ticket.closeBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="xl" />}>
              {t('support.ticket.keep')}
            </AlertDialogClose>
            <Button size="xl" disabled={busy} onClick={() => void close()}>
              {t('support.ticket.closeConfirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

/**
 * One message: the customer's at the start side, the team's at the end side with the store's name
 * (TK7: an admin message looks unlike anything a customer can write). Plain text, never links.
 */
function MessageBubble({ ticketId, message }: { ticketId: string; message: TicketMessage }) {
  const team = message.author === 'admin';
  return (
    <li className={`flex max-w-[85%] flex-col gap-1 ${team ? 'self-end' : 'self-start'}`}>
      <p className={`text-xs font-medium ${team ? 'text-accent-text' : 'text-muted-foreground'}`}>
        {team ? t('support.ticket.team') : t('support.ticket.you')}
      </p>
      <div
        className={`flex flex-col gap-2 rounded-lg border px-4 py-3 ${
          team
            ? 'border-primary bg-status-brand text-status-brand-foreground'
            : 'border-border bg-surface'
        }`}
      >
        <p className="text-base whitespace-pre-wrap break-words">{message.body}</p>
        {message.attachments.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {message.attachments.map((fileId, index) => (
              <li key={fileId}>
                <Attachment src={attachmentUrl(ticketId, fileId)} n={index + 1} />
              </li>
            ))}
          </ul>
        )}
      </div>
      <time dateTime={message.createdAt} className="text-xs text-muted-foreground">
        {formatDateTime(message.createdAt)}
      </time>
    </li>
  );
}

/** A thumbnail that opens the image full size (TK11: served to the ticket's customer only). */
function Attachment({ src, n }: { src: string; n: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="block size-20 overflow-hidden rounded-md border border-border bg-muted focus-visible:outline-2 focus-visible:outline-ring"
        aria-label={t('support.ticket.imageOpen', { n })}
        onClick={() => setOpen(true)}
      >
        {/* biome-ignore lint/performance/noImgElement: a private image served per request, never optimized. */}
        <img src={src} alt="" className="size-full object-cover" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent closeLabel={t('support.ticket.imageClose')} className="max-w-3xl">
          <DialogTitle>{t('support.ticket.image', { n })}</DialogTitle>
          {/* biome-ignore lint/performance/noImgElement: a private image served per request, never optimized. */}
          <img
            src={src}
            alt={t('support.ticket.image', { n })}
            className="max-h-[75dvh] w-full rounded-md object-contain"
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

/** A refusal of a reply, with its next step. */
type Refusal = { reason: Failure; ticketId?: string };

/**
 * The reply box (TK7): text and up to 3 images, one `Idempotency-Key` per attempt. On a closed
 * ticket within 7 days it says that the reply reopens it (TK4).
 */
function ReplyBox({
  ticket,
  onSent,
  onStale,
}: {
  ticket: Ticket;
  onSent: (ticket: Ticket) => void;
  onStale: () => void;
}) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [showError, setShowError] = useState(false);
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const invalid = showError && !bodyValid(text, files.length);

  async function send(event: FormEvent) {
    event.preventDefault();
    setShowError(true);
    setRefusal(null);
    if (!bodyValid(text, files.length)) return;
    const body = messageBody(text, files.length, t('support.images.attached'));
    const signature = attemptSignature({ ticket: ticket.id, body }, files);
    if (attempt.current?.signature !== signature) {
      attempt.current = { signature, key: crypto.randomUUID() };
    }
    setSending(true);
    const result = await replyToTicket(ticket.id, body, files, attempt.current.key);
    setSending(false);
    if (result.ok) {
      attempt.current = null;
      setText('');
      setFiles([]);
      setShowError(false);
      onSent(result.data);
      return;
    }
    const ticketId = (result.details as { ticketId?: unknown } | undefined)?.ticketId;
    setRefusal({ reason: result.reason, ...(typeof ticketId === 'string' && { ticketId }) });
    // Past the 7 days, or closed meanwhile: the page shows what the ticket is now.
    if (result.reason === 'TICKET_CLOSED' || result.reason === 'NOT_FOUND') onStale();
  }

  const link =
    refusal?.reason === 'TICKETS_LIMIT_REACHED'
      ? { href: '/support', text: t('support.new.openTickets') }
      : refusal?.reason === 'TICKET_ALREADY_OPEN' && refusal.ticketId
        ? { href: `/support/${refusal.ticketId}`, text: t('support.new.openExisting') }
        : null;

  return (
    <form noValidate onSubmit={(event) => void send(event)}>
      <Card className="gap-4">
        {ticket.status === 'closed' && (
          <p className="flex items-center gap-2 rounded-md bg-status-info px-4 py-3 text-sm text-status-info-foreground">
            <CircleAlertIcon className="size-4 shrink-0" aria-hidden="true" />
            {t('support.ticket.reopenNote')}
          </p>
        )}
        <Field invalid={invalid}>
          <FieldLabel>{t('support.ticket.reply')}</FieldLabel>
          <Textarea
            value={text}
            maxLength={BODY_MAX}
            className="text-md"
            aria-invalid={invalid}
            disabled={sending}
            onChange={(event) => setText(event.target.value)}
          />
          <p className="text-sm text-muted-foreground">
            <span className="tabular-nums" dir="ltr">
              {t('support.new.counter', { count: bodyLength(text), max: BODY_MAX })}
            </span>
          </p>
          <FieldError match={invalid}>{t('support.validation.body')}</FieldError>
        </Field>
        <ImagePicker files={files} onChange={setFiles} disabled={sending} />
        {refusal && (
          <div
            role="alert"
            className="flex flex-col gap-2 rounded-md bg-status-danger px-4 py-3 text-sm text-status-danger-foreground"
          >
            <p>{errorText(refusal.reason)}</p>
            {link && (
              <Link href={link.href} className="w-fit font-medium underline underline-offset-4">
                {link.text}
              </Link>
            )}
          </div>
        )}
        <Button type="submit" size="xl" disabled={sending}>
          {sending ? (
            <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
          ) : (
            <SendIcon aria-hidden="true" />
          )}
          {sending ? t('support.ticket.sending') : t('support.ticket.send')}
        </Button>
      </Card>
    </form>
  );
}

export function TicketSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden="true">
      <Skeleton className="h-36 w-full" />
      <Skeleton className="h-20 w-3/4 self-start" />
      <Skeleton className="h-20 w-3/4 self-end" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
