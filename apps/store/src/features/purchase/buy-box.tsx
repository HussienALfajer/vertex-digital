'use client';

import {
  type CreateOrder,
  canonicalFields,
  checkoutTotal,
  displaySypTotal,
  formatSyp,
  formatUsd,
  orderTotal,
  type PlayerCheck,
  RESERVATION_HOURS,
  SAVED_PLAYERS_MAX,
  SAVED_PLAYERS_PER_GAME,
  type SavedPlayer,
  type StoreField,
  type StoreGame,
  type StoreProduct,
  savedPlayerLabelSchema,
} from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui/components/badge';
import { Button } from '@vertex-digital/ui/components/button';
import { Checkbox } from '@vertex-digital/ui/components/checkbox';
import { Field, FieldError, FieldLabel } from '@vertex-digital/ui/components/field';
import { Input } from '@vertex-digital/ui/components/input';
import { Skeleton } from '@vertex-digital/ui/components/skeleton';
import { SlideToPay } from '@vertex-digital/ui/components/slide-to-pay';
import {
  ArrowRightIcon,
  CircleCheckIcon,
  ClockIcon,
  LoaderCircleIcon,
  MinusIcon,
  PlusIcon,
  ShoppingCartIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { FormAlert } from '@/components/form-alert';
import { savePendingEmail } from '@/features/auth/pending-email';
import {
  addToCart,
  type CartLine,
  type CartPlayerCheck,
  type NewCartLine,
  readCart,
  replaceLine,
} from '@/features/cart/cart';
import { useCart } from '@/features/cart/use-cart';
import { deliveryDetailText } from '@/features/catalog/delivery';
import { centsParam } from '@/features/deposits/amounts';
import { getOrder } from '@/features/orders/requests';
import { listSavedPlayers } from '@/features/players/requests';
import type { Failure } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { ltr } from '@/lib/format';
import { t } from '@/lib/i18n';
import { attemptKey, clearAttempt } from './attempt';
import { useBalance, usePurchasesStopped } from './customer';
import { clearDraft, readDraft, saveDraft } from './draft';
import { FieldInput } from './field-input';
import { checkFields, type FieldValues } from './fields';
import { GiftBox, type GiftDraft, giftErrors, giftOf, NO_GIFT } from './gift-box';
import { IdGuideButton } from './id-guide';
import { usePlayerCheck } from './player-check';
import { createOrder } from './requests';
import { SavedChips } from './saved-chips';
import type { Customer } from './session';

type Mode = 'buy' | 'reserve';

export type Buyable = StoreProduct & { priceUsdUnits: number };

/**
 * Why the buy box opened besides a pack being chosen (S10): a repeat of a delivered order (OT1),
 * a saved ID chosen in "معرّفاتي" (SP5), a cart line to edit (CT6), or the calculator's packs to
 * add together (CT3).
 */
export type BuyBoxIntent =
  | { kind: 'repeat'; orderId: string }
  | { kind: 'player'; savedId: string }
  | { kind: 'edit'; lineId: string }
  | { kind: 'bundle'; lines: { product: Buyable; count: number }[] };

/** The fields as the server hashes them: equal keys mean the same player ID. */
const fieldsKey = (values: Readonly<Record<string, string>>) =>
  JSON.stringify(canonicalFields(values));

type Saved = { status: 'loading' | 'failed' } | { status: 'ready'; items: SavedPlayer[] };

/** Rule SP3: the customer's saved IDs, all of them (the limits count every game, SP1). */
function useSavedPlayers(enabled: boolean): Saved {
  const [saved, setSaved] = useState<Saved>({ status: 'loading' });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void listSavedPlayers().then((result) => {
      if (live)
        setSaved(result.ok ? { status: 'ready', items: result.data.items } : { status: 'failed' });
    });
    return () => {
      live = false;
    };
  }, [enabled]);
  return saved;
}

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
 * The buy box (S09 rules BB1–BB8, PV7, RS1; S10 SP1–SP7, OT1, OT2, GF1, CT2, CT3) for one
 * available pack: the pack and its delivery time, the customer's saved IDs as chips, the game's
 * fields with the ID guide, saving the ID, the gift, the quantity, the totals, the player check,
 * and the actions the visitor can take (sign in, verify the email, buy, reserve when the balance
 * is short, add to the cart); then the confirmation with slide-to-pay. The server decides
 * everything again.
 */
export function BuyBox({
  game,
  fields,
  product,
  customer,
  initialQuantity = 1,
  intent,
}: {
  game: StoreGame['game'];
  fields: StoreField[];
  product: Buyable;
  customer: Customer;
  initialQuantity?: number;
  intent?: BuyBoxIntent;
}) {
  const router = useRouter();
  const signedIn = customer.status === 'signedIn' && customer.verified;
  // The cart line being edited, read once from the device (CT6's "عدّل البيانات").
  const [editing] = useState<CartLine | null>(() =>
    intent?.kind === 'edit'
      ? (readCart()?.find((line) => line.id === intent.lineId) ?? null)
      : null,
  );
  const bundle = intent?.kind === 'bundle' ? intent.lines : null;
  const { balance, refresh: refreshBalance } = useBalance(signedIn);
  const stopped = usePurchasesStopped();
  const cart = useCart();
  const saved = useSavedPlayers(signedIn && fields.length > 0);
  const [typed, setTyped] = useState<FieldValues>(editing?.fields ?? {});
  const [showErrors, setShowErrors] = useState<Set<string> | 'all'>(new Set());
  const [quantity, setQuantity] = useState(
    Math.min(editing?.quantity ?? initialQuantity, product.maxQuantity),
  );
  const [step, setStep] = useState<'details' | 'confirm'>('details');
  const [mode, setMode] = useState<Mode>('buy');
  const [confirmed, setConfirmed] = useState(false);
  const [confirmMissing, setConfirmMissing] = useState(false);
  const [forceConfirm, setForceConfirm] = useState(false);
  const [priceOverride, setPriceOverride] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState<Sending>({ status: 'idle' });
  const [slide, setSlide] = useState(0);
  // S10: the saved ID chosen, and the fields the customer already confirmed (a saved ID, a
  // delivered order's, a cart line's): unchanged, they need no new check or confirmation.
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [trusted, setTrusted] = useState<string | null>(
    editing?.confirmPlayer ? fieldsKey(editing.fields) : null,
  );
  const [save, setSave] = useState({
    on: !!editing?.savePlayer,
    label: editing?.savePlayer?.label ?? t('purchase.save.defaultLabel'),
  });
  const [gift, setGift] = useState<GiftDraft>(
    editing?.gift
      ? {
          on: true,
          senderName: editing.gift.senderName ?? '',
          message: editing.gift.message ?? '',
        }
      : NO_GIFT,
  );
  const [added, setAdded] = useState<'added' | 'full' | null>(null);
  const lastBody = useRef<CreateOrder | null>(null);
  const preselected = useRef(false);
  const confirmId = useId();
  const saveId = useId();

  // Rule BB3: the fields typed before signing in come back with the same pack.
  useEffect(() => {
    if (editing) return;
    const draft = readDraft(game.slug, product.id);
    if (!draft) return;
    setTyped(draft.fields);
    setQuantity(Math.min(Math.max(1, draft.quantity), product.maxQuantity));
  }, [editing, game.slug, product.id, product.maxQuantity]);

  const unitPrice = priceOverride ?? product.priceUsdUnits;
  const total = bundle
    ? checkoutTotal(
        bundle.map((line) => ({
          unitPriceUsdUnits: line.product.priceUsdUnits,
          quantity: line.count,
        })),
      )
    : orderTotal(unitPrice, quantity);
  const totalSyp = bundle
    ? bundle.every((line) => line.product.priceSypUnits !== null)
      ? displaySypTotal(
          bundle.map((line) => ({ sypUnits: line.product.priceSypUnits ?? 0, count: line.count })),
        )
      : null
    : priceOverride === null && product.priceSypUnits !== null
      ? displaySypTotal([{ sypUnits: product.priceSypUnits, count: quantity }])
      : null;
  const fieldsCheck = checkFields(fields, typed);
  const isTrusted = fieldsCheck.ok && trusted !== null && fieldsKey(fieldsCheck.values) === trusted;
  const checkable = signedIn && product.kind === 'direct' && product.playerCheck;
  const playerCheck = usePlayerCheck(
    product.id,
    fieldsCheck.ok ? fieldsCheck.values : null,
    checkable && !isTrusted,
  );
  const check = playerCheck.state.status === 'done' ? playerCheck.state.check : null;
  const shortfall =
    balance.status === 'ready' && total > balance.units ? total - balance.units : null;
  const gameSaved =
    saved.status === 'ready' ? saved.items.filter((item) => item.gameId === game.id) : [];
  const chosen = gameSaved.find((item) => item.id === chosenId) ?? null;
  const giftable = product.kind === 'direct' && !bundle;
  const giftProblems = giftable ? giftErrors(gift) : {};
  // Rule SP1: a direct pack with fields, under both limits, for an ID not saved yet.
  const canSave =
    signedIn &&
    product.kind === 'direct' &&
    fields.length > 0 &&
    !bundle &&
    saved.status === 'ready' &&
    gameSaved.length < SAVED_PLAYERS_PER_GAME &&
    saved.items.length < SAVED_PLAYERS_MAX &&
    !(
      fieldsCheck.ok &&
      gameSaved.some((item) => fieldsKey(item.fields) === fieldsKey(fieldsCheck.values))
    );
  const labelValid = savedPlayerLabelSchema.safeParse(save.label).success;
  const savePlayer = canSave && save.on && labelValid ? { label: save.label.trim() } : undefined;

  /** Rule PV8: a checkable pack needs the confirmation unless its id is known `valid`. */
  const needsConfirm = (result: PlayerCheck | null) =>
    forceConfirm ||
    (!isTrusted &&
      checkable &&
      result !== null &&
      result.result !== 'valid' &&
      result.result !== 'not_supported');

  function change(key: string, value: string) {
    setTyped((current) => ({ ...current, [key]: value }));
    setChosenId(null);
    setConfirmed(false);
    setConfirmMissing(false);
    setForceConfirm(false);
    setNotice(null);
    setAdded(null);
  }

  function reveal(key: string) {
    setShowErrors((current) => (current === 'all' ? current : new Set(current).add(key)));
  }

  const errorOf = (key: string) =>
    !fieldsCheck.ok && (showErrors === 'all' || showErrors.has(key))
      ? fieldsCheck.errors[key]
      : undefined;

  function openConfirm(next: Mode) {
    setMode(next);
    setSending({ status: 'idle' });
    setSlide((count) => count + 1);
    setStep('confirm');
  }

  /**
   * Rule SP3: a saved ID fills the fields; a complete one that the supplier never refused counts
   * as confirmed and opens the slide step at once (`jump`), a rejected one goes through the check
   * (SP6), an incomplete one shows what is missing (SP7).
   */
  function pick(player: SavedPlayer, jump: boolean) {
    const values: FieldValues = {};
    for (const field of fields) {
      const value = player.fields[field.key];
      if (value !== undefined) values[field.key] = value;
    }
    setTyped(values);
    setChosenId(player.id);
    setConfirmed(false);
    setConfirmMissing(false);
    setForceConfirm(false);
    setNotice(null);
    setAdded(null);
    const result = checkFields(fields, values);
    if (!result.ok || !player.complete) {
      setTrusted(null);
      setShowErrors('all');
      return;
    }
    if (player.rejected) return setTrusted(null);
    setTrusted(fieldsKey(result.values));
    if (jump && !editing && !stopped && shortfall === null) openConfirm('buy');
  }

  /** "معرّف جديد": empty fields to type another ID. */
  function typeNew() {
    setTyped({});
    setChosenId(null);
    setTrusted(null);
    setShowErrors(new Set());
    setConfirmed(false);
    setConfirmMissing(false);
    setNotice(null);
    setAdded(null);
  }

  // Rule SP5: "اشحن" in "معرّفاتي" opens the pack with the saved ID chosen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the saved IDs arrive.
  useEffect(() => {
    if (intent?.kind !== 'player' || preselected.current || saved.status !== 'ready') return;
    preselected.current = true;
    const player = gameSaved.find((item) => item.id === intent.savedId);
    if (player) pick(player, false);
  }, [saved.status]);

  // Rule OT1: "اشترِ مجدداً" fills the delivered order's fields and quantity and opens the slide
  // step at today's price; OT2: what no longer applies stays on the details with the reason.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, for the order in the URL.
  useEffect(() => {
    if (intent?.kind !== 'repeat') return;
    let live = true;
    void getOrder(intent.orderId).then((result) => {
      if (!live) return;
      // Only a delivered order's ID counts as confirmed (OT1, OT3): anything else is typed again.
      if (!result.ok || result.data.product.id !== product.id || !result.data.repeatable) {
        return setNotice(t('purchase.repeat.failed'));
      }
      const order = result.data;
      const values: FieldValues = {};
      for (const field of fields) {
        const value = order.fields.find((item) => item.key === field.key)?.value;
        if (value) values[field.key] = value;
      }
      setTyped(values);
      setQuantity(Math.min(order.quantity, product.maxQuantity));
      const checked = checkFields(fields, values);
      if (!checked.ok) {
        setShowErrors('all');
        return setNotice(t('purchase.repeat.fieldsChanged'));
      }
      setTrusted(fieldsKey(checked.values));
      if (order.quantity > product.maxQuantity) {
        return setNotice(t('purchase.repeat.quantityCapped', { max: product.maxQuantity }));
      }
      openConfirm('buy');
    });
    return () => {
      live = false;
    };
  }, []);

  function signIn() {
    saveDraft({ gameSlug: game.slug, packId: product.id, quantity, fields: typed });
    const back = `/games/${game.slug}?pack=${product.id}`;
    router.push(`/sign-in?next=${encodeURIComponent(back)}`);
  }

  /**
   * What must pass before paying, reserving or adding to the cart: the fields (BB2), the gift's
   * texts (GF3), the label (SP1), and the player check with its confirmation (PV7), waiting for
   * the check in flight or one started now (pressing the button blurs the field first).
   */
  async function ready(): Promise<{ result: PlayerCheck | null } | null> {
    setShowErrors('all');
    setNotice(null);
    setAdded(null);
    if (!fieldsCheck.ok || Object.keys(giftProblems).length > 0) return null;
    if (canSave && save.on && !labelValid) return null;
    const result = checkable && !isTrusted ? (check ?? (await playerCheck.run())) : null;
    if (needsConfirm(result) && !confirmed) {
      setConfirmMissing(true);
      return null;
    }
    return { result };
  }

  /** "متابعة" or the reservation. */
  async function proceed(next: Mode) {
    if (await ready()) openConfirm(next);
  }

  /** Rules CT2, CT3: the line (or the calculator's lines) into the cart, or the edited line back. */
  async function addLines() {
    const passed = await ready();
    if (!passed || !fieldsCheck.ok) return;
    const values = fieldsCheck.values;
    const { result } = passed;
    const confirmPlayer = isTrusted || (needsConfirm(result) && confirmed);
    const shown: CartPlayerCheck | null = result
      ? { result: result.result, playerName: result.result === 'valid' ? result.playerName : null }
      : isTrusted && chosen
        ? { result: 'valid', playerName: chosen.playerName }
        : (editing?.playerCheck ?? null);
    const line = (pack: Buyable, count: number, price: number): NewCartLine => ({
      productId: pack.id,
      gameSlug: game.slug,
      quantity: count,
      maxQuantity: pack.maxQuantity,
      fields: values,
      expectedUnitPriceUsdUnits: price,
      confirmPlayer,
      playerCheck: shown,
      display: {
        gameNameAr: game.nameAr,
        productNameAr: pack.nameAr,
        cover: game.cover,
        fields: fields
          .filter((field) => values[field.key])
          .map((field) => ({
            key: field.key,
            labelAr: field.labelAr,
            value: shownValue(field, values[field.key] ?? ''),
          })),
      },
    });
    const giftValue = giftable ? giftOf(gift) : undefined;
    const single: NewCartLine = {
      ...line(product, quantity, unitPrice),
      ...(savePlayer && { savePlayer }),
      ...(giftValue && { gift: giftValue }),
    };
    if (editing) {
      replaceLine(editing.id, single);
      router.push('/cart');
      return;
    }
    const outcome = addToCart(
      bundle
        ? bundle.map((item) => line(item.product, item.count, item.product.priceUsdUnits))
        : [single],
    );
    if (outcome.status !== 'off') setAdded(outcome.status);
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
    const giftValue = giftable ? giftOf(gift) : undefined;
    return {
      productId: product.id,
      quantity,
      fields: fieldsCheck.values,
      expectedUnitPriceUsdUnits: unitPrice,
      whenBalanceShort: mode === 'reserve' ? 'reserve' : 'refuse',
      // S10: a saved ID or a delivered order's ID counts as confirmed by the customer (SP3, OT1).
      confirmPlayer: isTrusted || (needsConfirm(check) && confirmed),
      ...(savePlayer && { savePlayer }),
      ...(giftValue && { gift: giftValue }),
    };
  }

  const header = (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-xl font-bold break-words">
          <bdi>{bundle ? t('purchase.bundle.title') : product.nameAr}</bdi>
        </h2>
        {!bundle && (
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
        )}
      </div>
      {bundle ? (
        <ul className="flex flex-col gap-1 text-sm">
          {bundle.map((line) => (
            <li key={line.product.id} className="flex justify-between gap-3">
              <span>
                <bdi>{line.product.nameAr}</bdi> × {line.count}
              </span>
              <bdi dir="ltr" className="tabular-nums text-muted-foreground">
                {formatUsd(orderTotal(line.product.priceUsdUnits, line.count))}
              </bdi>
            </li>
          ))}
        </ul>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <ClockIcon className="size-4 shrink-0" aria-hidden="true" />
          {deliveryDetailText(product.deliveryStats)}
        </p>
      )}
    </div>
  );

  if (step === 'confirm') {
    const order = body();
    const giftValue = giftable ? giftOf(gift) : undefined;
    const lastName = check?.result === 'valid' ? check.playerName : null;
    return (
      <div className="flex flex-col gap-5">
        {header}
        <dl className="flex flex-col gap-3 rounded-lg border border-border p-4">
          {isTrusted && chosen && (
            <Row label={t('purchase.saved.label')}>
              <bdi className="text-lg font-bold">{chosen.label}</bdi>
            </Row>
          )}
          {fields
            .filter((field) => fieldsCheck.ok && fieldsCheck.values[field.key])
            .map((field) => (
              <Row key={field.key} label={field.labelAr}>
                <bdi dir="ltr" className="text-xl font-bold break-all">
                  {shownValue(field, fieldsCheck.ok ? (fieldsCheck.values[field.key] ?? '') : '')}
                </bdi>
              </Row>
            ))}
          {lastName ? (
            <Row label={t('purchase.playerName')}>
              <bdi className="text-lg font-bold">{lastName}</bdi>
            </Row>
          ) : (
            isTrusted &&
            chosen?.playerName && (
              <Row label={t('purchase.saved.lastName')}>
                <bdi className="text-lg font-bold">{chosen.playerName}</bdi>
              </Row>
            )
          )}
          {giftValue && (
            <Row label={t('purchase.gift.summary')}>
              <span className="flex flex-col">
                {giftValue.senderName && (
                  <span>{t('purchase.gift.from', { name: giftValue.senderName })}</span>
                )}
                {giftValue.message && (
                  <span className="whitespace-pre-line text-muted-foreground">
                    {giftValue.message}
                  </span>
                )}
              </span>
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

  // Rule CT1: without storage the cart is off and its button is hidden.
  const cartOn = Array.isArray(cart);
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
      {gameSaved.length > 0 && (
        <SavedChips
          players={gameSaved}
          fields={fields}
          chosenId={chosenId}
          onPick={(player) => pick(player, !bundle)}
          onNew={typeNew}
        />
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
                if (checkable && !isTrusted) void playerCheck.run();
              }}
            />
          ))}
          {game.idGuide && <IdGuideButton image={game.idGuide} gameName={game.nameAr} />}
        </div>
      )}
      {((checkable && !isTrusted) || forceConfirm) && (
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
      {canSave && (
        <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
          <label htmlFor={saveId} className="flex min-h-11 cursor-pointer items-center gap-3">
            <Checkbox
              id={saveId}
              checked={save.on}
              onCheckedChange={(checked) => setSave((current) => ({ ...current, on: checked }))}
            />
            <span className="text-base">{t('purchase.save.toggle')}</span>
          </label>
          {save.on && (
            <Field invalid={showErrors === 'all' && !labelValid}>
              <FieldLabel>{t('purchase.save.label')}</FieldLabel>
              <Input
                value={save.label}
                maxLength={40}
                autoComplete="off"
                className="h-11 text-md"
                aria-invalid={showErrors === 'all' && !labelValid}
                onChange={(event) =>
                  setSave((current) => ({ ...current, label: event.target.value }))
                }
              />
              <FieldError match={showErrors === 'all' && !labelValid}>
                {t('purchase.save.labelInvalid')}
              </FieldError>
            </Field>
          )}
        </div>
      )}
      {giftable && <GiftBox draft={gift} showErrors={showErrors === 'all'} onChange={setGift} />}
      {!bundle && product.maxQuantity > 1 && (
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
      {!bundle && !editing && (
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
      )}
      {cartOn && customer.status !== 'loading' && (
        <div className="flex flex-col gap-2">
          <Button
            variant={bundle || editing ? 'primary' : 'outline'}
            size="xl"
            onClick={() => void addLines()}
          >
            <ShoppingCartIcon aria-hidden="true" />
            {t(
              editing
                ? 'purchase.cart.saveLine'
                : bundle
                  ? 'purchase.cart.addAll'
                  : 'purchase.cart.add',
            )}
          </Button>
          {added === 'added' && (
            <p
              role="status"
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
            >
              <span className="flex items-center gap-2">
                <CircleCheckIcon
                  className="size-4 text-status-success-foreground"
                  aria-hidden="true"
                />
                {t('purchase.cart.added')}
              </span>
              <Link href="/cart" className="font-medium underline underline-offset-4">
                {t('purchase.cart.view')}
              </Link>
            </p>
          )}
          {added === 'full' && <FormAlert>{t('purchase.cart.full')}</FormAlert>}
        </div>
      )}
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
