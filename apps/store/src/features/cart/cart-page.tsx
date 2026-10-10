'use client';

import {
  type CheckoutLineRefusal,
  type CheckoutRequest,
  checkoutTotal,
  displaySypTotal,
  formatSyp,
  formatUsd,
  orderTotal,
  type SearchIndexProduct,
} from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui/components/badge';
import { Button } from '@vertex-digital/ui/components/button';
import { Card } from '@vertex-digital/ui/components/card';
import { Checkbox } from '@vertex-digital/ui/components/checkbox';
import { EmptyState } from '@vertex-digital/ui/components/empty-state';
import { IconTile } from '@vertex-digital/ui/components/icon-tile';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { SlideToPay } from '@vertex-digital/ui/components/slide-to-pay';
import {
  GiftIcon,
  LoaderCircleIcon,
  MinusIcon,
  PackageIcon,
  PlusIcon,
  ShoppingCartIcon,
  Trash2Icon,
  UserRoundCheckIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { savePendingEmail } from '@/features/auth/pending-email';
import { centsParam } from '@/features/deposits/amounts';
import { attemptKey, clearAttempt } from '@/features/purchase/attempt';
import { useBalance, usePurchasesStopped } from '@/features/purchase/customer';
import { useCustomer } from '@/features/purchase/session';
import { getSearchIndex } from '@/features/search/requests';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { ltr } from '@/lib/format';
import { t } from '@/lib/i18n';
import { type CartLine, clearCart, readCart, removeLine, updateLine } from './cart';
import { checkoutLine, lineRefusals, payCart } from './requests';
import { useCart } from './use-cart';

/** The attempt key's slot in session storage: one cart, one attempt at a time (rule CT5). */
const ATTEMPT = 'cart';

/**
 * The checkout's refusals decided before anything is written (rule CT5): no checkout holds the
 * key, so the changed cart may go with a new one. Anything else keeps the key: the first request
 * may have paid.
 */
const REFUSED_BEFORE_PAYMENT: ReadonlySet<Failure> = new Set<Failure>([
  'CHECKOUT_REFUSED',
  'INSUFFICIENT_BALANCE',
  'PURCHASES_STOPPED',
  'VALIDATION_FAILED',
  'IDEMPOTENCY_KEY_REUSED',
  'EMAIL_NOT_VERIFIED',
]);

type Prices =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; products: Map<string, SearchIndexProduct> };

type Sending =
  | { status: 'idle' }
  | { status: 'sending' }
  | { status: 'failed'; message: string; retry: boolean };

/** The search index's products by id (rule CT4): public, cached by the browser for 30 seconds. */
async function loadPrices(): Promise<Prices> {
  const index = await getSearchIndex();
  return index.ok
    ? { status: 'ready', products: new Map(index.data.products.map((item) => [item.id, item])) }
    : { status: 'failed' };
}

/** Today's price of a line, or null when its pack is not on sale now (rule CT4). */
function priceNow(prices: Prices, line: CartLine): number | null | undefined {
  if (prices.status !== 'ready') return undefined;
  const product = prices.products.get(line.productId);
  return product?.available && product.priceUsdUnits !== null ? product.priceUsdUnits : null;
}

/**
 * The cart (S10 rules CT4–CT6): the lines from the device at once, each price checked against the
 * search index (public and cached) and moved to today's, the totals and the balance after, then
 * one slide pays every line or none. A refused cart marks each refused line with its reason; a
 * paid one is cleared and its orders open live.
 */
export function CartPage() {
  const router = useRouter();
  const lines = useCart();
  const customer = useCustomer();
  const signedIn = customer.status === 'signedIn' && customer.verified;
  const { balance, refresh: refreshBalance } = useBalance(signedIn);
  const stopped = usePurchasesStopped();
  const [prices, setPrices] = useState<Prices>({ status: 'loading' });
  const [movedFrom, setMovedFrom] = useState<Map<string, number>>(new Map());
  const [refusals, setRefusals] = useState<Map<string, CheckoutLineRefusal>>(new Map());
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState<Sending>({ status: 'idle' });
  const [slide, setSlide] = useState(0);
  const lastBody = useRef<CheckoutRequest | null>(null);

  const readPrices = useCallback(async () => {
    setPrices(await loadPrices());
  }, []);

  useEffect(() => {
    void readPrices();
  }, [readPrices]);

  /** A line moves to a new price; the old one stays shown struck through (CT4, CT6). */
  const movePrice = useCallback((line: CartLine, price: number) => {
    setMovedFrom((current) => new Map(current).set(line.id, line.expectedUnitPriceUsdUnits));
    updateLine(line.id, { expectedUnitPriceUsdUnits: price });
  }, []);

  // Rule CT4: a line whose price changed is updated to it, once per read of the prices. A price
  // the checkout answered later (PRICE_CHANGED) wins: the index may be 30 seconds old.
  useEffect(() => {
    if (prices.status !== 'ready') return;
    for (const line of readCart() ?? []) {
      const price = priceNow(prices, line);
      if (price && price !== line.expectedUnitPriceUsdUnits) movePrice(line, price);
    }
  }, [prices, movePrice]);

  if (lines === undefined) return <CartSkeleton />;
  if (lines === null) {
    return (
      <EmptyState
        icon={<ShoppingCartIcon />}
        title={t('cart.offTitle')}
        description={t('cart.offBody')}
      />
    );
  }
  if (lines.length === 0) {
    return (
      <EmptyState
        icon={<ShoppingCartIcon />}
        title={t('cart.emptyTitle')}
        description={t('cart.emptyBody')}
        action={
          <Button size="xl" render={<Link href="/" />}>
            {t('cart.browse')}
          </Button>
        }
      />
    );
  }

  // A line the checkout found unavailable stays so until removed, whatever the index says.
  const gone = (line: CartLine) =>
    priceNow(prices, line) === null || refusals.get(line.id)?.code === 'PRODUCT_UNAVAILABLE';
  const unavailable = lines.some(gone);
  // The totals count the lines that can be paid; an unavailable one must be removed first.
  const payable = lines.filter((line) => !gone(line));
  const total = checkoutTotal(
    payable.map((line) => ({
      unitPriceUsdUnits: line.expectedUnitPriceUsdUnits,
      quantity: line.quantity,
    })),
  );
  const syp =
    prices.status === 'ready'
      ? payable.map((line) => ({
          sypUnits: prices.products.get(line.productId)?.priceSypUnits ?? null,
          count: line.quantity,
        }))
      : [];
  const totalSyp =
    syp.length > 0 && syp.every((item) => item.sypUnits !== null)
      ? displaySypTotal(syp.map((item) => ({ sypUnits: item.sypUnits ?? 0, count: item.count })))
      : null;
  const shortfall =
    balance.status === 'ready' && total > balance.units ? total - balance.units : null;

  function changed() {
    setNotice(null);
    setSending({ status: 'idle' });
  }

  async function send(body: CheckoutRequest) {
    // One `Idempotency-Key` per body, kept in session storage: a retry after a lost answer gets
    // the first checkout back (rule CT5), even after a reload.
    const key = attemptKey(ATTEMPT, JSON.stringify(body));
    lastBody.current = body;
    setNotice(null);
    setSending({ status: 'sending' });
    const result = await payCart(body, key);
    if (result.ok) {
      clearAttempt(ATTEMPT);
      clearCart();
      router.push(`/orders?checkout=${encodeURIComponent(result.data.id)}`);
      return;
    }
    if (REFUSED_BEFORE_PAYMENT.has(result.reason)) clearAttempt(ATTEMPT);
    refused(result.reason, result.details, body);
  }

  /** Rule CT6: what each refusal asks of the customer. */
  function refused(reason: Failure, details: unknown, body: CheckoutRequest) {
    const again = () => setSlide((count) => count + 1);
    switch (reason) {
      case 'CHECKOUT_REFUSED': {
        const byIndex = lineRefusals(details);
        const marked = new Map<string, CheckoutLineRefusal>();
        (lines ?? []).forEach((line, index) => {
          const refusal = byIndex.get(index);
          if (!refusal || body.lines[index]?.productId !== line.productId) return;
          const price = refusal.details.unitPriceUsdUnits;
          // A new price is applied at once; the customer slides again (CT6).
          if (refusal.code === 'PRICE_CHANGED' && typeof price === 'number') movePrice(line, price);
          marked.set(line.id, refusal);
        });
        setRefusals(marked);
        again();
        setSending({ status: 'idle' });
        return setNotice(t('cart.refused'));
      }
      case 'INSUFFICIENT_BALANCE':
        refreshBalance();
        again();
        setSending({ status: 'idle' });
        return setNotice(errorText(reason));
      case 'UNAUTHORIZED':
        router.push(`/sign-in?next=${encodeURIComponent('/cart')}`);
        return;
      case 'NETWORK':
      case 'UNKNOWN':
      case 'INTERNAL_ERROR':
        return setSending({ status: 'failed', message: errorText(reason), retry: true });
      default:
        again();
        return setSending({ status: 'failed', message: errorText(reason), retry: false });
    }
  }

  const body: CheckoutRequest = { lines: lines.map(checkoutLine) };

  return (
    <div className="flex flex-col gap-6">
      <ul className="flex flex-col gap-3">
        {lines.map((line) => (
          <li key={line.id}>
            <LineCard
              line={line}
              price={gone(line) ? null : priceNow(prices, line)}
              movedFrom={movedFrom.get(line.id) ?? null}
              refusal={refusals.get(line.id) ?? null}
              onQuantity={(quantity) => {
                changed();
                updateLine(line.id, { quantity });
              }}
              onConfirm={() => {
                changed();
                updateLine(line.id, { confirmPlayer: true });
                setRefusals((current) => {
                  const next = new Map(current);
                  next.delete(line.id);
                  return next;
                });
              }}
              onRemove={() => {
                changed();
                removeLine(line.id);
              }}
            />
          </li>
        ))}
      </ul>

      <Card className="gap-4">
        <dl className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-base">{t('cart.total')}</dt>
            <dd className="flex flex-col items-end">
              <bdi dir="ltr" className="text-2xl font-bold tabular-nums">
                {formatUsd(total)}
              </bdi>
              {totalSyp !== null && (
                <span className="text-sm text-muted-foreground tabular-nums">
                  {t('catalog.price.syp', { amount: formatSyp(totalSyp) })}
                </span>
              )}
            </dd>
          </div>
          {balance.status === 'ready' && shortfall === null && (
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <dt className="text-muted-foreground">{t('cart.balanceAfter')}</dt>
              <dd>
                <bdi dir="ltr" className="tabular-nums">
                  {formatUsd(balance.units - total)}
                </bdi>
              </dd>
            </div>
          )}
        </dl>
        {notice && <FormAlert>{notice}</FormAlert>}
        {sending.status === 'failed' && <FormAlert>{sending.message}</FormAlert>}
        <Pay
          customer={customer}
          signedIn={signedIn}
          stopped={stopped}
          pricesReady={prices.status === 'ready'}
          pricesFailed={prices.status === 'failed'}
          unavailable={unavailable}
          balanceLoading={signedIn && balance.status === 'loading'}
          shortfall={shortfall}
          balanceUnits={balance.status === 'ready' ? balance.units : null}
          total={total}
          sending={sending}
          slide={slide}
          onRetryPrices={() => {
            setPrices({ status: 'loading' });
            void readPrices();
          }}
          onRetry={() => lastBody.current && void send(lastBody.current)}
          onPay={() => void send(body)}
        />
      </Card>
    </div>
  );
}

/** The action under the totals (CT4): sign in, verify, deposit, or the slide. */
function Pay({
  customer,
  signedIn,
  stopped,
  pricesReady,
  pricesFailed,
  unavailable,
  balanceLoading,
  shortfall,
  balanceUnits,
  total,
  sending,
  slide,
  onRetryPrices,
  onRetry,
  onPay,
}: {
  customer: ReturnType<typeof useCustomer>;
  signedIn: boolean;
  stopped: boolean;
  pricesReady: boolean;
  pricesFailed: boolean;
  unavailable: boolean;
  balanceLoading: boolean;
  shortfall: number | null;
  balanceUnits: number | null;
  total: number;
  sending: Sending;
  slide: number;
  onRetryPrices: () => void;
  onRetry: () => void;
  onPay: () => void;
}) {
  if (customer.status === 'loading') return <Skeleton className="h-14 w-full" />;
  if (customer.status === 'signedOut') {
    return (
      <Button size="xl" render={<Link href={`/sign-in?next=${encodeURIComponent('/cart')}`} />}>
        {t('cart.signIn')}
      </Button>
    );
  }
  if (!signedIn) {
    return (
      <Button
        size="xl"
        render={
          <Link
            href="/verify-email"
            onClick={() =>
              customer.status === 'signedIn' &&
              savePendingEmail({ email: customer.email, next: '/cart' })
            }
          />
        }
      >
        {t('cart.verify')}
      </Button>
    );
  }
  if (stopped) return <FormAlert>{t('purchase.stopped')}</FormAlert>;
  if (pricesFailed) {
    return (
      <div className="flex flex-col gap-3">
        <FormAlert>{t('cart.pricesFailed')}</FormAlert>
        <Button variant="outline" size="xl" onClick={onRetryPrices}>
          {t('cart.retry')}
        </Button>
      </div>
    );
  }
  if (!pricesReady || balanceLoading) return <Skeleton className="h-14 w-full" />;
  if (unavailable) return <FormAlert>{t('cart.removeUnavailable')}</FormAlert>;
  if (shortfall !== null && balanceUnits !== null) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-base">
          {t('cart.shortfall', {
            balance: ltr(formatUsd(balanceUnits)),
            missing: ltr(formatUsd(shortfall)),
          })}
        </p>
        <Button
          size="xl"
          render={<Link href={`/wallet/deposit?amount=${centsParam(shortfall)}`} />}
        >
          {t('cart.deposit')}
        </Button>
      </div>
    );
  }
  if (sending.status === 'sending') {
    return (
      <p
        role="status"
        className="flex h-14 items-center justify-center gap-2 rounded-lg border border-border text-md"
      >
        <LoaderCircleIcon className="size-5 animate-spin" aria-hidden="true" />
        {t('cart.paying')}
      </p>
    );
  }
  if (sending.status === 'failed' && sending.retry) {
    return (
      <Button size="xl" onClick={onRetry}>
        {t('cart.retry')}
      </Button>
    );
  }
  return (
    <SlideToPay
      key={slide}
      label={t('cart.slide', { total: ltr(formatUsd(total)) })}
      valueText={(percent) => t('purchase.slideValue', { percent })}
      onConfirm={onPay}
    />
  );
}

/**
 * One line (S10 screens): the cover, the game and pack, the quantity, the fields in full (the
 * customer's own device), the checked name or "أكّدت المعرّف بنفسك", the gift badge, the unit and
 * line price with the old one struck through after a change, and a refusal with what to do.
 */
function LineCard({
  line,
  price,
  movedFrom,
  refusal,
  onQuantity,
  onConfirm,
  onRemove,
}: {
  line: CartLine;
  /** Today's unit price; null when unavailable; undefined while checking. */
  price: number | null | undefined;
  movedFrom: number | null;
  refusal: CheckoutLineRefusal | null;
  onQuantity: (quantity: number) => void;
  onConfirm: () => void;
  onRemove: () => void;
}) {
  const confirmId = useId();
  const cover = line.display.cover;
  const name = line.playerCheck?.result === 'valid' ? line.playerCheck.playerName : null;
  return (
    <Card className={`gap-3 ${refusal || price === null ? 'border-status-warning' : ''}`}>
      <div className="flex items-start gap-3">
        {cover ? (
          // biome-ignore lint/performance/noImgElement: catalog images are stored re-encoded and served immutable by the API (S06).
          <img
            src={`${cover.url}?w=160`}
            alt=""
            width={cover.width}
            height={cover.height}
            className="size-12 shrink-0 rounded-md object-cover"
          />
        ) : (
          <IconTile tone="muted">
            <PackageIcon />
          </IconTile>
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="font-medium break-words">
            <bdi>{line.display.productNameAr}</bdi>
          </p>
          <p className="text-sm text-muted-foreground">{line.display.gameNameAr}</p>
          {line.gift && (
            <Badge tone="info" className="self-start">
              <GiftIcon aria-hidden="true" />
              {t('cart.gift')}
            </Badge>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-11 shrink-0"
          aria-label={t('cart.remove', { name: line.display.productNameAr })}
          onClick={onRemove}
        >
          <Trash2Icon />
        </Button>
      </div>
      {line.display.fields.length > 0 && (
        <dl className="flex flex-col gap-1 text-sm">
          {line.display.fields.map((field) => (
            <div key={field.key} className="flex justify-between gap-3">
              <dt className="text-muted-foreground">{field.labelAr}</dt>
              <dd>
                <bdi dir="ltr" className="font-medium break-all">
                  {field.value}
                </bdi>
              </dd>
            </div>
          ))}
        </dl>
      )}
      {name ? (
        <p className="flex items-center gap-2 text-sm">
          <UserRoundCheckIcon
            className="size-4 shrink-0 text-status-success-foreground"
            aria-hidden="true"
          />
          <bdi className="font-medium">{name}</bdi>
        </p>
      ) : (
        line.confirmPlayer && (
          <p className="text-sm text-muted-foreground">{t('cart.selfConfirmed')}</p>
        )
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {line.maxQuantity > 1 ? (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="xl"
              className="w-11 px-0"
              aria-label={t('purchase.less')}
              disabled={line.quantity <= 1}
              onClick={() => onQuantity(line.quantity - 1)}
            >
              <MinusIcon />
            </Button>
            <output aria-live="polite" className="w-8 text-center text-lg font-bold tabular-nums">
              {line.quantity}
            </output>
            <Button
              variant="outline"
              size="xl"
              className="w-11 px-0"
              aria-label={t('purchase.more')}
              disabled={line.quantity >= line.maxQuantity}
              onClick={() => onQuantity(line.quantity + 1)}
            >
              <PlusIcon />
            </Button>
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">
            {t('cart.quantity', { count: line.quantity })}
          </span>
        )}
        {price === undefined ? (
          <Skeleton className="h-10 w-24" />
        ) : price === null ? (
          <Badge tone="warning">{t('cart.unavailable')}</Badge>
        ) : (
          <div className="flex flex-col items-end">
            <span className="flex items-baseline gap-2">
              {movedFrom !== null && movedFrom !== line.expectedUnitPriceUsdUnits && (
                <del className="text-sm text-muted-foreground tabular-nums">
                  <bdi dir="ltr">{formatUsd(movedFrom)}</bdi>
                </del>
              )}
              <span className="text-sm tabular-nums">
                {t('cart.unit', { price: ltr(formatUsd(line.expectedUnitPriceUsdUnits)) })}
              </span>
            </span>
            <bdi dir="ltr" className="text-lg font-bold tabular-nums">
              {formatUsd(orderTotal(line.expectedUnitPriceUsdUnits, line.quantity))}
            </bdi>
          </div>
        )}
      </div>
      {refusal && (
        <Refusal line={line} refusal={refusal} confirmId={confirmId} onConfirm={onConfirm} />
      )}
    </Card>
  );
}

/** Rule CT6 on the refused line. */
function Refusal({
  line,
  refusal,
  confirmId,
  onConfirm,
}: {
  line: CartLine;
  refusal: CheckoutLineRefusal;
  confirmId: string;
  onConfirm: () => void;
}) {
  switch (refusal.code) {
    case 'PRICE_CHANGED':
      return <FormAlert tone="warning">{t('cart.refusals.PRICE_CHANGED')}</FormAlert>;
    case 'PRODUCT_UNAVAILABLE':
      return <FormAlert>{t('cart.refusals.PRODUCT_UNAVAILABLE')}</FormAlert>;
    case 'VALIDATION_FAILED':
      return (
        <div className="flex flex-col gap-2">
          <FormAlert>{t('cart.refusals.VALIDATION_FAILED')}</FormAlert>
          <Button
            variant="outline"
            size="xl"
            render={
              <Link
                href={`/games/${encodeURIComponent(line.gameSlug)}?${new URLSearchParams({
                  pack: line.productId,
                  line: line.id,
                })}`}
              />
            }
          >
            {t('cart.edit')}
          </Button>
        </div>
      );
    case 'PLAYER_NOT_CONFIRMED':
      return (
        <div className="flex flex-col gap-2">
          <FormAlert tone="warning">{t('cart.refusals.PLAYER_NOT_CONFIRMED')}</FormAlert>
          <label
            htmlFor={confirmId}
            className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-border px-3"
          >
            <Checkbox
              id={confirmId}
              checked={false}
              onCheckedChange={(checked) => checked && onConfirm()}
            />
            <span className="text-base">{t('purchase.confirmPlayer')}</span>
          </label>
        </div>
      );
  }
}

export function CartSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden="true">
      {[0, 1].map((row) => (
        <Skeleton key={row} className="h-40 w-full" />
      ))}
      <Skeleton className="h-32 w-full" />
    </div>
  );
}
