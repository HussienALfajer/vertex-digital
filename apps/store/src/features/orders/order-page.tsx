'use client';

import { formatSyp, formatUsd, type Order, type OrderCode } from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui/components/badge';
import { Button } from '@vertex-digital/ui/components/button';
import { Card } from '@vertex-digital/ui/components/card';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { CircleAlertIcon, EyeIcon } from 'lucide-react';
import { notFound, useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { CopyButton } from '@/features/deposits/copy-button';
import { Line } from '@/features/deposits/panel';
import { useNotificationEvents } from '@/features/notifications/live';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { t } from '@/lib/i18n';
import { GameCover } from './orders-list';
import { getOrder, revealCode } from './requests';
import { STAGE_TONES, stageSentence, stageText } from './stages';

type State =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'missing' }
  | { status: 'ready'; order: Order };

/**
 * One order (S08 screens): the number with copy, the stage and its sentence, the stages with
 * their times, the product, the account fields, the money, and for a code product each code
 * masked until "إظهار" (rule C2). Read in the browser with the session, never cached; another
 * customer's order is the 404 page; a notification about this order reads it again (NT7).
 */
export function OrderPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<State>({ status: 'loading' });

  const load = useCallback(async () => {
    const result = await getOrder(id);
    if (!result.ok && result.reason === 'UNAUTHORIZED') {
      router.replace(`/sign-in?next=${encodeURIComponent(`/orders/${id}`)}`);
      return;
    }
    if (!result.ok) {
      return setState({ status: result.reason === 'NOT_FOUND' ? 'missing' : 'failed' });
    }
    setState({ status: 'ready', order: result.data });
  }, [id, router]);

  useEffect(() => {
    void load();
  }, [load]);

  useNotificationEvents((event) => {
    if (
      event.type === 'resync' ||
      (event.type === 'notification' &&
        'orderId' in event.notification.params &&
        event.notification.params.orderId === id)
    )
      void load();
  });

  if (state.status === 'missing') notFound();
  if (state.status === 'loading') return <OrderSkeleton />;
  if (state.status === 'failed') {
    return (
      <EmptyState
        icon={<CircleAlertIcon />}
        title={t('orders.detail.loadFailed')}
        action={
          <Button
            variant="outline"
            size="xl"
            onClick={() => {
              setState({ status: 'loading' });
              void load();
            }}
          >
            {t('orders.retry')}
          </Button>
        }
      />
    );
  }

  const { order } = state;
  return (
    <div className="flex flex-col gap-6">
      <Card className="gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <p className="text-sm text-muted-foreground">
              {t('orders.detail.number')}{' '}
              <bdi dir="ltr" className="font-medium text-foreground">
                {order.number}
              </bdi>
            </p>
            <CopyButton value={order.number} label={t('orders.detail.copyNumber')} />
          </div>
          <Badge tone={STAGE_TONES[order.stage]}>{stageText(order.stage)}</Badge>
        </div>
        <p className="text-lg font-bold">{stageSentence(order)}</p>
        <ol className="flex flex-col gap-2" aria-label={t('orders.detail.timeline')}>
          {order.timeline.map((step) => (
            <li
              key={`${step.stage}:${step.at}`}
              className="flex items-center justify-between gap-3"
            >
              <span className="text-sm">{stageText(step.stage)}</span>
              <span className="text-xs text-muted-foreground">{formatDateTime(step.at)}</span>
            </li>
          ))}
        </ol>
      </Card>

      <Card className="gap-4">
        <div className="flex items-center gap-3">
          <GameCover order={order} />
          <div className="flex min-w-0 flex-col">
            <h2 className="font-bold break-words">{order.product.nameAr}</h2>
            <p className="text-sm text-muted-foreground">{order.game.nameAr}</p>
          </div>
        </div>
        <dl className="flex flex-col gap-2">
          {order.fields.map((field) => (
            <Line key={field.key} label={field.labelAr}>
              <bdi dir="ltr">{field.value || t('orders.detail.emptyField')}</bdi>
            </Line>
          ))}
          <Line label={t('orders.detail.quantity')}>{order.quantity}</Line>
          <Line label={t('orders.detail.unitPrice')}>
            <bdi dir="ltr">{formatUsd(order.unitPriceUsdUnits)}</bdi>
          </Line>
          <Line label={t('orders.detail.total')}>
            <bdi dir="ltr">{formatUsd(order.totalUsdUnits)}</bdi>
          </Line>
          {order.totalSypUnits !== null && (
            <Line label={t('orders.detail.totalSyp')}>
              {t('orders.detail.totalSypValue', { amount: formatSyp(order.totalSypUnits) })}
            </Line>
          )}
          {order.refundedUsdUnits > 0 && (
            <Line label={t('orders.detail.refunded')}>
              <bdi dir="ltr">{formatUsd(order.refundedUsdUnits)}</bdi>
            </Line>
          )}
          {order.refundReason && (
            <Line label={t('orders.detail.refundReason')}>
              {t(`orders.refundReasons.${order.refundReason}`)}
            </Line>
          )}
        </dl>
      </Card>

      {order.codes.length > 0 && (
        <Card className="gap-4">
          <h2 className="text-lg font-bold">{t('orders.codes.title')}</h2>
          <ul className="flex flex-col gap-3">
            {order.codes.map((code) => (
              <CodeRow key={code.id} orderId={order.id} code={code} />
            ))}
          </ul>
          {order.product.regionAr && (
            <p className="text-sm">
              <span className="text-muted-foreground">{t('orders.codes.region')} </span>
              {order.product.regionAr}
            </p>
          )}
          {order.product.redemptionAr && (
            <div className="flex flex-col gap-1">
              <h3 className="text-sm font-bold">{t('orders.codes.redemption')}</h3>
              <p className="text-sm whitespace-pre-line text-muted-foreground">
                {order.product.redemptionAr}
              </p>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

/** One code: masked with "إظهار", then the code with "نسخ" and its first reveal (rule C2). */
function CodeRow({ orderId, code }: { orderId: string; code: OrderCode }) {
  const [revealed, setRevealed] = useState<{ code: string; firstRevealedAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const firstRevealedAt = revealed?.firstRevealedAt ?? code.firstRevealedAt;

  const reveal = async () => {
    setFailure(null);
    setBusy(true);
    const result = await revealCode(orderId, code.id);
    setBusy(false);
    if (!result.ok) return setFailure(result.reason);
    setRevealed(result.data);
  };

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 text-base font-medium tabular-nums break-all" dir="ltr">
          {revealed ? revealed.code : code.masked}
        </p>
        {revealed ? (
          <CopyButton value={revealed.code} label={t('orders.codes.copy')} />
        ) : (
          <Button
            variant="outline"
            size="xl"
            className="shrink-0"
            disabled={busy}
            onClick={() => void reveal()}
          >
            <EyeIcon />
            {t('orders.codes.reveal')}
          </Button>
        )}
      </div>
      {firstRevealedAt && (
        <p className="text-xs text-muted-foreground">
          {t('orders.codes.firstRevealed', { date: formatDateTime(firstRevealedAt) })}
        </p>
      )}
      {failure && <FormAlert>{errorText(failure)}</FormAlert>}
    </li>
  );
}

export function OrderSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden="true">
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-56 w-full" />
    </div>
  );
}
