'use client';

import {
  type Order,
  type OrderProblemOption,
  orderProblemsFor,
  slowAfterSeconds,
} from '@vertex-digital/contracts';
import { Button } from '@vertex-digital/ui/components/button';
import { Card } from '@vertex-digital/ui/components/card';
import { LifeBuoyIcon, MessageSquareWarningIcon } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useState } from 'react';
import { serverNow } from '@/lib/server-clock';
import { th } from './i18n';
import { problemLabel } from './problems';

const ProblemSheet = dynamic(() => import('./problem-sheet').then((module) => module.ProblemSheet));

/**
 * "مشكلة في الطلب؟" on the order page (S22 OP1–OP3): the problems the order's state and kind
 * offer, each opening a sheet with what to check first and the ticket's form; the open ticket
 * instead while there is one (TK1); past the 7 days, a plain ticket. Nothing for a reservation or
 * a cancelled order (no money taken). The server checks the problem again.
 */
export function ProblemCard({ order, onChanged }: { order: Order; onChanged: () => void }) {
  const [chosen, setChosen] = useState<OrderProblemOption | null>(null);
  const { help } = order;

  if (help.openTicketId) {
    return (
      <Card className="flex-row flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-2 font-medium">
          <LifeBuoyIcon className="size-5 text-primary" aria-hidden="true" />
          {th('card.openTicket')}
        </p>
        <Button
          variant="outline"
          size="xl"
          render={<Link href={`/support/${help.openTicketId}`} prefetch={false} />}
        >
          {th('card.openTicketLink')}
        </Button>
      </Card>
    );
  }

  const view = orderProblemsFor(
    {
      status: help.status,
      productKind: order.product.kind,
      paidAt: help.paidAt ? new Date(help.paidAt) : null,
      finishedAt: help.finishedAt ? new Date(help.finishedAt) : null,
    },
    new Date(serverNow()),
    slowAfterSeconds(order.deliveryStats),
  );
  if (view.state === 'none') return null;
  if (view.state === 'window_closed') {
    return (
      <Card className="gap-3" data-testid="problem-card">
        <h2 className="font-bold">{th('card.title')}</h2>
        <p className="text-sm text-muted-foreground">{th('card.windowClosed')}</p>
        <Button
          variant="outline"
          size="xl"
          className="self-start"
          render={<Link href={`/support/new?category=order&order=${order.id}`} prefetch={false} />}
        >
          {th('card.windowClosedLink')}
        </Button>
      </Card>
    );
  }

  return (
    <Card className="gap-4" data-testid="problem-card">
      <div className="flex flex-col gap-1">
        <h2 className="flex items-center gap-2 font-bold">
          <MessageSquareWarningIcon className="size-5 text-primary" aria-hidden="true" />
          {th('card.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{th('card.hint')}</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {view.problems.map((option) => (
          <Button
            key={option.problem}
            variant="outline"
            size="xl"
            className="justify-start"
            onClick={() => setChosen(option)}
          >
            {problemLabel(option.problem, help.status)}
          </Button>
        ))}
      </div>
      {chosen && (
        <ProblemSheet
          order={order}
          option={chosen}
          onOpenChange={(open) => {
            if (!open) setChosen(null);
          }}
          onRefused={() => {
            setChosen(null);
            onChanged();
          }}
        />
      )}
    </Card>
  );
}
