import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  ADMIN_ORDER_PURPOSES,
  type AdminOrderPurpose,
  type AdminPurchaseContext,
  adminOrderShape,
  createAdminOrderSchema,
  formatSyp,
  formatUsd,
  type GameDetail,
  orderTotal,
  type PlayerCheck,
  type Product,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Callout,
  Card,
  CardTitle,
  Checkbox,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  PageHeader,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Textarea,
  useFocusInvalid,
} from '@vertex-digital/ui';
import { ArrowRightIcon, SearchIcon, UserXIcon } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert, InvalidAlert } from '../../components/form-alert';
import { ApiError } from '../../lib/api/client';
import { errorMessage } from '../../lib/errors';
import { ltr } from '../../lib/format';
import { useIdempotencyKey } from '../../lib/idempotency';
import { allGamesQuery, gameQuery } from '../catalog/catalog.queries';
import { customerListQuery } from '../customers/customers.queries';
import { StockChip } from '../suppliers/offer-cells';
import type { NewOrderSearch } from './new-order-search';
import { purchaseContextQuery, useAdminPlayerCheck, useCreateAdminOrder } from './orders.queries';

/** The fields of the form a refusal may name. */
type FieldKey = 'customerId' | 'productId' | 'quantity' | 'reason' | 'customerNote' | 'fields';

/** Where a schema issue shows: the price follows the pack, the fields their step. */
const FIELD_OF: Partial<Record<string, FieldKey>> = {
  customerId: 'customerId',
  productId: 'productId',
  expectedUnitPriceUsdUnits: 'productId',
  quantity: 'quantity',
  reason: 'reason',
  customerNote: 'customerNote',
  fields: 'fields',
};

/** A pack the mode may buy (rule AP5): available, or paused by the admin for an owner-funded one. */
function packChoice(product: Product, ownerFunded: boolean): 'buyable' | 'trial' | 'unavailable' {
  if (product.archivedAt !== null || product.priceUsdUnits === null) return 'unavailable';
  if (product.availability === 'available') return 'buyable';
  return product.availability === 'paused' && ownerFunded ? 'trial' : 'unavailable';
}

/**
 * "/orders/new" "شراء من اللوحة" (S16 rules AP1–AP13): the mode, the customer, the pack, the
 * account fields with the player check, the reason and note, then one order at the store's
 * current price with the page's `Idempotency-Key`, re-authenticated; the order page opens after.
 */
export function NewOrderPage({ preset }: { preset: NewOrderSearch }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [purpose, setPurpose] = useState<AdminOrderPurpose | null>(preset.purpose ?? null);
  const [customerId, setCustomerId] = useState<string | null>(preset.customerId ?? null);
  const [gameId, setGameId] = useState<string | null>(preset.gameId ?? null);
  const [productId, setProductId] = useState<string | null>(preset.productId ?? null);
  const [quantity, setQuantity] = useState('1');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [check, setCheck] = useState<PlayerCheck | null>(null);
  const [confirmPlayer, setConfirmPlayer] = useState(false);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const { ref, focusInvalid } = useFocusInvalid();
  /** `OWNER_DAILY_CAP_EXCEEDED` links to the policy beside its message. */
  const [capReached, setCapReached] = useState(false);
  const keyFor = useIdempotencyKey();
  const create = useCreateAdminOrder();
  const playerCheck = useAdminPlayerCheck();

  const shape = purpose ? adminOrderShape(purpose) : null;
  const ownerFunded = shape?.payer === 'owner';
  const context = useQuery({
    ...purchaseContextQuery(shape?.hasCustomer ? (customerId ?? undefined) : undefined),
    enabled: shape !== null && (!shape.hasCustomer || customerId !== null),
  });
  const games = useQuery(allGamesQuery);
  const game = useQuery({ ...gameQuery(gameId ?? ''), enabled: gameId !== null });
  const product = game.data?.products.find((item) => item.id === productId) ?? null;
  const hasFields = (game.data?.fields ?? []).some((field) => field.archivedAt === null);
  const units = /^\d{1,2}$/.test(quantity) ? Number(quantity) : 0;
  const total =
    product?.priceUsdUnits && units > 0 ? orderTotal(product.priceUsdUnits, units) : null;

  /** A change of what is bought clears the checks made for the earlier choice. */
  function resetCheck() {
    setCheck(null);
    setConfirmPlayer(false);
  }

  async function runCheck() {
    if (!productId) return;
    setFailure(null);
    try {
      setCheck(await playerCheck.mutateAsync({ productId, fields }));
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    setCapReached(false);
    const body = {
      purpose,
      ...(shape?.hasCustomer && customerId && { customerId }),
      productId,
      quantity: units,
      // S08 rule O5: every unarchived field of the game, whatever the pack's kind.
      fields: hasFields ? fields : {},
      expectedUnitPriceUsdUnits: product?.priceUsdUnits,
      confirmPlayer,
      reason,
      ...((purpose === 'gift' || purpose === 'compensation') &&
        note.trim() && { customerNote: note }),
    };
    const parsed = createAdminOrderSchema.safeParse(body);
    if (!parsed.success) {
      const next: Partial<Record<FieldKey, string>> = {};
      for (const issue of parsed.error.issues) {
        const key = FIELD_OF[String(issue.path[0])] ?? 'productId';
        next[key] ??= t(`orders.buy.errors.${key}`);
      }
      setErrors(next);
      return focusInvalid();
    }
    setErrors({});
    try {
      const order = await create.mutateAsync({ body: parsed.data, key: keyFor(parsed.data) });
      await navigate({ to: '/orders/$id', params: { id: order.id } });
    } catch (error) {
      setFailure(refusal(error));
    }
  }

  /** A refusal in place, with what the admin can do about it (S16 screens). */
  function refusal(error: unknown): string {
    if (!(error instanceof ApiError)) return errorMessage(t, error);
    const details = (error.details ?? {}) as Record<string, unknown>;
    if (error.code === 'PRICE_CHANGED') {
      void game.refetch();
      return t('orders.buy.priceChanged', {
        price: ltr(formatUsd(Number(details.unitPriceUsdUnits ?? 0))),
      });
    }
    if (error.code === 'OWNER_DAILY_CAP_EXCEEDED') {
      void context.refetch();
      setCapReached(true);
      return t('orders.buy.capExceeded', {
        left: ltr(formatUsd(Number(details.remainingUsdUnits ?? 0))),
      });
    }
    if (error.code === 'VALIDATION_FAILED' && details.fields) {
      setErrors({ fields: t('orders.buy.errors.fields') });
      focusInvalid();
    }
    if (error.code === 'PLAYER_NOT_CONFIRMED') setCheck({ result: 'invalid' });
    return errorMessage(t, error);
  }

  return (
    <>
      <PageHeader
        title={t('orders.buy.title')}
        description={t('orders.buy.subtitle')}
        actions={
          <Button variant="ghost" render={<Link to="/orders" />}>
            <ArrowRightIcon className="ltr:-scale-x-100" />
            {t('orders.back')}
          </Button>
        }
      />
      <form ref={ref} className="flex flex-col gap-6" onSubmit={submit} noValidate>
        <Step title={t('orders.buy.steps.mode')}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {ADMIN_ORDER_PURPOSES.map((item) => (
              <label
                key={item}
                className="flex cursor-pointer flex-col gap-1 rounded-lg border border-border p-4 has-checked:border-primary has-checked:bg-muted"
              >
                <span className="flex items-center gap-2 font-medium">
                  <input
                    type="radio"
                    name="purpose"
                    className="size-4 accent-primary"
                    value={item}
                    checked={purpose === item}
                    onChange={() => {
                      setPurpose(item);
                      if (item === 'walk_in') setCustomerId(null);
                      resetCheck();
                    }}
                  />
                  {t(`orders.purposes.${item}`)}
                </span>
                <span className="text-sm text-muted-foreground">
                  {t(`orders.buy.payerOf.${adminOrderShape(item).payer}`)}
                </span>
              </label>
            ))}
          </div>
        </Step>

        {shape?.hasCustomer && (
          <Step title={t('orders.buy.steps.customer')} invalid={!!errors.customerId}>
            <CustomerPicker
              customerId={customerId}
              context={context.data?.customer ?? null}
              loading={customerId !== null && context.isPending}
              onPick={(id) => {
                setCustomerId(id);
                resetCheck();
              }}
            />
            {errors.customerId && <FormAlert>{errors.customerId}</FormAlert>}
          </Step>
        )}

        {shape && (
          <Step title={t('orders.buy.steps.pack')}>
            <Field>
              <FieldLabel>{t('orders.buy.game')}</FieldLabel>
              <Select
                items={(games.data?.items ?? []).map((item) => ({
                  value: item.id,
                  label: item.nameAr,
                }))}
                value={gameId}
                onValueChange={(value) => {
                  setGameId(value ?? null);
                  setProductId(null);
                  setFields({});
                  resetCheck();
                }}
              >
                <SelectTrigger aria-label={t('orders.buy.game')}>
                  <SelectValue placeholder={t('orders.buy.pickGame')} />
                </SelectTrigger>
                <SelectContent>
                  {(games.data?.items ?? []).map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.nameAr}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {game.isPending && gameId && <Skeleton className="h-32 w-full" aria-hidden="true" />}
            {game.isError && <FormAlert>{errorMessage(t, game.error)}</FormAlert>}
            {game.data && (
              <Packs
                game={game.data}
                ownerFunded={ownerFunded}
                productId={productId}
                invalid={!!errors.productId}
                onPick={(id) => {
                  setProductId(id);
                  setQuantity('1');
                  resetCheck();
                }}
              />
            )}
            {errors.productId && <FormAlert>{errors.productId}</FormAlert>}
            {product && (
              <Field invalid={!!errors.quantity} className="max-w-48">
                <FieldLabel>{t('orders.buy.quantity')}</FieldLabel>
                <Input
                  name="quantity"
                  dir="ltr"
                  inputMode="numeric"
                  autoComplete="off"
                  value={quantity}
                  onChange={(event) => setQuantity(event.target.value)}
                />
                <FieldDescription>
                  {t('orders.buy.maxQuantity', { max: product.maxQuantity })}
                </FieldDescription>
                <FieldError match={!!errors.quantity}>{errors.quantity}</FieldError>
              </Field>
            )}
          </Step>
        )}

        {product && game.data && (product.kind === 'direct' || hasFields) && (
          <Step title={t('orders.buy.steps.account')}>
            <AccountFields
              game={game.data}
              values={fields}
              invalid={!!errors.fields}
              // Saved IDs and the player check are a top-up's (S10 SP1, S16 AP8).
              saved={
                product.kind === 'direct'
                  ? (context.data?.customer?.savedPlayers ?? []).filter(
                      (player) => player.gameId === game.data.id,
                    )
                  : []
              }
              onChange={(next) => {
                setFields(next);
                resetCheck();
              }}
            />
            {errors.fields && <FormAlert>{errors.fields}</FormAlert>}
            {product.kind === 'direct' && (
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={runCheck}
                  disabled={playerCheck.isPending}
                >
                  <SearchIcon />
                  {playerCheck.isPending ? t('orders.buy.checking') : t('orders.buy.check')}
                </Button>
                {check && <CheckAnswer check={check} />}
              </div>
            )}
            {product.kind === 'direct' && check?.result === 'invalid' && (
              <ConfirmLine checked={confirmPlayer} onChange={setConfirmPlayer}>
                {t('orders.buy.confirmPlayer')}
              </ConfirmLine>
            )}
          </Step>
        )}

        {product && shape && (
          <Step title={t('orders.buy.steps.confirm')}>
            <Field invalid={!!errors.reason}>
              <FieldLabel>{t('orders.buy.reason')}</FieldLabel>
              <Textarea
                name="reason"
                rows={2}
                maxLength={500}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
              <FieldDescription>{t('orders.buy.reasonHelp')}</FieldDescription>
              <FieldError match={!!errors.reason}>{errors.reason}</FieldError>
            </Field>
            {(purpose === 'gift' || purpose === 'compensation') && (
              <Field invalid={!!errors.customerNote}>
                <FieldLabel>{t('orders.buy.note')}</FieldLabel>
                <Textarea
                  name="customerNote"
                  rows={2}
                  maxLength={300}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
                <FieldDescription>{t('orders.buy.noteHelp')}</FieldDescription>
                <FieldError match={!!errors.customerNote}>{errors.customerNote}</FieldError>
              </Field>
            )}
            <Summary total={total} ownerFunded={ownerFunded} context={context.data ?? null} />
          </Step>
        )}

        {failure && <FormAlert>{failure}</FormAlert>}
        <InvalidAlert show={Object.values(errors).some(Boolean)} />
        {capReached && (
          <Button variant="link" className="self-start" render={<Link to="/orders/policy" />}>
            {t('orders.policy.link')}
          </Button>
        )}
        {product && shape && (
          <Button type="submit" size="lg" className="self-start" disabled={create.isPending}>
            {create.isPending ? t('orders.buy.placing') : t('orders.buy.confirm')}
          </Button>
        )}
      </form>
    </>
  );
}

/** `invalid`: the step's own choice (a customer) is refused; a failed submit focuses it. */
function Step({
  title,
  invalid,
  children,
}: {
  title: string;
  invalid?: boolean;
  children: ReactNode;
}) {
  return (
    <Card className="gap-4" data-invalid={invalid ? '' : undefined}>
      <CardTitle>{title}</CardTitle>
      {children}
    </Card>
  );
}

function ConfirmLine({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center gap-3 text-sm font-medium">
      <Checkbox id={id} checked={checked} onCheckedChange={(value) => onChange(value)} />
      {children}
    </label>
  );
}

/** Rule AP4: search by name, email or phone; frozen customers are shown but cannot be picked. */
function CustomerPicker({
  customerId,
  context,
  loading,
  onPick,
}: {
  customerId: string | null;
  context: AdminPurchaseContext['customer'];
  loading: boolean;
  onPick: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [q, setQ] = useState<string | null>(null);
  const found = useInfiniteQuery({ ...customerListQuery({ q: q ?? '' }), enabled: q !== null });
  const rows = (found.data?.pages[0]?.items ?? []).slice(0, 8);

  if (customerId !== null) {
    if (loading || !context) return <Skeleton className="h-24 w-full" aria-hidden="true" />;
    const refused = context.frozen || !context.emailVerified;
    return (
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border p-4">
          <div className="flex flex-col gap-1">
            <span className="flex items-center gap-2 font-medium">
              {context.name}
              {context.isTest && <Badge tone="info">{t('wallets.testBadge')}</Badge>}
              {context.frozen && <Badge tone="danger">{t('orders.buy.frozen')}</Badge>}
              {!context.emailVerified && <Badge tone="warning">{t('orders.buy.unverified')}</Badge>}
            </span>
            <span dir="ltr" className="text-end text-sm text-muted-foreground">
              {context.email}
            </span>
            <span className="text-sm">
              {t('orders.buy.balance', { balance: ltr(formatUsd(context.balanceUsdUnits)) })}
              {' · '}
              {context.purchaseCapLeftUsdUnits === null
                ? t('orders.buy.noCap')
                : t('orders.buy.capLeft', {
                    left: ltr(formatUsd(context.purchaseCapLeftUsdUnits)),
                  })}
            </span>
          </div>
          <Button type="button" variant="ghost" onClick={() => onPick(null)}>
            {t('orders.buy.changeCustomer')}
          </Button>
        </div>
        {refused && (
          <Callout
            tone="danger"
            icon={<UserXIcon />}
            title={context.frozen ? t('orders.buy.frozenHelp') : t('orders.buy.unverifiedHelp')}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field className="min-w-64 flex-1">
          <FieldLabel>{t('orders.buy.findCustomer')}</FieldLabel>
          <Input
            type="search"
            dir="ltr"
            autoComplete="off"
            maxLength={100}
            placeholder={t('orders.buy.findPlaceholder')}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                if (text.trim()) setQ(text.trim());
              }
            }}
          />
        </Field>
        <Button type="button" variant="outline" onClick={() => text.trim() && setQ(text.trim())}>
          <SearchIcon />
          {t('orders.buy.search')}
        </Button>
      </div>
      {found.isFetching && <Skeleton className="h-16 w-full" aria-hidden="true" />}
      {found.isError && <FormAlert>{errorMessage(t, found.error)}</FormAlert>}
      {found.isSuccess && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('orders.buy.noCustomers')}</p>
      )}
      {rows.length > 0 && (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => {
            const blocked = row.status !== 'active';
            return (
              <li key={row.id}>
                <Button
                  type="button"
                  variant="outline"
                  className="h-auto w-full justify-between gap-3 py-2"
                  disabled={blocked}
                  onClick={() => onPick(row.id)}
                >
                  <span className="flex flex-col items-start gap-0.5">
                    <span className="font-medium">{row.name}</span>
                    <span dir="ltr" className="text-sm text-muted-foreground">
                      {row.email}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    {blocked && (
                      <Badge tone="danger">{t(`orders.buy.statuses.${row.status}`)}</Badge>
                    )}
                    <bdi dir="ltr" className="tabular-nums">
                      {formatUsd(row.balanceUnits)}
                    </bdi>
                  </span>
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Rule AP5: the game's packs with their price; paused packs only for owner-funded modes. */
function Packs({
  game,
  ownerFunded,
  productId,
  invalid,
  onPick,
}: {
  game: GameDetail;
  ownerFunded: boolean;
  productId: string | null;
  invalid: boolean;
  onPick: (id: string) => void;
}) {
  const { t } = useTranslation();
  const products = game.products.filter((item) => item.archivedAt === null);
  if (products.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('orders.buy.noPacks')}</p>;
  }
  return (
    <fieldset
      className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3"
      data-invalid={invalid ? '' : undefined}
    >
      <legend className="sr-only">{t('orders.buy.pack')}</legend>
      {products.map((item) => {
        const choice = packChoice(item, ownerFunded);
        return (
          <label
            key={item.id}
            className="flex cursor-pointer flex-col gap-1 rounded-lg border border-border p-3 has-checked:border-primary has-checked:bg-muted has-disabled:cursor-not-allowed has-disabled:opacity-60"
          >
            <span className="flex items-center gap-2 font-medium">
              <input
                type="radio"
                name="product"
                className="size-4 accent-primary"
                value={item.id}
                disabled={choice === 'unavailable'}
                checked={productId === item.id}
                onChange={() => onPick(item.id)}
              />
              <bdi>{item.nameAr}</bdi>
            </span>
            <span className="text-sm tabular-nums">
              {item.priceUsdUnits === null ? (
                t('orders.buy.noPrice')
              ) : (
                <>
                  <bdi dir="ltr">{formatUsd(item.priceUsdUnits)}</bdi>
                  {item.priceSypUnits !== null && (
                    <span className="text-muted-foreground">
                      {' · '}
                      {t('catalog.products.syp', { amount: formatSyp(item.priceSypUnits) })}
                    </span>
                  )}
                </>
              )}
            </span>
            <span className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
              {choice === 'trial' && <Badge tone="gold">{t('orders.buy.trial')}</Badge>}
              {choice === 'unavailable' && (
                <Badge tone="neutral">{t(`catalog.availability.${item.availability}`)}</Badge>
              )}
              {item.basisSupplierNameAr &&
                t('orders.buy.basis', { supplier: item.basisSupplierNameAr })}
              {item.basisStockLevel && <StockChip level={item.basisStockLevel} quiet />}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

/** Rule AP8: the game's fields, filled by hand or from the customer's saved ids (S10). */
function AccountFields({
  game,
  values,
  invalid,
  saved,
  onChange,
}: {
  game: GameDetail;
  values: Record<string, string>;
  invalid: boolean;
  saved: NonNullable<AdminPurchaseContext['customer']>['savedPlayers'];
  onChange: (values: Record<string, string>) => void;
}) {
  const { t } = useTranslation();
  const fields = game.fields.filter((field) => field.archivedAt === null);
  return (
    <div className="flex flex-col gap-4">
      {saved.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">{t('orders.buy.savedIds')}</span>
          {saved.map((player) => (
            <Button
              key={player.id}
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onChange({ ...player.fields })}
            >
              <bdi>{player.label}</bdi>
              {player.playerName && (
                <span className="text-muted-foreground">
                  · <bdi>{player.playerName}</bdi>
                </span>
              )}
            </Button>
          ))}
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2" data-invalid={invalid ? '' : undefined}>
        {fields.map((field) => (
          <Field key={field.id}>
            <FieldLabel>{field.labelAr}</FieldLabel>
            {field.type === 'select' && field.options ? (
              <Select
                items={field.options.map((option) => ({
                  value: option.value,
                  label: option.labelAr,
                }))}
                value={values[field.key] ?? null}
                onValueChange={(value) => onChange({ ...values, [field.key]: value ?? '' })}
              >
                <SelectTrigger aria-label={field.labelAr}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {field.options.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.labelAr}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                dir="ltr"
                autoComplete="off"
                spellCheck={false}
                inputMode={field.type === 'digits' ? 'numeric' : 'text'}
                value={values[field.key] ?? ''}
                onChange={(event) => onChange({ ...values, [field.key]: event.target.value })}
              />
            )}
            {field.helpAr && <FieldDescription>{field.helpAr}</FieldDescription>}
          </Field>
        ))}
      </div>
    </div>
  );
}

function CheckAnswer({ check }: { check: PlayerCheck }) {
  const { t } = useTranslation();
  switch (check.result) {
    case 'valid':
      return (
        <Badge tone="success">
          {check.playerName
            ? t('orders.buy.checkValid', { name: check.playerName })
            : t('orders.buy.checkValidNoName')}
        </Badge>
      );
    case 'invalid':
      return <Badge tone="danger">{t('orders.buy.checkInvalid')}</Badge>;
    case 'unavailable':
      return <Badge tone="warning">{t('orders.buy.checkUnavailable')}</Badge>;
    default:
      return <Badge tone="neutral">{t('orders.buy.checkNotSupported')}</Badge>;
  }
}

/** The total, who pays, and the customer's balance after or the owner's day against the cap. */
function Summary({
  total,
  ownerFunded,
  context,
}: {
  total: number | null;
  ownerFunded: boolean;
  context: AdminPurchaseContext | null;
}) {
  const { t } = useTranslation();
  const usd = (units: number) => ltr(formatUsd(units));
  return (
    <dl className="grid gap-4 rounded-lg bg-muted p-4 sm:grid-cols-3">
      <div className="flex flex-col gap-1">
        <dt className="text-sm text-muted-foreground">{t('orders.buy.total')}</dt>
        <dd className="text-lg font-bold tabular-nums">
          {total === null ? '—' : <bdi dir="ltr">{formatUsd(total)}</bdi>}
        </dd>
      </div>
      <div className="flex flex-col gap-1">
        <dt className="text-sm text-muted-foreground">{t('orders.buy.payer')}</dt>
        <dd className="font-medium">
          {t(`orders.buy.payerOf.${ownerFunded ? 'owner' : 'customer'}`)}
        </dd>
      </div>
      {context && total !== null && (
        <div className="flex flex-col gap-1">
          <dt className="text-sm text-muted-foreground">
            {ownerFunded ? t('orders.buy.ownerToday') : t('orders.buy.balanceAfter')}
          </dt>
          <dd className="font-medium tabular-nums">
            {ownerFunded
              ? t('orders.buy.ownerTodayValue', {
                  used: usd(context.owner.usedTodayUsdUnits + total),
                  cap: usd(context.owner.capUsdUnits),
                })
              : context.customer
                ? usd(context.customer.balanceUsdUnits - total)
                : '—'}
          </dd>
        </div>
      )}
    </dl>
  );
}
