'use client';

import {
  type CreateOrder,
  displaySypTotal,
  formatSyp,
  formatUsd,
  orderTotal,
  type PlayerCheck,
  RESERVATION_HOURS,
  type StoreField,
  type StoreGame,
  type StoreProduct,
} from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui/components/badge';
import { Button } from '@vertex-digital/ui/components/button';
import { Checkbox } from '@vertex-digital/ui/components/checkbox';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { SlideToPay } from '@vertex-digital/ui/components/slide-to-pay';
import {
  ArrowRightIcon,
  CircleCheckIcon,
  ClockIcon,
  LoaderCircleIcon,
  MinusIcon,
  PlusIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { savePendingEmail } from '@/features/auth/pending-email';
import { deliveryDetailText } from '@/features/catalog/delivery';
import { centsParam } from '@/features/deposits/amounts';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { ltr } from '@/lib/format';
import { t } from '@/lib/i18n';
import { attemptKey, clearAttempt } from './attempt';
import { useBalance, usePurchasesStopped } from './customer';
import { clearDraft, readDraft, saveDraft } from './draft';
import { FieldInput } from './field-input';
import { checkFields, type FieldValues } from './fields';
import { IdGuideButton } from './id-guide';
import { usePlayerCheck } from './player-check';
import { createOrder } from './requests';
import type { Customer } from './session';

type Mode = 'buy' | 'reserve';

/**
 * The purchase's refusals decided after the API looked the key up and before anything is written
 * (rules O1–O6, PV8, RS2): no order holds the key, so the same body may go with a new one.
 * Anything else keeps the key, including a rate limit or a lost session: those are answered before
 * the key is looked up, so the first request may still have paid.
 */
const REFUSED_BEFORE_PAYMENT: ReadonlySet<Failure> = new Set<Failure>([
  'PRICE_CHANGED',
  'PRODUCT_UNAVAILABLE',
  'INSUFFICIENT_BALANCE',
  'PLAYER_NOT_CONFIRMED',
  'VALIDATION_FAILED',
  'PURCHASES_STOPPED',
  'RESERVATIONS_LIMIT_REACHED',
  'IDEMPOTENCY_KEY_REUSED',
  'NOT_FOUND',
]);

type Sending =
  | { status: 'idle' }
  | { status: 'sending' }
  | { status: 'failed'; message: string; retry: boolean };

/**
 * The buy box (S09 rules BB1–BB8, PV7, RS1) for one available pack: the pack and its delivery
 * time, the game's fields with the ID guide, the quantity, the totals, the player check, and the
 * action the visitor can take (sign in, verify the email, buy, or reserve when the balance is
 * short); then the confirmation with slide-to-pay. The server decides everything again.
 */
export function BuyBox({
  game,
  fields,
  product,
  customer,
  initialQuantity = 1,
}: {
  game: StoreGame['game'];
  fields: StoreField[];
  product: StoreProduct & { priceUsdUnits: number };
  customer: Customer;
  initialQuantity?: number;
}) {
  const router = useRouter();
  const signedIn = customer.status === 'signedIn' && customer.verified;
  const { balance, refresh: refreshBalance } = useBalance(signedIn);
  const stopped = usePurchasesStopped();
  const [typed, setTyped] = useState<FieldValues>({});
  const [showErrors, setShowErrors] = useState<Set<string> | 'all'>(new Set());
  const [quantity, setQuantity] = useState(Math.min(initialQuantity, product.maxQuantity));
  const [step, setStep] = useState<'details' | 'confirm'>('details');
  const [mode, setMode] = useState<Mode>('buy');
  const [confirmed, setConfirmed] = useState(false);
  const [confirmMissing, setConfirmMissing] = useState(false);
  const [forceConfirm, setForceConfirm] = useState(false);
  const [priceOverride, setPriceOverride] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState<Sending>({ status: 'idle' });
  const [slide, setSlide] = useState(0);
  const lastBody = useRef<CreateOrder | null>(null);
  const confirmId = useId();

  // Rule BB3: the fields typed before signing in come back with the same pack.
  useEffect(() => {
    const draft = readDraft(game.slug, product.id);
    if (!draft) return;
    setTyped(draft.fields);
    setQuantity(Math.min(Math.max(1, draft.quantity), product.maxQuantity));
  }, [game.slug, product.id, product.maxQuantity]);

  const unitPrice = priceOverride ?? product.priceUsdUnits;
  const total = orderTotal(unitPrice, quantity);
  const totalSyp =
    priceOverride === null && product.priceSypUnits !== null
      ? displaySypTotal([{ sypUnits: product.priceSypUnits, count: quantity }])
      : null;
  const fieldsCheck = checkFields(fields, typed);
  const checkable = signedIn && product.kind === 'direct' && product.playerCheck;
  const playerCheck = usePlayerCheck(
    product.id,
    fieldsCheck.ok ? fieldsCheck.values : null,
    checkable,
  );
  const check = playerCheck.state.status === 'done' ? playerCheck.state.check : null;
  const shortfall =
    balance.status === 'ready' && total > balance.units ? total - balance.units : null;

  /** Rule PV8: a checkable pack needs the confirmation unless its id is known `valid`. */
  const needsConfirm = (result: PlayerCheck | null) =>
    forceConfirm ||
    (checkable &&
      result !== null &&
      result.result !== 'valid' &&
      result.result !== 'not_supported');

  function change(key: string, value: string) {
    setTyped((current) => ({ ...current, [key]: value }));
    setConfirmed(false);
    setConfirmMissing(false);
    setForceConfirm(false);
    setNotice(null);
  }

  function reveal(key: string) {
    setShowErrors((current) => (current === 'all' ? current : new Set(current).add(key)));
  }

  const errorOf = (key: string) =>
    !fieldsCheck.ok && (showErrors === 'all' || showErrors.has(key))
      ? fieldsCheck.errors[key]
      : undefined;

  function signIn() {
    saveDraft({ gameSlug: game.slug, packId: product.id, quantity, fields: typed });
    const back = `/games/${game.slug}?pack=${product.id}`;
    router.push(`/sign-in?next=${encodeURIComponent(back)}`);
  }

  /**
   * "متابعة" or the reservation: the fields must pass (BB2), and a checkable pack waits for its
   * check (the one in flight, or one started now: pressing the button blurs the field first).
   */
  async function proceed(next: Mode) {
    setShowErrors('all');
    setNotice(null);
    if (!fieldsCheck.ok) return;
    const result = checkable ? (check ?? (await playerCheck.run())) : null;
    if (needsConfirm(result) && !confirmed) {
      setConfirmMissing(true);
      return;
    }
    setMode(next);
    setSending({ status: 'idle' });
    setSlide((count) => count + 1);
    setStep('confirm');
  }

  async function send(body: CreateOrder) {
    const sent = JSON.stringify(body);
    // One `Idempotency-Key` per request body, kept in session storage: a retry of the same body
    // after a lost answer gets the first order back (rule BB6), even after the box was reopened.
    const key = attemptKey(product.id, sent);
    lastBody.current = body;
    setSending({ status: 'sending' });
    const result = await createOrder(body, key);
    if (result.ok) {
      clearAttempt(product.id);
      clearDraft();
      router.push(`/orders/${result.data.id}`);
      return;
    }
    // Only a refusal known to come before the commit frees the key; any other answer (a lost
    // one, a server error) may follow a paid order, so its retry must replay that order.
    if (REFUSED_BEFORE_PAYMENT.has(result.reason)) clearAttempt(product.id);
    refused(result.reason, result.details);
  }

  function refused(reason: Failure, details: unknown) {
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
              ? t('purchase.priceChanged', { price: ltr(formatUsd(price)) })
              : errorText(reason),
          retry: false,
        });
      }
      case 'PRODUCT_UNAVAILABLE':
        router.refresh();
        return setSending({ status: 'failed', message: t('purchase.packGone'), retry: false });
      case 'INSUFFICIENT_BALANCE':
        refreshBalance();
        setStep('details');
        setSending({ status: 'idle' });
        return setNotice(errorText(reason));
      case 'PLAYER_NOT_CONFIRMED':
        // The server can check this pack though the cached page said not (rule PV8): ask anyway.
        router.refresh();
        setForceConfirm(true);
        setConfirmed(false);
        setConfirmMissing(true);
        setStep('details');
        return setSending({ status: 'idle' });
      case 'VALIDATION_FAILED':
        setShowErrors('all');
        setStep('details');
        setSending({ status: 'idle' });
        return setNotice(errorText(reason));
      case 'UNAUTHORIZED':
        return signIn();
      case 'NETWORK':
      case 'UNKNOWN':
      case 'INTERNAL_ERROR':
        return setSending({ status: 'failed', message: errorText(reason), retry: true });
      default:
        again();
        return setSending({ status: 'failed', message: errorText(reason), retry: false });
    }
  }

  function body(): CreateOrder | null {
    if (!fieldsCheck.ok) return null;
    return {
      productId: product.id,
      quantity,
      fields: fieldsCheck.values,
      expectedUnitPriceUsdUnits: unitPrice,
      whenBalanceShort: mode === 'reserve' ? 'reserve' : 'refuse',
      confirmPlayer: needsConfirm(check) && confirmed,
    };
  }

  const header = (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-xl font-bold break-words">
          <bdi>{product.nameAr}</bdi>
        </h2>
        <div className="flex shrink-0 flex-col items-end">
          <bdi dir="ltr" className="text-2xl font-bold tabular-nums">
            {formatUsd(unitPrice)}
          </bdi>
          {priceOverride === null && product.priceSypUnits !== null && (
            <span className="text-sm text-muted-foreground tabular-nums">
              {t('catalog.price.syp', { amount: formatSyp(product.priceSypUnits) })}
            </span>
          )}
        </div>
      </div>
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <ClockIcon className="size-4 shrink-0" aria-hidden="true" />
        {deliveryDetailText(product.deliveryStats)}
      </p>
    </div>
  );

  if (step === 'confirm') {
    const order = body();
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
          {check?.result === 'valid' && check.playerName && (
            <Row label={t('purchase.playerName')}>
              <bdi className="text-lg font-bold">{check.playerName}</bdi>
            </Row>
          )}
          <Row label={t('purchase.quantity')}>
            <span className="tabular-nums">{quantity}</span>
          </Row>
          <Row label={t('purchase.total')}>
            <bdi dir="ltr" className="text-2xl font-bold tabular-nums">
              {formatUsd(total)}
            </bdi>
          </Row>
          {mode === 'buy' && balance.status === 'ready' && total <= balance.units && (
            <Row label={t('purchase.balanceAfter')}>
              <bdi dir="ltr" className="tabular-nums">
                {formatUsd(balance.units - total)}
              </bdi>
            </Row>
          )}
        </dl>
        {mode === 'reserve' && (
          <p className="text-sm text-muted-foreground">
            {t('purchase.reserveNote', { hours: RESERVATION_HOURS })}
          </p>
        )}
        {sending.status === 'failed' && <FormAlert>{sending.message}</FormAlert>}
        {sending.status === 'sending' ? (
          <p
            role="status"
            className="flex h-14 items-center justify-center gap-2 rounded-lg border border-border text-md"
          >
            <LoaderCircleIcon className="size-5 animate-spin" aria-hidden="true" />
            {t(mode === 'reserve' ? 'purchase.reserving' : 'purchase.paying')}
          </p>
        ) : sending.status === 'failed' && sending.retry && lastBody.current ? (
          <Button size="xl" onClick={() => lastBody.current && void send(lastBody.current)}>
            {t('purchase.retry')}
          </Button>
        ) : (
          order && (
            <SlideToPay
              key={slide}
              label={t(mode === 'reserve' ? 'purchase.slideReserve' : 'purchase.slidePay')}
              valueText={(percent) => t('purchase.slideValue', { percent })}
              disabled={stopped}
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
          <ArrowRightIcon className="ltr:rotate-180" aria-hidden="true" />
          {t('purchase.back')}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {header}
      {product.kind === 'code' && (product.regionAr || product.redemptionAr) && (
        <div className="flex flex-col gap-1 text-sm">
          {product.regionAr && (
            <p>
              <span className="text-muted-foreground">{t('purchase.region')} </span>
              {product.regionAr}
            </p>
          )}
          {product.redemptionAr && (
            <p className="whitespace-pre-line text-muted-foreground">{product.redemptionAr}</p>
          )}
        </div>
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
                reveal(field.key);
                if (checkable) void playerCheck.run();
              }}
            />
          ))}
          {game.idGuide && <IdGuideButton image={game.idGuide} gameName={game.nameAr} />}
        </div>
      )}
      {(checkable || forceConfirm) && (
        // A fixed slot: the check starts when a field loses focus, often by a press on "متابعة",
        // and its status must not move that button between the press and the release.
        <div className="flex min-h-8 flex-col justify-center">
          <CheckResult state={playerCheck.state.status} check={check} forced={forceConfirm} />
        </div>
      )}
      {needsConfirm(check) && (
        <label
          htmlFor={confirmId}
          className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-border px-3"
        >
          <Checkbox
            id={confirmId}
            checked={confirmed}
            aria-invalid={confirmMissing && !confirmed}
            onCheckedChange={(checked) => {
              setConfirmed(checked);
              setConfirmMissing(false);
            }}
          />
          <span className="text-base">{t('purchase.confirmPlayer')}</span>
        </label>
      )}
      {confirmMissing && !confirmed && needsConfirm(check) && (
        <FormAlert>{t('purchase.confirmPlayerMissing')}</FormAlert>
      )}
      {product.maxQuantity > 1 && (
        <Stepper value={quantity} max={product.maxQuantity} onChange={setQuantity} />
      )}
      <div className="flex flex-col gap-1 border-t border-border pt-4">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-base">{t('purchase.total')}</span>
          <bdi dir="ltr" className="text-2xl font-bold tabular-nums">
            {formatUsd(total)}
          </bdi>
        </div>
        {totalSyp !== null && (
          <span className="text-end text-sm text-muted-foreground tabular-nums">
            {t('catalog.price.syp', { amount: formatSyp(totalSyp) })}
          </span>
        )}
      </div>
      {notice && <FormAlert>{notice}</FormAlert>}
      <Actions
        customer={customer}
        stopped={stopped}
        balance={balance}
        total={total}
        shortfall={shortfall}
        orderBack={`/games/${game.slug}?pack=${product.id}`}
        onSignIn={signIn}
        onProceed={(next) => void proceed(next)}
      />
    </div>
  );
}

/** What the customer can do now (rules BB3, BB4, BB7). */
function Actions({
  customer,
  stopped,
  balance,
  total,
  shortfall,
  orderBack,
  onSignIn,
  onProceed,
}: {
  customer: Customer;
  stopped: boolean;
  balance: ReturnType<typeof useBalance>['balance'];
  total: number;
  shortfall: number | null;
  orderBack: string;
  onSignIn: () => void;
  onProceed: (mode: Mode) => void;
}) {
  if (customer.status === 'loading') return <Skeleton className="h-11 w-full" />;
  if (customer.status === 'signedOut') {
    return (
      <Button size="xl" onClick={onSignIn}>
        {t('purchase.signIn')}
      </Button>
    );
  }
  if (!customer.verified) {
    return (
      <Button
        size="xl"
        render={
          <Link
            href="/verify-email"
            onClick={() => savePendingEmail({ email: customer.email, next: orderBack })}
          />
        }
      >
        {t('purchase.verify')}
      </Button>
    );
  }
  if (stopped) return <FormAlert>{t('purchase.stopped')}</FormAlert>;
  if (balance.status === 'loading') return <Skeleton className="h-24 w-full" />;
  if (shortfall !== null && balance.status === 'ready') {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-base">
          {t('purchase.shortfall', {
            balance: ltr(formatUsd(balance.units)),
            missing: ltr(formatUsd(shortfall)),
          })}
        </p>
        <Button size="xl" onClick={() => onProceed('reserve')}>
          {t('purchase.reserve')}
        </Button>
        <Button
          variant="outline"
          size="xl"
          render={<Link href={`/wallet/deposit?amount=${centsParam(shortfall)}`} />}
        >
          {t('purchase.deposit')}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {balance.status === 'ready' && (
        <p className="text-sm text-muted-foreground">
          {t('purchase.balanceAfterLine', { balance: ltr(formatUsd(balance.units - total)) })}
        </p>
      )}
      <Button size="xl" onClick={() => onProceed('buy')}>
        {t('purchase.continue')}
      </Button>
    </div>
  );
}

/** Rule PV7, what the customer sees of the player check. */
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
  max,
  onChange,
}: {
  value: number;
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
          disabled={value <= 1}
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

/** A select shows its option's label; anything else its value. */
function shownValue(field: StoreField, value: string): string {
  return field.options?.find((option) => option.value === value)?.labelAr ?? value;
}
