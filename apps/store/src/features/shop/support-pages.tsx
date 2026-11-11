'use client';

import type { ShopTicket, ShopTicketSummary } from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui/components/badge';
import { Button } from '@vertex-digital/ui/components/button';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { Field, FieldError, FieldLabel } from '@vertex-digital/ui/components/field';
import { Input } from '@vertex-digital/ui/components/input';
import { PageHeader } from '@vertex-digital/ui/components/page-header';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { Textarea } from '@vertex-digital/ui/components/textarea';
import { useFocusInvalid } from '@vertex-digital/ui/focus-invalid';
import { ChevronLeftIcon, LifeBuoyIcon, PlusIcon, ShieldAlertIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { InvalidAlert } from '@/components/invalid-alert';
import { PageBackLink } from '@/components/page-back-link';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { useIdempotentRequest } from '@/lib/idempotency';
import { useSearchParam } from '@/lib/use-search-param';
import { ts } from './i18n';
import { ShopNotFound } from './not-found-view';
import { shopPath } from './paths';
import {
  escalateShopTicket,
  getShopOrder,
  getShopTicket,
  listShopTickets,
  openShopTicket,
  replyToShopTicket,
} from './requests';
import { ReadFailed, SessionFailed, useSignedInShopCustomer } from './signed-in';

const STATUS_TONES = { open: 'info', answered: 'success', closed: 'neutral' } as const;

/**
 * "الدعم" in a shop (S26 TK1–TK3): the customer's tickets, newest activity first. The merchant
 * answers first; the customer may ask the store's support to step in after 24 hours without a
 * reply.
 */
export function ShopTicketsList({ slug }: { slug: string }) {
  const customer = useSignedInShopCustomer(slug);
  const signedIn = customer.status === 'signedIn';
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'failed' }
    | { status: 'ready'; items: ShopTicketSummary[]; nextCursor: string | null }
  >({ status: 'loading' });
  const [moreFailure, setMoreFailure] = useState<Failure | null>(null);

  const load = useCallback(async () => {
    const page = await listShopTickets(slug);
    setState(
      page.ok
        ? { status: 'ready', items: page.data.items, nextCursor: page.data.nextCursor }
        : { status: 'failed' },
    );
  }, [slug]);

  useEffect(() => {
    if (signedIn) void load();
  }, [signedIn, load]);

  async function more() {
    if (state.status !== 'ready' || !state.nextCursor) return;
    const page = await listShopTickets(slug, { cursor: state.nextCursor });
    if (!page.ok) return setMoreFailure(page.reason);
    setState({
      status: 'ready',
      items: [...state.items, ...page.data.items],
      nextCursor: page.data.nextCursor,
    });
  }

  const newTicket = (
    <Button size="xl" render={<Link href={shopPath(slug, '/support/new')} prefetch={false} />}>
      <PlusIcon aria-hidden="true" />
      {ts('support.new')}
    </Button>
  );
  return (
    <Page>
      <PageHeader title={ts('support.title')} description={ts('support.intro')} />
      {customer.status === 'failed' ? (
        <SessionFailed slug={slug} />
      ) : state.status === 'loading' ? (
        <Skeleton className="h-40 w-full" />
      ) : state.status === 'failed' ? (
        <ReadFailed title={ts('support.failed')} onRetry={() => void load()} />
      ) : state.items.length === 0 ? (
        <EmptyState
          icon={<LifeBuoyIcon />}
          title={ts('support.empty')}
          description={ts('support.emptyBody')}
          action={newTicket}
        />
      ) : (
        <>
          <div className="self-start">{newTicket}</div>
          <ul className="flex flex-col gap-3">
            {state.items.map((ticket) => (
              <li key={ticket.id}>
                <Link
                  href={shopPath(slug, `/support/${ticket.id}`)}
                  prefetch={false}
                  className="flex items-center gap-3 rounded-xl border border-border bg-surface p-4 hover:border-(--shop-brand)"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="font-bold break-words">{ticket.subject}</span>
                    <span className="text-xs text-muted-foreground">
                      <bdi dir="ltr">{ticket.number}</bdi> · {formatDateTime(ticket.lastMessageAt)}
                      {' · '}
                      {ts(`support.from.${ticket.lastReplier}`)}
                    </span>
                    <span className="flex flex-wrap gap-2">
                      <Badge tone={STATUS_TONES[ticket.status]}>
                        {ts(`support.states.${ticket.status}`)}
                      </Badge>
                      {ticket.escalatedAt && (
                        <Badge tone="warning">{ts('support.from.support')}</Badge>
                      )}
                    </span>
                  </span>
                  <ChevronLeftIcon
                    className="size-5 shrink-0 text-muted-foreground ltr:-scale-x-100"
                    aria-hidden="true"
                  />
                </Link>
              </li>
            ))}
          </ul>
          {moreFailure && <FormAlert>{errorText(moreFailure)}</FormAlert>}
          {state.nextCursor && (
            <Button variant="outline" size="xl" onClick={() => void more()}>
              {ts('support.more')}
            </Button>
          )}
        </>
      )}
    </Page>
  );
}

/** TK1: a new ticket to the merchant, about an order when opened from one (`?order=<number>`). */
export function ShopNewTicket({ slug }: { slug: string }) {
  const router = useRouter();
  const customer = useSignedInShopCustomer(slug);
  const orderNumber = useSearchParam('order');
  const [order, setOrder] = useState<{ id: string; number: string } | null>(null);
  const [errors, setErrors] = useState<{ subject?: string; body?: string }>({});
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState(false);
  const send = useIdempotentRequest();
  const { ref, focusInvalid } = useFocusInvalid<HTMLFormElement>();

  useEffect(() => {
    if (customer.status !== 'signedIn' || !orderNumber) return;
    void getShopOrder(slug, orderNumber).then((result) => {
      if (result.ok) setOrder({ id: result.data.id, number: result.data.number });
    });
  }, [customer.status, orderNumber, slug]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const subject = String(data.get('subject') ?? '').trim();
    const body = String(data.get('body') ?? '').trim();
    const found = {
      subject: subject.length < 3 ? ts('support.subjectRequired') : undefined,
      body: body ? undefined : ts('support.messageRequired'),
    };
    setErrors(found);
    setFailure(null);
    if (found.subject || found.body) return focusInvalid();
    setPending(true);
    const ticket = { orderId: order?.id ?? null, subject, body };
    const result = await send(JSON.stringify(ticket), (key) => openShopTicket(slug, ticket, key));
    if (result.ok) {
      router.push(shopPath(slug, `/support/${result.data.id}`));
      return;
    }
    setPending(false);
    setFailure(result.reason);
  }

  return (
    <Page>
      <PageBackLink href={shopPath(slug, '/support')}>{ts('back.support')}</PageBackLink>
      <PageHeader title={ts('support.new')} />
      {customer.status === 'failed' ? (
        <SessionFailed slug={slug} />
      ) : customer.status !== 'signedIn' ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <form ref={ref} noValidate onSubmit={submit} className="flex flex-col gap-5">
          {order && (
            <p className="text-sm">
              {ts('support.order')}: <bdi dir="ltr">{order.number}</bdi>
            </p>
          )}
          <Field invalid={!!errors.subject}>
            <FieldLabel>{ts('support.subject')}</FieldLabel>
            <Input
              name="subject"
              maxLength={120}
              defaultValue={order ? ts('orders.number', { number: order.number }) : undefined}
              key={order?.id ?? 'none'}
              className="h-11 text-md"
              aria-invalid={!!errors.subject}
            />
            <FieldError match={!!errors.subject}>{errors.subject}</FieldError>
          </Field>
          <Field invalid={!!errors.body}>
            <FieldLabel>{ts('support.message')}</FieldLabel>
            <Textarea
              name="body"
              rows={5}
              maxLength={2000}
              className="text-md"
              aria-invalid={!!errors.body}
            />
            <FieldError match={!!errors.body}>{errors.body}</FieldError>
          </Field>
          {failure && <FormAlert>{errorText(failure)}</FormAlert>}
          <InvalidAlert show={!!(errors.subject || errors.body)} />
          <Button type="submit" size="xl" disabled={pending}>
            {pending ? ts('support.sending') : ts('support.send')}
          </Button>
        </form>
      )}
    </Page>
  );
}

/** TK2, TK3: the thread (the shop or the store's support as the replier), a reply, escalation. */
export function ShopTicketPage({ slug, id }: { slug: string; id: string }) {
  const customer = useSignedInShopCustomer(slug);
  const signedIn = customer.status === 'signedIn';
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'failed' }
    | { status: 'missing' }
    | { status: 'ready'; ticket: ShopTicket }
  >({ status: 'loading' });
  const [reply, setReply] = useState('');
  const [replyError, setReplyError] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pending, setPending] = useState<'reply' | 'escalate' | null>(null);
  const [escalated, setEscalated] = useState(false);
  const send = useIdempotentRequest();
  const latest = useRef(0);

  const load = useCallback(async () => {
    const read = ++latest.current;
    const result = await getShopTicket(slug, id);
    if (read !== latest.current) return;
    if (result.ok) return setState({ status: 'ready', ticket: result.data });
    setState((current) =>
      result.reason === 'NOT_FOUND'
        ? { status: 'missing' }
        : current.status === 'ready'
          ? current
          : { status: 'failed' },
    );
  }, [slug, id]);

  useEffect(() => {
    if (signedIn) void load();
  }, [signedIn, load]);

  async function submitReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = reply.trim();
    setFailure(null);
    if (!body) return setReplyError(true);
    setPending('reply');
    const result = await send(body, (key) => replyToShopTicket(slug, id, body, key));
    setPending(null);
    if (!result.ok) return setFailure(result.reason);
    setReply('');
    setState({ status: 'ready', ticket: result.data });
  }

  async function escalate() {
    setPending('escalate');
    setFailure(null);
    const result = await escalateShopTicket(slug, id);
    setPending(null);
    if (!result.ok) return setFailure(result.reason);
    setEscalated(true);
    setState({ status: 'ready', ticket: result.data });
  }

  const back = <PageBackLink href={shopPath(slug, '/support')}>{ts('back.support')}</PageBackLink>;
  if (state.status === 'missing') return <ShopNotFound />;
  if (customer.status === 'failed') {
    return (
      <Page>
        {back}
        <SessionFailed slug={slug} />
      </Page>
    );
  }
  if (state.status === 'loading') {
    return (
      <Page>
        {back}
        <Skeleton className="h-64 w-full" />
      </Page>
    );
  }
  if (state.status === 'failed') {
    return (
      <Page>
        {back}
        <ReadFailed title={ts('support.failed')} onRetry={() => void load()} />
      </Page>
    );
  }
  const { ticket } = state;
  return (
    <Page>
      {back}
      <PageHeader
        title={ticket.subject}
        description={`${ticket.number} · ${ts(`support.states.${ticket.status}`)}`}
      />
      {ticket.order && (
        <Link
          href={shopPath(slug, `/orders/${ticket.order.number}`)}
          prefetch={false}
          className="self-start text-sm font-medium underline underline-offset-4"
        >
          {ts('orders.number', { number: ticket.order.number })}
        </Link>
      )}
      <ol className="flex flex-col gap-3">
        {ticket.messages.map((message) => (
          <li
            key={message.id}
            className={`flex flex-col gap-1 rounded-xl border p-4 ${message.from === 'customer' ? 'border-border bg-surface' : 'border-(--shop-brand) bg-surface'}`}
          >
            <span className="flex justify-between gap-2 text-xs text-muted-foreground">
              <span className="font-bold text-foreground">
                {ts(`support.from.${message.from}`)}
              </span>
              {formatDateTime(message.createdAt)}
            </span>
            <p className="text-base whitespace-pre-line break-words">{message.body}</p>
          </li>
        ))}
      </ol>
      {(escalated || ticket.escalatedAt) && (
        <FormAlert tone="success">{ts('support.escalated')}</FormAlert>
      )}
      {failure && <FormAlert>{errorText(failure)}</FormAlert>}
      {ticket.canReply ? (
        <form noValidate onSubmit={submitReply} className="flex flex-col gap-3">
          <Field invalid={replyError}>
            <FieldLabel>{ts('support.reply')}</FieldLabel>
            <Textarea
              value={reply}
              rows={4}
              maxLength={2000}
              className="text-md"
              aria-invalid={replyError}
              onChange={(event) => {
                setReply(event.target.value);
                setReplyError(false);
              }}
            />
            <FieldError match={replyError}>{ts('support.messageRequired')}</FieldError>
          </Field>
          <Button type="submit" size="xl" disabled={pending !== null}>
            {pending === 'reply' ? ts('support.sending') : ts('support.replySend')}
          </Button>
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">{ts('support.closed')}</p>
      )}
      {!ticket.escalatedAt &&
        (ticket.canEscalate ? (
          <Button
            variant="outline"
            size="xl"
            disabled={pending !== null}
            onClick={() => void escalate()}
          >
            <ShieldAlertIcon aria-hidden="true" />
            {pending === 'escalate' ? ts('support.escalating') : ts('support.escalate')}
          </Button>
        ) : (
          ticket.status !== 'closed' && (
            <p className="text-xs text-muted-foreground">{ts('support.escalateNote')}</p>
          )
        ))}
    </Page>
  );
}

function Page({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-6 md:py-10">
      {children}
    </div>
  );
}
