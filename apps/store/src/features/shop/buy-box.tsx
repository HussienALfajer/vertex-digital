'use client';

import {
  displaySypTotal,
  formatSyp,
  formatUsd,
  orderTotal,
  type PlayerCheck,
  type ShopGame,
  type ShopProduct,
  type ShopPublic,
  type ShopPurchase,
  type StoreField,
  shopTopUpSyp,
} from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui/components/badge';
import { Button } from '@vertex-digital/ui/components/button';
import { Checkbox } from '@vertex-digital/ui/components/checkbox';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { SlideToPay } from '@vertex-digital/ui/components/slide-to-pay';
import { useFocusInvalid } from '@vertex-digital/ui/focus-invalid';
import {
  ArrowRightIcon,
  CircleCheckIcon,
  ClockIcon,
  LoaderCircleIcon,
  MessageCircleIcon,
  MinusIcon,
  PlusIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useCallback, useId, useRef, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { InvalidAlert } from '@/components/invalid-alert';
import { deliveryDetailText } from '@/features/catalog/delivery';
import { sendAttempt } from '@/features/purchase/attempt';
import { FieldInput } from '@/features/purchase/field-input';
import { checkFields, type FieldValues } from '@/features/purchase/fields';
import { freesKey } from '@/features/purchase/order-key';
import { usePlayerCheck } from '@/features/purchase/player-check';
import { purchaseRefusalText } from '@/features/purchase/refusals';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { ltr } from '@/lib/format';
import { t } from '@/lib/i18n';
import { ts } from './i18n';
import { balanceSyp, ShopMoney } from './money';
import { shopPath } from './paths';
import { checkShopPlayer, createShopOrder } from './requests';
import { useShopCustomer } from './session';
import { refreshShopWallet, useShopWallet } from './wallet';

/** A pack the shop sells: available, with its unit selling price. */
export type SellablePack = ShopProduct & { unitSellUsdUnits: number };

type Sending =
  | { status: 'idle' }
  | { status: 'sending' }
  | { status: 'failed'; message: string; retry: boolean };

/** The SYP of `count` units, as the pack shows it; null without a rate (edge case 9). */
const totalSyp = (product: SellablePack, count: number) =>
  product.unitSellSypUnits === null
    ? null
    : displaySypTotal([{ sypUnits: product.unitSellSypUnits, count }]);

/** A WhatsApp link to the merchant's number (E.164, as the receipts show it). */
const whatsappUrl = (phone: string) => `https://wa.me/${phone.replace(/\D/g, '')}`;

/**
 * A shop's buy box (S26 PR5–PR7): the game's fields, the player check (the shop customer's
 * quota) with its confirmation, the quantity, the total SYP first, then the slide. The request
 * carries the unit selling price shown; a new price is refused with `PRICE_CHANGED` and shown.
 * Paid only from the shop wallet: a short balance asks the shop to top it up («اطلب من المتجر شحن
 * رصيدك»). No reservation, cart, gift or saved IDs in a shop.
 */
export function ShopBuyBox({
  shop,
  game,
  fields,
  product,
}: {
  shop: ShopPublic;
  game: ShopGame['game'];
  fields: StoreField[];
  product: SellablePack;
}) {
  const router = useRouter();
  const customer = useShopCustomer(shop.slug);
  const signedIn = customer.status === 'signedIn';
  const frozen = signedIn && customer.profile.frozen;
  // SH6: a suspended shop sells nothing; a closed one sells to the balances it holds (SH7).
  const selling = shop.status !== 'suspended';
  const { state: wallet, refresh } = useShopWallet(shop.slug, signedIn);
  const [typed, setTyped] = useState<FieldValues>({});
  const [showErrors, setShowErrors] = useState<Set<string> | 'all'>(new Set());
  const [quantity, setQuantity] = useState(Math.max(1, product.minQuantity ?? 1));
  const [step, setStep] = useState<'details' | 'confirm'>('details');
  const [confirmed, setConfirmed] = useState(false);
  const [confirmMissing, setConfirmMissing] = useState(false);
  const [forceConfirm, setForceConfirm] = useState(false);
  const [priceOverride, setPriceOverride] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState<Sending>({ status: 'idle' });
  const [slide, setSlide] = useState(0);
  const lastBody = useRef<ShopPurchase | null>(null);
  const confirmId = useId();
  const { ref, focusInvalid } = useFocusInvalid<HTMLDivElement>();

  const newerPrice =
    priceOverride !== null && priceOverride !== product.unitSellUsdUnits ? priceOverride : null;
  const unitPrice = newerPrice ?? product.unitSellUsdUnits;
  const total = orderTotal(unitPrice, quantity);
  const sypTotal = newerPrice === null ? totalSyp(product, quantity) : null;
  const fieldsCheck = checkFields(fields, typed);
  const checkable = signedIn && !frozen && product.kind === 'direct' && product.playerCheck;
  const check = useCallback(
    (body: Parameters<typeof checkShopPlayer>[1]) => checkShopPlayer(shop.slug, body),
    [shop.slug],
  );
  const playerCheck = usePlayerCheck(
    product.id,
    fieldsCheck.ok ? fieldsCheck.values : null,
    checkable,
    check,
  );
  const checked = playerCheck.state.status === 'done' ? playerCheck.state.check : null;
  const balance = wallet.status === 'ready' ? wallet.wallet.balanceUsdUnits : null;
  const shortfall = balance !== null && total > balance ? total - balance : null;
  const refused = showErrors === 'all' && !fieldsCheck.ok;

  /** PV8: a checkable pack needs the confirmation unless its ID is known `valid`. */
  const needsConfirm = (result: PlayerCheck | null) =>
    forceConfirm ||
    (checkable &&
      result !== null &&
      result.result !== 'valid' &&
      result.result !== 'not_supported' &&
      result.result !== 'region_mismatch');

  function change(key: string, value: string) {
    setTyped((current) => ({ ...current, [key]: value }));
    setConfirmed(false);
    setConfirmMissing(false);
    setForceConfirm(false);
    setNotice(null);
  }

  const errorOf = (key: string) =>
    !fieldsCheck.ok && (showErrors === 'all' || showErrors.has(key))
      ? fieldsCheck.errors[key]
      : undefined;

  async function proceed() {
    setShowErrors('all');
    setNotice(null);
    if (!fieldsCheck.ok) return focusInvalid();
    const result = checkable ? (checked ?? (await playerCheck.run())) : null;
    if (result?.result === 'region_mismatch' && !forceConfirm) return;
    if (needsConfirm(result) && !confirmed) {
      setConfirmMissing(true);
      return focusInvalid();
    }
    setSending({ status: 'idle' });
    setSlide((count) => count + 1);
    setStep('confirm');
  }

  function body(): ShopPurchase | null {
    if (!fieldsCheck.ok) return null;
    return {
      productId: product.id,
      quantity,
      fields: fieldsCheck.values,
      expectedUnitSellUsdUnits: unitPrice,
      confirmPlayer: needsConfirm(checked) && confirmed,
    };
  }

  async function send(order: ShopPurchase) {
    lastBody.current = order;
    setSending({ status: 'sending' });
    const result = await sendAttempt(
      // The shop's id, never its slug: a slug change (SH3) must not lose an unsettled key.
      `shop:${shop.id}:${product.id}`,
      JSON.stringify(order),
      (key) => createShopOrder(shop.slug, order, key),
      freesKey,
    );
    if (result.ok) {
      void refreshShopWallet(shop.slug);
      router.push(shopPath(shop.slug, `/orders/${result.data.number}`));
      return;
    }
    refusal(result.reason, result.details);
  }

  function refusal(reason: Failure, details: unknown) {
    const again = () => setSlide((count) => count + 1);
    switch (reason) {
      case 'PRICE_CHANGED': {
        const price = (details as { unitPriceUsdUnits?: unknown } | undefined)?.unitPriceUsdUnits;
        if (typeof price === 'number') setPriceOverride(price);
        router.refresh();
        again();
        return setSending({
          status: 'failed',
          message:
            typeof price === 'number'
              ? ts('buy.priceChanged', { price: ltr(formatUsd(price)) })
              : errorText(reason),
          retry: false,
        });
      }
      case 'PRODUCT_UNAVAILABLE':
        router.refresh();
        return setSending({ status: 'failed', message: ts('buy.packGone'), retry: false });
      case 'INSUFFICIENT_BALANCE':
        refresh();
        setStep('details');
        setSending({ status: 'idle' });
        return setNotice(errorText(reason));
      case 'PLAYER_NOT_CONFIRMED':
        setForceConfirm(true);
        setConfirmed(false);
        setConfirmMissing(true);
        setStep('details');
        focusInvalid();
        return setSending({ status: 'idle' });
      case 'VALIDATION_FAILED':
        setShowErrors('all');
        setStep('details');
        setSending({ status: 'idle' });
        focusInvalid();
        return setNotice(errorText(reason));
      case 'UNAUTHORIZED':
        return router.push(signInHref());
      case 'NETWORK':
      case 'UNKNOWN':
      case 'INTERNAL_ERROR':
        return setSending({ status: 'failed', message: errorText(reason), retry: true });
      default:
        again();
        return setSending({
          status: 'failed',
          message: purchaseRefusalText(reason, details),
          retry: false,
        });
    }
  }

  const back = shopPath(
    shop.slug,
    `/games/${game.slug}?${new URLSearchParams({ pack: product.id })}`,
  );
  const signInHref = () =>
    `${shopPath(shop.slug, '/sign-in')}?${new URLSearchParams({ next: back })}`;

  const header = (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-xl font-bold break-words">
          <bdi>{product.nameAr}</bdi>
        </h2>
        <ShopMoney
          usd={unitPrice}
          syp={newerPrice === null ? product.unitSellSypUnits : null}
          size="sm"
        />
      </div>
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <ClockIcon className="size-4 shrink-0" aria-hidden="true" />
        {deliveryDetailText(product.deliveryStats)}
      </p>
    </div>
  );

  if (step === 'confirm') {
    const order = body();
    const name = checked?.result === 'valid' ? checked.playerName : null;
    return (
      <div className="flex flex-col gap-5">
        {header}
        <dl className="flex flex-col gap-3 rounded-lg border border-border p-4">
          {fields
            .filter((field) => fieldsCheck.ok && fieldsCheck.values[field.key])
            .map((field) => (
              <Row key={field.key} label={field.labelAr}>
                <bdi dir="ltr" className="text-xl font-bold break-all">
                  {shownValue(field, fieldsCheck.ok ? (fieldsCheck.values[field.key] ?? '') : '')}
                </bdi>
              </Row>
            ))}
          {name && (
            <Row label={t('purchase.playerName')}>
              <bdi className="text-lg font-bold">{name}</bdi>
            </Row>
          )}
          <Row label={t('purchase.quantity')}>
            <span className="tabular-nums">{quantity}</span>
          </Row>
          <Row label={ts('buy.total')}>
            <ShopMoney usd={total} syp={sypTotal} />
          </Row>
        </dl>
        {sending.status === 'failed' && <FormAlert>{sending.message}</FormAlert>}
        {sending.status === 'sending' ? (
          <p
            role="status"
            className="flex h-14 items-center justify-center gap-2 rounded-lg border border-border text-md"
          >
            <LoaderCircleIcon className="size-5 animate-spin" aria-hidden="true" />
            {ts('buy.paying')}
          </p>
        ) : sending.status === 'failed' && sending.retry && lastBody.current ? (
          <Button size="xl" onClick={() => lastBody.current && void send(lastBody.current)}>
            {ts('buy.retry')}
          </Button>
        ) : (
          order && (
            <SlideToPay
              key={slide}
              label={ts('buy.slide')}
              valueText={(percent) => t('purchase.slideValue', { percent })}
              disabled={frozen || !selling}
              autoFocus
              onConfirm={() => void send(order)}
            />
          )
        )}
        <Button
          variant="ghost"
          size="xl"
          className="self-start"
          disabled={sending.status === 'sending'}
          onClick={() => {
            setStep('details');
            setSending({ status: 'idle' });
          }}
        >
          <ArrowRightIcon className="ltr:-scale-x-100" aria-hidden="true" />
          {ts('buy.back')}
        </Button>
      </div>
    );
  }

  return (
    <div ref={ref} className="flex flex-col gap-5">
      {header}
      {product.kind === 'code' && product.redemptionAr && (
        <p className="text-sm whitespace-pre-line text-muted-foreground">{product.redemptionAr}</p>
      )}
      {fields.length > 0 && (
        <div className="flex flex-col gap-4">
          {fields.map((field) => (
            <FieldInput
              key={field.key}
              field={field}
              value={typed[field.key] ?? ''}
              error={errorOf(field.key)}
              onChange={(value) => change(field.key, value)}
              onBlur={() => {
                setShowErrors((current) =>
                  current === 'all' ? current : new Set(current).add(field.key),
                );
                if (checkable) void playerCheck.run();
              }}
            />
          ))}
        </div>
      )}
      {(checkable || forceConfirm) && (
        <div className="flex min-h-8 flex-col justify-center">
          <CheckResult state={playerCheck.state.status} check={checked} forced={forceConfirm} />
        </div>
      )}
      {needsConfirm(checked) && (
        <label
          htmlFor={confirmId}
          className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-border px-3"
        >
          <Checkbox
            id={confirmId}
            checked={confirmed}
            aria-invalid={confirmMissing && !confirmed}
            onCheckedChange={(next) => {
              setConfirmed(next);
              setConfirmMissing(false);
            }}
          />
          <span className="text-base">{t('purchase.confirmPlayer')}</span>
        </label>
      )}
      {confirmMissing && !confirmed && needsConfirm(checked) && (
        <FormAlert>{t('purchase.confirmPlayerMissing')}</FormAlert>
      )}
      {product.maxQuantity > 1 && (
        <Stepper
          value={quantity}
          min={Math.max(1, product.minQuantity ?? 1)}
          max={product.maxQuantity}
          onChange={setQuantity}
        />
      )}
      <div className="flex items-baseline justify-between gap-3 border-t border-border pt-4">
        <span className="text-base">{ts('buy.total')}</span>
        <ShopMoney usd={total} syp={sypTotal} />
      </div>
      {notice && <FormAlert>{notice}</FormAlert>}
      <InvalidAlert show={refused && !notice} />
      <Actions
        slug={shop.slug}
        whatsapp={shop.whatsapp}
        customer={customer.status}
        frozen={frozen}
        selling={selling}
        wallet={wallet}
        total={total}
        shortfall={shortfall}
        signInHref={signInHref()}
        onRetryBalance={refresh}
        onProceed={() => void proceed()}
      />
    </div>
  );
}

function Actions({
  slug,
  whatsapp,
  customer,
  frozen,
  selling,
  wallet,
  total,
  shortfall,
  signInHref,
  onRetryBalance,
  onProceed,
}: {
  slug: string;
  whatsapp: string | null;
  customer: ReturnType<typeof useShopCustomer>['status'];
  frozen: boolean;
  selling: boolean;
  wallet: ReturnType<typeof useShopWallet>['state'];
  total: number;
  shortfall: number | null;
  signInHref: string;
  onRetryBalance: () => void;
  onProceed: () => void;
}) {
  if (customer === 'loading') return <Skeleton className="h-11 w-full" />;
  if (customer !== 'signedIn') {
    return (
      <Button size="xl" render={<Link href={signInHref} prefetch={false} />}>
        {ts('buy.signIn')}
      </Button>
    );
  }
  if (frozen) return <FormAlert>{ts('buy.frozen')}</FormAlert>;
  if (!selling) return <FormAlert>{ts('buy.suspended')}</FormAlert>;
  if (wallet.status === 'loading') return <Skeleton className="h-24 w-full" />;
  if (wallet.status === 'failed') {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="text-muted-foreground">{ts('buy.balanceFailed')}</span>
        <Button variant="outline" size="xl" onClick={onRetryBalance}>
          {ts('buy.retry')}
        </Button>
      </div>
    );
  }
  const { balanceUsdUnits, rate } = wallet.wallet;
  if (shortfall !== null) {
    // An amount owed: rounded up, so the merchant's transfer of it covers the gap (WL2).
    const gapSyp = rate === null ? null : shopTopUpSyp(shortfall, rate);
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
        <p className="font-bold">{ts('buy.gapTitle')}</p>
        <p className="text-sm text-muted-foreground">
          {ts('buy.gapBody', {
            amount: ltr(
              gapSyp === null
                ? formatUsd(shortfall)
                : ts('balance.syp', { amount: formatSyp(gapSyp) }),
            ),
          })}
        </p>
        {whatsapp && (
          <Button
            variant="outline"
            size="xl"
            render={<a href={whatsappUrl(whatsapp)} target="_blank" rel="noopener noreferrer" />}
          >
            <MessageCircleIcon aria-hidden="true" />
            {ts('buy.gapWhatsapp')}
          </Button>
        )}
        <Link
          href={shopPath(slug, '/wallet')}
          prefetch={false}
          className="text-sm font-medium underline underline-offset-4"
        >
          {ts('nav.wallet')}
        </Link>
      </div>
    );
  }
  const after = balanceUsdUnits - total;
  const afterSyp = balanceSyp(after, rate);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {ts('buy.balanceAfter', {
          amount: ltr(
            afterSyp === null
              ? formatUsd(after)
              : ts('balance.syp', { amount: formatSyp(afterSyp) }),
          ),
        })}
      </p>
      <Button size="xl" onClick={onProceed}>
        {ts('buy.continue')}
      </Button>
    </div>
  );
}

/** PV7: what the customer sees of the player check. */
function CheckResult({
  state,
  check,
  forced,
}: {
  state: 'idle' | 'checking' | 'done';
  check: PlayerCheck | null;
  forced: boolean;
}) {
  if (state === 'checking') {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircleIcon className="size-4 animate-spin" aria-hidden="true" />
        {t('purchase.checking')}
      </p>
    );
  }
  if (check?.result === 'valid' && !forced) {
    return (
      <Badge tone="success" className="h-auto min-h-8 px-3 py-1 text-sm whitespace-normal">
        <CircleCheckIcon aria-hidden="true" />
        {check.playerName ? (
          <span>
            {t('purchase.playerNameIs')} <bdi>{check.playerName}</bdi>
          </span>
        ) : (
          t('purchase.playerValid')
        )}
      </Badge>
    );
  }
  if (check?.result === 'region_mismatch' && !forced) {
    return <FormAlert>{t('purchase.regionMismatch', { region: check.region })}</FormAlert>;
  }
  if (check?.result === 'invalid' && !forced) {
    return <FormAlert tone="warning">{t('purchase.playerInvalid')}</FormAlert>;
  }
  if (forced || check?.result === 'unavailable') {
    return <FormAlert tone="warning">{t('purchase.playerUnavailable')}</FormAlert>;
  }
  return null;
}

function Stepper({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-base">{t('purchase.quantity')}</span>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="xl"
          className="w-11 px-0"
          aria-label={t('purchase.less')}
          disabled={value <= min}
          onClick={() => onChange(value - 1)}
        >
          <MinusIcon />
        </Button>
        <output aria-live="polite" className="w-8 text-center text-lg font-bold tabular-nums">
          {value}
        </output>
        <Button
          variant="outline"
          size="xl"
          className="w-11 px-0"
          aria-label={t('purchase.more')}
          disabled={value >= max}
          onClick={() => onChange(value + 1)}
        >
          <PlusIcon />
        </Button>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function shownValue(field: StoreField, value: string): string {
  return field.options?.find((option) => option.value === value)?.labelAr ?? value;
}
