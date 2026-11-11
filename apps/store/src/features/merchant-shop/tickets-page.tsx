'use client';

import {
  type MerchantShopTicket,
  type MerchantShopTicketSummary,
  shopTicketEscalationSchema,
} from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui/components/badge';
import { Button } from '@vertex-digital/ui/components/button';
import { Card } from '@vertex-digital/ui/components/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@vertex-digital/ui/components/dialog';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { Field, FieldError, FieldLabel } from '@vertex-digital/ui/components/field';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { Textarea } from '@vertex-digital/ui/components/textarea';
import { useFocusInvalid } from '@vertex-digital/ui/focus-invalid';
import {
  ArrowRightIcon,
  CircleAlertIcon,
  LoaderCircleIcon,
  LockIcon,
  MessagesSquareIcon,
  SendIcon,
  ShieldAlertIcon,
} from 'lucide-react';
import Link from 'next/link';
import { notFound, useParams, useRouter } from 'next/navigation';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import {
  MerchantPageStatus,
  MerchantSkeleton,
  useMerchantRead,
} from '@/features/merchant-tools/merchant-state';
import { sendAttempt } from '@/features/purchase/attempt';
import {
  attemptSignature,
  BODY_MAX,
  bodyValid,
  freesSupportKey,
  messageBody,
} from '@/features/support/form';
import { ImagePicker } from '@/features/support/image-picker';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { tsa } from './i18n';
import {
  escalateShopTicket,
  getShopTicket,
  listShopTickets,
  replyToShopTicket,
  shopTicketAttachmentUrl,
} from './requests';

/**
 * "تذاكر المتجر" (S26 TK1–TK4): the shop customers' tickets, unanswered first as the API sorts
 * them, each opening its thread.
 */
export function ShopTicketsPage() {
  const read = useCallback(() => listShopTickets(null), []);
  const { state, setState, reload } = useMerchantRead(read);
  const [loadingMore, setLoadingMore] = useState(false);
  if (state.status !== 'ready') {
    return <MerchantPageStatus state={state} onRetry={reload} skeleton={<MerchantSkeleton />} />;
  }
  const { items, nextCursor } = state.data;

  async function more() {
    if (!nextCursor) return;
    setLoadingMore(true);
    const result = await listShopTickets(nextCursor);
    setLoadingMore(false);
    if (!result.ok) return;
    setState({
      status: 'ready',
      data: { items: [...items, ...result.data.items], nextCursor: result.data.nextCursor },
    });
  }

  if (items.length === 0) {
    return <EmptyState icon={<MessagesSquareIcon />} title={tsa('tickets.empty')} />;
  }
  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-3" data-testid="shop-tickets">
        {items.map((ticket) => (
          <TicketRow key={ticket.id} ticket={ticket} />
        ))}
      </ul>
      {nextCursor && (
        <Button
          variant="outline"
          size="xl"
          className="self-center"
          disabled={loadingMore}
          onClick={() => void more()}
        >
          {loadingMore && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
          {tsa('common.loadMore')}
        </Button>
      )}
    </div>
  );
}

const STATUS_TONES = { open: 'warning', answered: 'success', closed: 'neutral' } as const;

function TicketRow({ ticket }: { ticket: MerchantShopTicketSummary }) {
  return (
    <li>
      <Link
        href={`/merchant/shop/tickets/${ticket.id}`}
        prefetch={false}
        className="block rounded-lg focus-visible:outline-2 focus-visible:outline-ring"
      >
        <Card className="gap-2 transition-colors hover:border-primary">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="flex flex-wrap items-center gap-2">
              <bdi dir="ltr" className="font-bold">
                {ticket.number}
              </bdi>
              {ticket.unanswered && <Badge tone="warning">{tsa('tickets.unanswered')}</Badge>}
              {ticket.escalatedAt && <Badge tone="info">{tsa('tickets.escalated')}</Badge>}
            </span>
            <Badge tone={STATUS_TONES[ticket.status]}>
              {tsa(`tickets.statuses.${ticket.status}`)}
            </Badge>
          </div>
          <bdi className="font-medium break-words">{ticket.subject}</bdi>
          <span className="text-sm text-muted-foreground">
            <bdi>{ticket.customer.name}</bdi> · {tsa(`tickets.lastReplier.${ticket.lastReplier}`)} ·{' '}
            {formatDateTime(ticket.lastMessageAt)}
          </span>
        </Card>
      </Link>
    </li>
  );
}

type ThreadState =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'missing' }
  | { status: 'ready'; ticket: MerchantShopTicket };

/**
 * One shop ticket (TK2–TK4): the customer's name, email and phone, the thread with who wrote each
 * message («أنت», the customer, «فريق الدعم»), the reply with images, and "أرسل إلى الإدارة".
 */
export function ShopTicketPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<ThreadState>({ status: 'loading' });
  const latest = useRef(0);

  const load = useCallback(async () => {
    const reading = ++latest.current;
    const result = await getShopTicket(id);
    if (reading !== latest.current) return;
    if (!result.ok && result.reason === 'UNAUTHORIZED') {
      router.replace(`/sign-in?next=${encodeURIComponent(`/merchant/shop/tickets/${id}`)}`);
      return;
    }
    if (!result.ok) {
      return setState(
        result.reason === 'NOT_FOUND'
          ? { status: 'missing' }
          : (current) => (current.status === 'ready' ? current : { status: 'failed' }),
      );
    }
    setState({ status: 'ready', ticket: result.data });
  }, [id, router]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.status === 'missing') notFound();
  if (state.status === 'loading') {
    return (
      <div className="flex flex-col gap-4" aria-hidden="true">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-20 w-3/4" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (state.status === 'failed') {
    return (
      <EmptyState
        icon={<CircleAlertIcon />}
        title={tsa('common.loadFailed')}
        action={
          <Button variant="outline" size="xl" onClick={() => void load()}>
            {tsa('common.retry')}
          </Button>
        }
      />
    );
  }
  const { ticket } = state;
  const update = (next: MerchantShopTicket) => {
    latest.current++;
    setState({ status: 'ready', ticket: next });
  };
  return (
    <div className="flex flex-col gap-6">
      <Button
        variant="link"
        size="xl"
        className="self-start px-0"
        render={<Link href="/merchant/shop/tickets" prefetch={false} />}
      >
        <ArrowRightIcon className="ltr:rotate-180" aria-hidden="true" />
        {tsa('tickets.back')}
      </Button>
      <Card className="gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-col gap-1">
            <bdi dir="ltr" className="text-start font-bold">
              {ticket.number}
            </bdi>
            <bdi className="text-lg font-bold break-words">{ticket.subject}</bdi>
          </div>
          <Badge tone={STATUS_TONES[ticket.status]}>
            {tsa(`tickets.statuses.${ticket.status}`)}
          </Badge>
        </div>
        <div className="flex flex-col gap-0.5 text-sm" data-testid="ticket-customer">
          <span className="text-muted-foreground">{tsa('tickets.customer')}</span>
          <bdi className="font-medium">{ticket.customer.name}</bdi>
          <span dir="ltr" className="text-end break-all text-muted-foreground">
            {ticket.customer.email} · {ticket.customer.phone}
          </span>
        </div>
        {ticket.order && (
          <Link
            href={`/merchant/shop/orders?customer=${encodeURIComponent(ticket.customer.id)}`}
            prefetch={false}
            className="w-fit text-sm font-medium underline underline-offset-4"
          >
            {tsa('tickets.order', { number: ticket.order.number })}
          </Link>
        )}
        {ticket.escalatedAt ? (
          <p className="flex items-center gap-2 text-sm text-status-info-foreground">
            <ShieldAlertIcon className="size-4" aria-hidden="true" />
            {tsa('tickets.escalatedAt', { date: formatDateTime(ticket.escalatedAt) })}
          </p>
        ) : (
          ticket.status !== 'closed' && <EscalateButton ticket={ticket} onDone={update} />
        )}
      </Card>
      <ol className="flex flex-col gap-4" data-testid="ticket-thread">
        {ticket.messages.map((message) => {
          const mine = message.from === 'shop';
          return (
            <li
              key={message.id}
              className={`flex max-w-[85%] flex-col gap-1 ${mine ? 'self-end' : 'self-start'}`}
            >
              <p className="text-xs font-medium text-muted-foreground">
                {tsa(`tickets.from.${message.from}`, { name: ticket.customer.name })}
              </p>
              <div
                className={`flex flex-col gap-2 rounded-lg border px-4 py-3 ${
                  mine
                    ? 'border-primary bg-status-brand text-status-brand-foreground'
                    : message.from === 'support'
                      ? 'border-border bg-status-info text-status-info-foreground'
                      : 'border-border bg-surface'
                }`}
              >
                <p className="text-base whitespace-pre-wrap break-words">{message.body}</p>
                {message.attachments.length > 0 && (
                  <ul className="flex flex-wrap gap-2">
                    {message.attachments.map((fileId, index) => (
                      <li key={fileId}>
                        <a
                          href={shopTicketAttachmentUrl(ticket.id, fileId)}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={tsa('tickets.imageOpen', { n: index + 1 })}
                          className="block size-20 overflow-hidden rounded-md border border-border bg-muted"
                        >
                          {/* biome-ignore lint/performance/noImgElement: a private image served per request. */}
                          <img
                            src={shopTicketAttachmentUrl(ticket.id, fileId)}
                            alt={tsa('tickets.image', { n: index + 1 })}
                            className="size-full object-cover"
                          />
                        </a>
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
        })}
      </ol>
      {ticket.canReply ? (
        <ReplyBox ticket={ticket} onSent={update} onStale={() => void load()} />
      ) : (
        <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <LockIcon className="size-4" aria-hidden="true" />
          {tsa('tickets.closed')}
        </p>
      )}
    </div>
  );
}

/** TK2: the merchant's reply, text and up to 3 images, one key per attempt (`sendAttempt`). */
function ReplyBox({
  ticket,
  onSent,
  onStale,
}: {
  ticket: MerchantShopTicket;
  onSent: (ticket: MerchantShopTicket) => void;
  onStale: () => void;
}) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [showError, setShowError] = useState(false);
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<Failure | null>(null);
  const { ref, focusInvalid } = useFocusInvalid();
  const invalid = showError && !bodyValid(text, files.length);

  async function send(event: FormEvent) {
    event.preventDefault();
    setShowError(true);
    setRefusal(null);
    if (!bodyValid(text, files.length)) return focusInvalid();
    const body = messageBody(text, files.length, tsa('tickets.imageOnly'));
    setSending(true);
    const result = await sendAttempt(
      `shop-ticket-reply:${ticket.id}`,
      attemptSignature({ ticket: ticket.id, body }, files),
      (key) => replyToShopTicket(ticket.id, body, files, key),
      freesSupportKey,
    );
    setSending(false);
    if (result.ok) {
      setText('');
      setFiles([]);
      setShowError(false);
      return onSent(result.data);
    }
    setRefusal(result.reason);
    if (result.reason === 'TICKET_CLOSED' || result.reason === 'NOT_FOUND') onStale();
  }

  return (
    <form ref={ref} noValidate onSubmit={(event) => void send(event)}>
      <Card className="gap-4">
        <Field invalid={invalid}>
          <FieldLabel>{tsa('tickets.reply')}</FieldLabel>
          <Textarea
            name="body"
            value={text}
            maxLength={BODY_MAX}
            className="text-md"
            aria-invalid={invalid}
            disabled={sending}
            onChange={(event) => setText(event.target.value)}
          />
          <FieldError match={invalid}>{tsa('tickets.bodyInvalid')}</FieldError>
        </Field>
        <ImagePicker files={files} onChange={setFiles} disabled={sending} />
        {refusal && <FormAlert>{errorText(refusal)}</FormAlert>}
        <Button type="submit" size="xl" disabled={sending}>
          {sending ? (
            <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
          ) : (
            <SendIcon className="rtl:-scale-x-100" aria-hidden="true" />
          )}
          {sending ? tsa('tickets.sending') : tsa('tickets.send')}
        </Button>
      </Card>
    </form>
  );
}

/** TK2: "أرسل إلى الإدارة" at any time, with a note for the admin. */
function EscalateButton({
  ticket,
  onDone,
}: {
  ticket: MerchantShopTicket;
  onDone: (ticket: MerchantShopTicket) => void;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [showError, setShowError] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const { ref, focusInvalid } = useFocusInvalid();
  const invalid = showError && !shopTicketEscalationSchema.safeParse({ note }).success;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setShowError(true);
    setFailure(null);
    const parsed = shopTicketEscalationSchema.safeParse({ note });
    if (!parsed.success) return focusInvalid();
    setSending(true);
    const result = await escalateShopTicket(ticket.id, parsed.data.note);
    setSending(false);
    if (!result.ok) return setFailure(errorText(result.reason));
    setOpen(false);
    onDone(result.data);
  }

  return (
    <>
      <Button variant="outline" size="xl" className="self-start" onClick={() => setOpen(true)}>
        <ShieldAlertIcon aria-hidden="true" />
        {tsa('tickets.escalate')}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent closeLabel={tsa('common.close')} className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{tsa('tickets.escalateTitle')}</DialogTitle>
            <DialogDescription>{tsa('tickets.escalateBody')}</DialogDescription>
          </DialogHeader>
          <form
            ref={ref}
            className="flex flex-col gap-4"
            noValidate
            onSubmit={(event) => void submit(event)}
          >
            <Field invalid={invalid}>
              <FieldLabel>{tsa('tickets.note')}</FieldLabel>
              <Textarea
                name="note"
                rows={3}
                maxLength={500}
                className="text-md"
                value={note}
                aria-invalid={invalid}
                onChange={(event) => setNote(event.target.value)}
              />
              <FieldError match={invalid}>{tsa('tickets.noteInvalid')}</FieldError>
            </Field>
            {failure && <FormAlert>{failure}</FormAlert>}
            <Button type="submit" size="xl" disabled={sending}>
              {sending && <LoaderCircleIcon className="animate-spin" aria-hidden="true" />}
              {tsa('tickets.escalate')}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
