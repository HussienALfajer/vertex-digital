'use client';

import { formatSyp, formatUsd, type Order, type OrderCode } from '@vertex-digital/contracts';
import { SuccessMark } from '@vertex-digital/ui/brand/success-mark';
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
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import {
  CircleAlertIcon,
  ClockIcon,
  EyeIcon,
  HourglassIcon,
  ReceiptTextIcon,
  RotateCwIcon,
  ShoppingCartIcon,
  UserRoundCheckIcon,
} from 'lucide-react';
import Link from 'next/link';
import { notFound, useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { deliveryDetailText } from '@/features/catalog/delivery';
import { centsParam } from '@/features/deposits/amounts';
import { CopyButton } from '@/features/deposits/copy-button';
import { Line } from '@/features/deposits/panel';
import { formatClock, useTimeLeft } from '@/features/deposits/use-time-left';
import { useNotificationEvents, useVisibleAgain } from '@/features/notifications/live';
import { useBalance } from '@/features/purchase/customer';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { formatDateTime, ltr } from '@/lib/format';
import { t } from '@/lib/i18n';
import { GameCover, repeatHref } from './orders-list';
import { cancelOrder, getOrder, revealCode } from './requests';
import { GiftSection, ReceiptSheet, shareable } from './share-links';
import { STAGE_TONES, stageSentence, stageText, stepText, timelineEntries } from './stages';

type State =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'missing' }
  | { status: 'ready'; order: Order };

/**
 * One order (S08 screens, S09 rules LT1–LT3): the number with copy, the stage and its sentence,
 * the timeline with the steps still ahead greyed, the expected time while open, a reservation's
 * countdown with "اشحن رصيدك" and "إلغاء الطلب", the in-game name of a validated order, the
 * product, the account fields, the money, and for a code product each code masked until "إظهار"
 * (rule C2). Read in the browser with the session, never cached; another customer's order is the
 * 404 page. Live: an `order` event or a notification about this order, a `resync`, or the tab
 * coming back into view reads it again (rule LT2); the delivery plays the success sequence once.
 * S10: "اشترِ مجدداً" (OT1), "مشاركة الإيصال" (RC1), "ضمن سلة" (CT6) and the gift (GF4).
 */
export function OrderPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [receiptOpen, setReceiptOpen] = useState(false);

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
      (event.type === 'order' && event.order.orderId === id) ||
      (event.type === 'notification' &&
        'orderId' in event.notification.params &&
        event.notification.params.orderId === id)
    )
      void load();
  });
  useVisibleAgain(() => void load());

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
        <div className="flex items-center gap-3">
          {order.stage === 'delivered' && <Celebration orderId={order.id} />}
          <p className="text-lg font-bold">{stageSentence(order)}</p>
        </div>
        {(order.stage === 'processing' || order.stage === 'delayed') && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <ClockIcon className="size-4 shrink-0" aria-hidden="true" />
            {deliveryDetailText(order.deliveryStats)}
          </p>
        )}
        {order.playerName && (
          <p className="flex items-center gap-2 text-sm">
            <UserRoundCheckIcon
              className="size-4 shrink-0 text-status-success-foreground"
              aria-hidden="true"
            />
            <span>
              {t('orders.detail.playerName')} <bdi className="font-bold">{order.playerName}</bdi>
            </span>
          </p>
        )}
        <Timeline order={order} />
        {(order.repeatable || shareable(order) || order.checkoutId) && (
          <div className="flex flex-wrap gap-2 border-t border-border pt-4">
            {order.repeatable && (
              <Button size="xl" render={<Link href={repeatHref(order, order.product.id)} />}>
                <RotateCwIcon aria-hidden="true" />
                {t('orders.repeat')}
              </Button>
            )}
            {shareable(order) && (
              <Button variant="outline" size="xl" onClick={() => setReceiptOpen(true)}>
                <ReceiptTextIcon aria-hidden="true" />
                {t('orders.receipt.open')}
              </Button>
            )}
            {order.checkoutId && (
              <Button
                variant="ghost"
                size="xl"
                render={<Link href={`/orders?checkout=${order.checkoutId}`} />}
              >
                <ShoppingCartIcon aria-hidden="true" />
                {t('orders.checkout.partOf')}
              </Button>
            )}
          </div>
        )}
      </Card>
      {shareable(order) && (
        <ReceiptSheet
          key={order.shareLinks.find((link) => link.kind === 'receipt')?.id ?? 'new'}
          order={order}
          open={receiptOpen}
          onOpenChange={setReceiptOpen}
          onChange={load}
        />
      )}

      {order.stage === 'awaiting_balance' && <Reservation order={order} onChange={load} />}

      <Card className="gap-4">
        <div className="flex items-center gap-3">
          <GameCover order={order} />
          <div className="flex min-w-0 flex-col">
            <h2 className="font-bold break-words">
              <bdi>{order.product.nameAr}</bdi>
            </h2>
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

      {order.isGift && <GiftSection order={order} onChange={load} />}

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

/**
 * Rule LT1: the steps reached with their times, the newest one marked while the order is open,
 * and the path's steps still ahead greyed. Each step's marker is a 60° parallelogram (§5).
 */
function Timeline({ order }: { order: Order }) {
  return (
    <ol className="flex flex-col gap-2" aria-label={t('orders.detail.timeline')}>
      {timelineEntries(order).map((entry) => (
        <li
          key={`${entry.step}:${entry.at ?? 'next'}`}
          aria-current={entry.state === 'current' ? 'step' : undefined}
          className={`flex items-center justify-between gap-3 ${entry.state === 'upcoming' ? 'text-muted-foreground' : ''}`}
        >
          <span className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className={`inline-block h-4 w-2 -skew-x-30 ${
                entry.state === 'upcoming'
                  ? 'border border-border'
                  : entry.state === 'current'
                    ? 'bg-accent'
                    : 'bg-status-success-foreground'
              }`}
            />
            <span className={`text-sm ${entry.state === 'current' ? 'font-bold' : ''}`}>
              {stepText(entry.step)}
            </span>
          </span>
          {entry.at && (
            <span className="text-xs text-muted-foreground">{formatDateTime(entry.at)}</span>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * Rule LT3 for a reservation: "بانتظار رصيدك" with the time left until it expires, what the
 * balance lacks (read in the browser), "اشحن رصيدك" into the deposit wizard with the shortfall and
 * a link back (rule BB8), and "إلغاء الطلب" after a confirmation (rule RS8).
 */
function Reservation({ order, onChange }: { order: Order; onChange: () => Promise<void> }) {
  const left = useTimeLeft(order.expiresAt);
  const { balance } = useBalance(true);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const shortfall =
    balance.status === 'ready' && order.totalUsdUnits > balance.units
      ? order.totalUsdUnits - balance.units
      : null;
  const deposit = `/wallet/deposit?${new URLSearchParams({
    ...(shortfall !== null && { amount: centsParam(shortfall) }),
    order: order.id,
  })}`;

  const cancel = async () => {
    setFailure(null);
    setBusy(true);
    const result = await cancelOrder(order.id);
    setBusy(false);
    setConfirming(false);
    if (!result.ok) setFailure(result.reason);
    await onChange();
  };

  return (
    <Card className="gap-4 border-status-warning">
      <div className="flex items-center gap-3">
        <HourglassIcon
          className="size-5 shrink-0 text-status-warning-foreground"
          aria-hidden="true"
        />
        <h2 className="text-lg font-bold">{t('orders.reservation.title')}</h2>
      </div>
      <p className="text-base">
        {t('orders.reservation.expiresIn')}{' '}
        <bdi dir="ltr" className="font-bold tabular-nums" role="timer">
          {formatClock(left)}
        </bdi>
      </p>
      {shortfall !== null && balance.status === 'ready' && (
        <p className="text-sm text-muted-foreground">
          {t('orders.reservation.shortfall', {
            balance: ltr(formatUsd(balance.units)),
            missing: ltr(formatUsd(shortfall)),
          })}
        </p>
      )}
      <p className="text-sm text-muted-foreground">{t('orders.reservation.howItPays')}</p>
      {failure && <FormAlert>{errorText(failure)}</FormAlert>}
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button size="xl" render={<Link href={deposit} />}>
          {t('orders.reservation.deposit')}
        </Button>
        <Button variant="outline" size="xl" disabled={busy} onClick={() => setConfirming(true)}>
          {t('orders.reservation.cancel')}
        </Button>
      </div>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('orders.reservation.cancelTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('orders.reservation.cancelBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="xl" />}>
              {t('orders.reservation.keep')}
            </AlertDialogClose>
            <Button variant="destructive" size="xl" disabled={busy} onClick={() => void cancel()}>
              {t('orders.reservation.cancelConfirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

/**
 * The success sequence (brand/identity.md §6): the mark's strokes rise once per order in this
 * tab, not on every visit.
 */
function Celebration({ orderId }: { orderId: string }) {
  const [play, setPlay] = useState(false);
  const checked = useRef(false);
  useEffect(() => {
    if (checked.current) return;
    checked.current = true;
    const key = `vd:celebrated:${orderId}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');
    } catch {
      // Without storage it plays on each visit: harmless.
    }
    setPlay(true);
  }, [orderId]);
  return play ? <SuccessMark className="w-12 text-status-success-foreground" /> : null;
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
