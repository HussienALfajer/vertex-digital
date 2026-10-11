'use client';

import type { TicketSummary } from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui/components/badge';
import { Button } from '@vertex-digital/ui/components/button';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { CircleAlertIcon, LifeBuoyIcon, LogInIcon, MessageSquarePlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { formatRelative } from '@/lib/format';
import { t } from '@/lib/i18n';
import { categoryText, STATUS_TONES, statusText } from './labels';
import { OnTicketReplied } from './on-ticket-replied';
import { listTickets } from './requests';

type State =
  | { status: 'loading' }
  | { status: 'signedOut' }
  | { status: 'failed' }
  | { status: 'ready'; tickets: TicketSummary[]; nextCursor: string | null };

/**
 * The customer's tickets on `/support` (S12 TK12): newest activity first, 20 at a time, a dot on
 * a ticket whose last message is the team's. Read in the browser with the session, never cached;
 * signed out, the page asks to sign in (the Telegram card above still shows). A reply arrives
 * live (`ticket_replied`) and the list is read again.
 */
export function TicketsList() {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreFailure, setMoreFailure] = useState<Failure | null>(null);

  const load = useCallback(async () => {
    const page = await listTickets();
    if (!page.ok && page.reason === 'UNAUTHORIZED') return setState({ status: 'signedOut' });
    if (!page.ok) return setState({ status: 'failed' });
    setState({ status: 'ready', tickets: page.data.items, nextCursor: page.data.nextCursor });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async (cursor: string) => {
    setMoreFailure(null);
    setLoadingMore(true);
    const page = await listTickets({ cursor });
    setLoadingMore(false);
    if (!page.ok) return setMoreFailure(page.reason);
    setState((previous) =>
      previous.status === 'ready'
        ? {
            ...previous,
            tickets: [...previous.tickets, ...page.data.items],
            nextCursor: page.data.nextCursor,
          }
        : previous,
    );
  };

  if (state.status === 'loading') return <TicketsSkeleton />;
  if (state.status === 'signedOut') {
    return (
      <EmptyState
        icon={<LogInIcon />}
        title={t('support.signedOut.title')}
        description={t('support.signedOut.body')}
        action={
          <Button size="xl" render={<Link href="/sign-in?next=%2Fsupport" prefetch={false} />}>
            {t('support.signedOut.action')}
          </Button>
        }
      />
    );
  }
  if (state.status === 'failed') {
    return (
      <EmptyState
        icon={<CircleAlertIcon />}
        title={t('support.loadFailed')}
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

  const newButton = (
    <Button size="xl" render={<Link href="/support/new" />}>
      <MessageSquarePlusIcon aria-hidden="true" />
      {t('support.newTicket')}
    </Button>
  );
  if (state.tickets.length === 0) {
    return (
      <>
        <OnTicketReplied onReply={load} />
        <EmptyState
          icon={<LifeBuoyIcon />}
          title={t('support.emptyTitle')}
          description={t('support.emptyBody')}
          action={newButton}
        />
      </>
    );
  }
  return (
    <section className="flex flex-col gap-3" aria-labelledby="support-tickets">
      <OnTicketReplied onReply={load} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="support-tickets" className="text-lg font-bold">
          {t('support.listTitle')}
        </h2>
        {newButton}
      </div>
      <ul className="flex flex-col gap-3">
        {state.tickets.map((ticket) => (
          <li key={ticket.id}>
            <TicketCard ticket={ticket} />
          </li>
        ))}
      </ul>
      {moreFailure && <FormAlert>{errorText(moreFailure)}</FormAlert>}
      {state.nextCursor && (
        <Button
          variant="outline"
          size="xl"
          className="self-center"
          disabled={loadingMore}
          onClick={() => void loadMore(state.nextCursor as string)}
        >
          {loadingMore ? t('support.loadingMore') : t('support.loadMore')}
        </Button>
      )}
    </section>
  );
}

function TicketCard({ ticket }: { ticket: TicketSummary }) {
  // TK12: the dot while the team's message is the last one and the ticket is still open.
  const replied = ticket.lastAuthor === 'admin' && ticket.status !== 'closed';
  return (
    <Link
      href={`/support/${ticket.id}`}
      className="flex items-start gap-3 rounded-lg border border-border bg-surface p-4 transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="flex items-center gap-2 font-medium">
          {replied && (
            <span
              role="img"
              aria-label={t('support.newReply')}
              className="size-2.5 shrink-0 rounded-full bg-accent"
            />
          )}
          <bdi className="min-w-0 break-words">{ticket.subject}</bdi>
        </p>
        <p className="text-sm text-muted-foreground">
          {categoryText(ticket.category)}
          {ticket.order && (
            <>
              {' · '}
              <bdi dir="ltr">{ticket.order.number}</bdi>
            </>
          )}
          {ticket.deposit && (
            <>
              {' · '}
              <bdi dir="ltr">{ticket.deposit.referenceCode}</bdi>
            </>
          )}
        </p>
        <p className="text-xs text-muted-foreground">
          <bdi dir="ltr">{ticket.number}</bdi> ·{' '}
          {t('support.lastActivity', { time: formatRelative(ticket.lastMessageAt) })}
        </p>
      </div>
      <Badge tone={STATUS_TONES[ticket.status]} className="shrink-0">
        {statusText(ticket.status)}
      </Badge>
    </Link>
  );
}

function TicketsSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden="true">
      <Skeleton className="h-6 w-28" />
      {[0, 1, 2].map((row) => (
        <Skeleton key={row} className="h-24 w-full" />
      ))}
    </div>
  );
}
