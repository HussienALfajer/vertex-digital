import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { formatUsd } from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  EmptyState,
  Sheet,
  SheetClose,
  SheetContent,
  SheetTitle,
  Skeleton,
} from '@vertex-digital/ui';
import { CircleAlertIcon, ExternalLinkIcon, XIcon } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '../../lib/errors';
import { formatDateTime } from '../../lib/format';
import {
  hasActions,
  type OrderAction,
  OrderActionButtons,
  OrderActionDialog,
} from './order-actions';
import { ATTEMPT_TONES, STATUS_TONES } from './order-labels';
import { orderQuery } from './orders.queries';

/** The newest events the sheet shows (rule LR7). */
const EVENTS_SHOWN = 5;

/**
 * S11 rule LR7: an order of the live room in a side sheet, with the actions it allows now. After
 * an action the order and the board are read again (the mutations invalidate `orders`), so the
 * sheet shows the new state.
 */
export function LiveSheet({ orderId, onClose }: { orderId: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Sheet open={orderId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-[min(30rem,100vw)] max-w-none overflow-y-auto bg-surface p-6">
        <div className="mb-4 flex items-center justify-between gap-2">
          <SheetTitle className="text-lg font-bold">{t('orders.live.sheet.title')}</SheetTitle>
          <SheetClose
            render={<Button variant="ghost" size="icon-sm" aria-label={t('common.close')} />}
          >
            <XIcon />
          </SheetClose>
        </div>
        {orderId && <SheetBody orderId={orderId} />}
      </SheetContent>
    </Sheet>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-end font-medium tabular-nums">{children}</dd>
    </div>
  );
}

function SheetBody({ orderId }: { orderId: string }) {
  const { t } = useTranslation();
  const order = useQuery(orderQuery(orderId));
  const [action, setAction] = useState<OrderAction | null>(null);

  if (order.isPending) return <Skeleton className="h-80 w-full" aria-hidden="true" />;
  if (order.isError) {
    return (
      <EmptyState
        icon={<CircleAlertIcon />}
        title={errorMessage(t, order.error)}
        action={
          <Button variant="outline" onClick={() => order.refetch()}>
            {t('common.retry')}
          </Button>
        }
      />
    );
  }
  const data = order.data;
  const open = data.attempts.find((item) =>
    ['sending', 'pending', 'unknown'].includes(item.status),
  );
  const attempt = open ?? data.attempts[0];
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <bdi dir="ltr" className="text-xl font-bold">
          {data.number}
        </bdi>
        <Badge tone={STATUS_TONES[data.status]}>{t(`orders.statuses.${data.status}`)}</Badge>
        {data.customer.isTest && <Badge tone="info">{t('wallets.testBadge')}</Badge>}
      </div>
      <dl className="flex flex-col gap-2">
        <Row label={t('orders.live.sheet.product')}>
          {data.product.nameAr} · {data.game.nameAr}
        </Row>
        <Row label={t('orders.detail.customer')}>
          <bdi dir="ltr">{data.customer.email}</bdi>
        </Row>
        <Row label={t('orders.detail.units')}>
          {t('orders.detail.unitsValue', {
            quantity: data.quantity,
            delivered: data.deliveredQuantity,
            refunded: data.refundedQuantity,
          })}
        </Row>
        <Row label={t('orders.detail.total')}>
          <bdi dir="ltr">{formatUsd(data.totalUsdUnits)}</bdi>
        </Row>
        <Row label={t('orders.detail.paidAt')}>
          {data.paidAt ? formatDateTime(data.paidAt) : '—'}
        </Row>
        {data.reviewSince && (
          <Row label={t('orders.detail.reviewSince')}>{formatDateTime(data.reviewSince)}</Row>
        )}
      </dl>
      {attempt && (
        <section className="flex flex-col gap-2 rounded-md border border-border p-3">
          <h3 className="flex flex-wrap items-center gap-2 text-sm font-bold">
            {open ? t('orders.live.sheet.openAttempt') : t('orders.live.sheet.lastAttempt')}
            <span className="font-medium">{attempt.supplierNameAr}</span>
            <Badge tone={ATTEMPT_TONES[attempt.status]}>
              {t(`orders.attempts.statuses.${attempt.status}`)}
            </Badge>
          </h3>
          <dl className="flex flex-col gap-2">
            <Row label={t('orders.attempts.polls')}>{attempt.pollCount}</Row>
            <Row label={t('orders.live.sheet.sentAt')}>
              {formatDateTime(attempt.sentAt ?? attempt.createdAt)}
            </Row>
            {attempt.nextPollAt && (
              <Row label={t('orders.live.sheet.nextPoll')}>
                {formatDateTime(attempt.nextPollAt)}
              </Row>
            )}
          </dl>
        </section>
      )}
      {hasActions(data) && (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-bold">{t('orders.decisions.title')}</h3>
          <OrderActionButtons order={data} onAction={setAction} />
        </section>
      )}
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-bold">{t('orders.events.title')}</h3>
        <ol className="flex flex-col gap-1 text-sm">
          {data.events
            .slice(-EVENTS_SHOWN)
            .reverse()
            .map((event) => (
              <li key={event.id} className="flex flex-wrap justify-between gap-2">
                <span>
                  {event.kind === 'status' && event.toStatus
                    ? t('orders.events.status', { to: t(`orders.statuses.${event.toStatus}`) })
                    : event.kind === 'attempt'
                      ? t('orders.live.sheet.attemptEvent')
                      : t('orders.events.note')}
                  {' · '}
                  <span className="text-muted-foreground">
                    {t(`orders.events.actors.${event.actor}`)}
                  </span>
                </span>
                <span className="text-muted-foreground">{formatDateTime(event.createdAt)}</span>
              </li>
            ))}
        </ol>
      </section>
      <Button
        variant="outline"
        render={<Link to="/orders/$id" params={{ id: data.id }} />}
        className="w-fit"
      >
        <ExternalLinkIcon />
        {t('orders.live.sheet.openPage')}
      </Button>
      <OrderActionDialog order={data} action={action} onClose={() => setAction(null)} />
    </div>
  );
}
