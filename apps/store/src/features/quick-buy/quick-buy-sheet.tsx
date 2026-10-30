'use client';

import {
  type CreateOrder,
  depositGap,
  displaySypTotal,
  formatSyp,
  formatUsd,
  orderTotal,
  type QuickBuyItem,
} from '@vertex-digital/contracts';
import { Button } from '@vertex-digital/ui/components/button';
import { Sheet, SheetContent, SheetTitle } from '@vertex-digital/ui/components/sheet';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { SlideToPay } from '@vertex-digital/ui/components/slide-to-pay';
import { Gamepad2Icon, LoaderCircleIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { CatalogPicture } from '@/features/catalog/catalog-picture';
import { sendAttempt } from '@/features/purchase/attempt';
import { useBalance, usePurchasesStopped } from '@/features/purchase/customer';
import { GapBlock } from '@/features/purchase/gap-block';
import { gapDepositPath } from '@/features/purchase/gap-path';
import { freesKey } from '@/features/purchase/order-key';
import { purchaseRefusalText } from '@/features/purchase/refusals';
import { createOrder } from '@/features/purchase/requests';
import { isFrozenCustomer, useCustomer } from '@/features/purchase/session';
import { tq } from '@/features/quick-buy/i18n';
import { errorText } from '@/lib/errors';
import { ltr } from '@/lib/format';
import { t } from '@/lib/i18n';
import { trackFlight } from '@/lib/in-flight';
import { mainValue } from './main-value';

type Sending =
  | { status: 'idle' }
  | { status: 'sending' }
  | { status: 'failed'; message: string; retry: boolean };

/**
 * The quick-buy sheet (S22 QB4, BG2) of a ready card: the game, the saved ID's label, its main
 * value large and the last checked name, the pack, the quantity, the total with its pounds, then
 * slide-to-pay with the saved fields (`confirmPlayer`: a saved ID counts as confirmed, S10 SP3)
 * and today's price. A changed price answers `PRICE_CHANGED` and the new price waits for another
 * slide; a short balance shows the gap with "احجز واشحن الفرق" instead.
 */
export function QuickBuySheet({
  item,
  onOpenChange,
}: {
  item: QuickBuyItem;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const customer = useCustomer();
  const frozen = isFrozenCustomer(customer);
  const stopped = usePurchasesStopped();
  const { balance, refresh } = useBalance(true);
  const [unitPrice, setUnitPrice] = useState(item.unitPriceUsdUnits as number);
  const [mode, setMode] = useState<'buy' | 'reserve'>('buy');
  const [sending, setSending] = useState<Sending>({ status: 'idle' });
  const [slide, setSlide] = useState(0);
  const [reserveBlocked, setReserveBlocked] = useState(false);
  const total = orderTotal(unitPrice, item.quantity);
  // The card's pounds hold for its price only; a new price shows none until the next read.
  const totalSyp =
    unitPrice === item.unitPriceUsdUnits && item.unitPriceSypUnits !== null
      ? displaySypTotal([{ sypUnits: item.unitPriceSypUnits, count: item.quantity }])
      : null;
  const short = balance.status === 'ready' && total > balance.units && mode === 'buy';

  function body(): CreateOrder {
    return {
      productId: item.product.id,
      quantity: item.quantity,
      fields: item.savedPlayer.fields,
      expectedUnitPriceUsdUnits: unitPrice,
      whenBalanceShort: mode === 'reserve' ? 'reserve' : 'refuse',
      confirmPlayer: true,
    };
  }

  async function send() {
    const order = body();
    setSending({ status: 'sending' });
    const result = await sendAttempt(
      item.product.id,
      JSON.stringify(order),
      (key) => createOrder(order, key),
      freesKey,
    );
    if (result.ok) {
      router.push(
        result.data.stage === 'awaiting_balance'
          ? await trackFlight(gapDepositPath(result.data))
          : `/orders/${result.data.id}`,
      );
      return;
    }
    setSlide((count) => count + 1);
    switch (result.reason) {
      case 'PRICE_CHANGED': {
        const price = (result.details as { unitPriceUsdUnits?: unknown } | undefined)
          ?.unitPriceUsdUnits;
        if (typeof price === 'number') setUnitPrice(price);
        return setSending({
          status: 'failed',
          message:
            typeof price === 'number'
              ? t('purchase.priceChanged', { price: ltr(formatUsd(price)) })
              : errorText(result.reason),
          retry: false,
        });
      }
      case 'INSUFFICIENT_BALANCE':
        refresh();
        return setSending({ status: 'idle' });
      case 'RESERVATIONS_LIMIT_REACHED':
        setReserveBlocked(true);
        setMode('buy');
        return setSending({ status: 'failed', message: errorText(result.reason), retry: false });
      case 'PRODUCT_UNAVAILABLE':
        return setSending({ status: 'failed', message: t('purchase.packGone'), retry: false });
      case 'PURCHASE_LIMIT_EXCEEDED':
        return setSending({
          status: 'failed',
          message: purchaseRefusalText(result.reason, result.details),
          retry: false,
        });
      case 'UNAUTHORIZED':
        return router.push(`/sign-in?next=${encodeURIComponent('/')}`);
      case 'NETWORK':
      case 'UNKNOWN':
      case 'INTERNAL_ERROR':
        return setSending({ status: 'failed', message: errorText(result.reason), retry: true });
      default:
        // Anything the buy box explains better (terms, a player check): the game page.
        return setSending({ status: 'failed', message: errorText(result.reason), retry: false });
    }
  }

  const value = mainValue(item.savedPlayer, false);
  return (
    <Sheet open guardTyped={false} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="mx-auto max-w-lg bg-surface p-5 pb-8">
        <SheetTitle className="sr-only">
          {tq('row.sheetTitle', { label: item.savedPlayer.label })}
        </SheetTitle>
        <div className="flex flex-col gap-5">
          <div className="flex items-center gap-3">
            {item.game.cover ? (
              <CatalogPicture image={item.game.cover} sizes="56px" className="size-14 shrink-0" />
            ) : (
              <span className="flex size-14 shrink-0 items-center justify-center rounded-lg border border-border bg-muted">
                <Gamepad2Icon className="size-6 text-muted-foreground" aria-hidden="true" />
              </span>
            )}
            <div className="flex min-w-0 flex-col">
              <bdi className="font-bold">{item.game.nameAr}</bdi>
              <bdi className="text-sm text-muted-foreground">{item.product.nameAr}</bdi>
            </div>
          </div>
          <dl className="flex flex-col gap-3 rounded-lg border border-border p-4">
            <Line label={t('purchase.saved.label')}>
              <bdi className="text-lg font-bold">{item.savedPlayer.label}</bdi>
            </Line>
            {value && (
              <Line label={tq('row.playerId')}>
                <bdi dir="ltr" className="text-xl font-bold break-all">
                  {value}
                </bdi>
              </Line>
            )}
            {item.savedPlayer.playerName && (
              <Line label={t('purchase.saved.lastName')}>
                <bdi className="text-lg font-bold">{item.savedPlayer.playerName}</bdi>
              </Line>
            )}
            <Line label={t('purchase.quantity')}>
              <span className="tabular-nums">{item.quantity}</span>
            </Line>
            <Line label={t('purchase.total')}>
              <span className="flex flex-col items-end">
                <bdi dir="ltr" className="text-2xl font-bold tabular-nums">
                  {formatUsd(total)}
                </bdi>
                {totalSyp !== null && (
                  <span className="text-sm text-muted-foreground tabular-nums">
                    {t('catalog.price.syp', { amount: formatSyp(totalSyp) })}
                  </span>
                )}
              </span>
            </Line>
          </dl>
          {sending.status === 'failed' && <FormAlert>{sending.message}</FormAlert>}
          {frozen ? (
            <FormAlert>{errorText('ACCOUNT_FROZEN')}</FormAlert>
          ) : stopped ? (
            <FormAlert>{t('purchase.stopped')}</FormAlert>
          ) : balance.status === 'loading' ? (
            <Skeleton className="h-14 w-full" />
          ) : sending.status === 'sending' ? (
            <p
              role="status"
              className="flex h-14 items-center justify-center gap-2 rounded-lg border border-border text-md"
            >
              <LoaderCircleIcon className="size-5 animate-spin" aria-hidden="true" />
              {t(mode === 'reserve' ? 'purchase.reserving' : 'purchase.paying')}
            </p>
          ) : sending.status === 'failed' && sending.retry ? (
            <Button size="xl" onClick={() => void send()}>
              {t('purchase.retry')}
            </Button>
          ) : short && balance.status === 'ready' ? (
            <GapBlock
              balance={balance}
              gapUnits={depositGap({
                totalUsdUnits: total,
                balanceUsdUnits: balance.units,
                reservedUsdUnits: balance.reservedUnits,
              })}
              onReserve={reserveBlocked ? null : () => setMode('reserve')}
            />
          ) : (
            <SlideToPay
              key={`${slide}:${mode}`}
              label={t(mode === 'reserve' ? 'purchase.slideReserve' : 'purchase.slidePay')}
              valueText={(percent) => t('purchase.slideValue', { percent })}
              onConfirm={() => void send()}
            />
          )}
          <Button
            variant="ghost"
            size="xl"
            className="self-start"
            render={
              <Link
                href={`/games/${item.game.slug}?${new URLSearchParams({
                  pack: item.product.id,
                  player: item.savedPlayer.id,
                })}`}
              />
            }
          >
            {tq('row.openGame')}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-end">{children}</dd>
    </div>
  );
}
