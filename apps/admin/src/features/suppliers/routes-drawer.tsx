import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  formatAmountInput,
  formatSyp,
  formatUsd,
  type GameDetail,
  manualCostSchema,
  type Product,
  type ProductRouting,
  parseUsd,
  ROUTE_PRIORITY_MAX,
  type Route,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetContent,
  SheetTitle,
  Skeleton,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@vertex-digital/ui';
import { HistoryIcon, PlusIcon, RouteIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { formatDateTime, formatSince } from '../../lib/format';
import { AvailabilityBadge } from '../catalog/catalog-parts';
import { AddRouteDialog } from './add-route-dialog';
import { type FieldMapEntry, fieldMapEntries, toFieldMap, unmappedOf } from './field-map';
import { FieldMapEditor } from './field-map-editor';
import { UnusableReason } from './supplier-parts';
import {
  priceHistoryQuery,
  routingQuery,
  useArchiveRoute,
  useCreateManualRoute,
  useSetManualCost,
  useUpdateRoute,
} from './suppliers.queries';

/**
 * "المسارات" (S07 screens): a product's routes in tier order with their usability and reason,
 * the basis marked (rule P1); add a route or a manual one (rules RT1–RT3, RT7); priority, enable,
 * field map, archive and restore; the price history (newest 20).
 */
export function RoutesDrawer({
  game,
  product,
  onClose,
}: {
  game: GameDetail;
  product: Product | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Sheet open={product !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-[min(46rem,100vw)] max-w-none overflow-y-auto bg-surface p-6">
        {product && (
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-1">
              <SheetTitle className="text-xl font-bold">
                {t('suppliers.routes.title', { name: product.nameAr })}
              </SheetTitle>
              <p className="text-sm text-muted-foreground">{t('suppliers.routes.description')}</p>
            </div>
            <Routing game={game} product={product} />
            <PriceHistory productId={product.id} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Routing({ game, product }: { game: GameDetail; product: Product }) {
  const { t } = useTranslation();
  const routing = useQuery(routingQuery(product.id));
  const [adding, setAdding] = useState<'route' | 'manual' | null>(null);

  if (routing.isPending) return <Skeleton className="h-64 w-full" aria-hidden="true" />;
  if (routing.isError) {
    return (
      <div className="flex flex-col items-start gap-3">
        <FormAlert>{errorMessage(t, routing.error)}</FormAlert>
        <Button variant="outline" onClick={() => routing.refetch()}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }
  const data = routing.data;
  const hasManual = data.routes.some(
    (route) => route.supplierCode === 'manual' && route.archivedAt === null,
  );
  return (
    <>
      <PriceSummary routing={data} product={product} />
      <section className="flex flex-col gap-3" aria-labelledby="routes-list">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 id="routes-list" className="text-lg font-bold">
            {t('suppliers.routes.list')}
          </h3>
          <span className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setAdding('route')}>
              <PlusIcon />
              {t('suppliers.routes.add')}
            </Button>
            {!hasManual && (
              <Button variant="outline" size="sm" onClick={() => setAdding('manual')}>
                <PlusIcon />
                {t('suppliers.routes.addManual')}
              </Button>
            )}
          </span>
        </div>
        {data.routes.length === 0 ? (
          <EmptyState icon={<RouteIcon />} title={t('suppliers.routes.empty')} />
        ) : (
          <ul className="flex flex-col gap-3">
            {data.routes.map((route) => (
              <RouteItem key={route.id} route={route} game={game} />
            ))}
          </ul>
        )}
      </section>
      <Dialog open={adding !== null} onOpenChange={(open) => !open && setAdding(null)}>
        {adding === 'route' && (
          <AddRouteDialog game={game} product={product} onDone={() => setAdding(null)} />
        )}
        {adding === 'manual' && (
          <ManualCostDialog
            title={t('suppliers.routes.manual.addTitle')}
            productId={product.id}
            routeId={null}
            initialUnits={null}
            onDone={() => setAdding(null)}
          />
        )}
      </Dialog>
    </>
  );
}

/** The current price, its SYP display price, what it follows, the availability and a review. */
function PriceSummary({ routing, product }: { routing: ProductRouting; product: Product }) {
  const { t } = useTranslation();
  const basis = routing.routes.find((route) => route.id === routing.basisRouteId);
  return (
    <div className="flex flex-col gap-3 rounded-lg bg-muted p-4">
      <dl className="grid gap-4 text-sm sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <dt className="text-muted-foreground">{t('suppliers.routes.price')}</dt>
          <dd className="flex flex-col">
            {routing.currentPrice ? (
              <>
                <bdi dir="ltr" className="text-xl font-bold tabular-nums">
                  {formatUsd(routing.currentPrice.priceUsdUnits)}
                </bdi>
                {product.priceSypUnits !== null && (
                  <span className="text-muted-foreground tabular-nums">
                    {t('suppliers.routes.syp', { amount: formatSyp(product.priceSypUnits) })}
                  </span>
                )}
              </>
            ) : (
              <span className="text-muted-foreground">{t('suppliers.routes.noPrice')}</span>
            )}
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-muted-foreground">{t('suppliers.routes.basis')}</dt>
          <dd className="font-medium">
            {basis ? (
              <bdi>{basis.supplierNameAr}</bdi>
            ) : (
              <span className="text-muted-foreground">{t('suppliers.routes.noBasis')}</span>
            )}
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-muted-foreground">{t('suppliers.routes.availability')}</dt>
          <dd className="flex flex-wrap gap-1">
            <AvailabilityBadge availability={routing.availability} />
          </dd>
        </div>
      </dl>
      {routing.openReview && (
        <p className="text-sm text-status-warning-foreground">
          {t('suppliers.routes.review', {
            proposed: formatUsd(routing.openReview.proposedPriceUsdUnits),
          })}{' '}
          <Link to="/pricing/reviews" className="font-medium underline">
            {t('suppliers.routes.openReviews')}
          </Link>
        </p>
      )}
    </div>
  );
}

const TIER_TONES = { healthy: 'success', degraded: 'warning', manual: 'neutral' } as const;

function RouteItem({ route, game }: { route: Route; game: GameDetail }) {
  const { t } = useTranslation();
  const update = useUpdateRoute();
  const archive = useArchiveRoute();
  const [failure, setFailure] = useState<string | null>(null);
  const [editing, setEditing] = useState<'fields' | 'cost' | null>(null);
  const archived = route.archivedAt !== null;
  const manual = route.supplierCode === 'manual';
  const busy = update.isPending || archive.isPending;
  const priorities = Array.from({ length: ROUTE_PRIORITY_MAX }, (_, index) => ({
    value: String(index + 1),
    label: String(index + 1),
  }));

  async function run(action: () => Promise<unknown>) {
    setFailure(null);
    try {
      await action();
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <li
      className={
        route.basis
          ? 'flex flex-col gap-3 rounded-lg border-2 border-primary p-4'
          : 'flex flex-col gap-3 rounded-lg border border-border p-4'
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-bold">
              <bdi>{route.supplierNameAr}</bdi>
            </span>
            {route.basis && <Badge tone="brand">{t('suppliers.routes.basisMark')}</Badge>}
            {route.tier && (
              <Badge tone={TIER_TONES[route.tier]}>
                {t(`suppliers.routes.tiers.${route.tier}`)}
              </Badge>
            )}
            {route.unusableReason && <UnusableReason reason={route.unusableReason} />}
            {route.requirementsUnknown && (
              <Badge tone="outline">{t('suppliers.routes.requirementsUnknown')}</Badge>
            )}
          </span>
          <span className="text-sm text-muted-foreground">
            <bdi>{route.offer.name}</bdi> · <bdi dir="ltr">{route.offer.offerId}</bdi>
          </span>
        </div>
        <span className="flex flex-col items-end">
          {route.offer.costUsdUnits === null ? (
            <span className="text-sm text-muted-foreground">
              {t('suppliers.offers.costUnknown')}
            </span>
          ) : (
            <bdi dir="ltr" className="text-lg font-bold tabular-nums">
              {formatUsd(route.offer.costUsdUnits)}
            </bdi>
          )}
          {!manual && route.offer.costConfirmedAt && (
            <span className="text-xs text-muted-foreground">
              {formatSince(route.offer.costConfirmedAt)}
            </span>
          )}
        </span>
      </div>
      {Object.keys(route.fieldMap).length > 0 && (
        <p className="text-sm text-muted-foreground">
          {t('suppliers.routes.fields')}{' '}
          {Object.entries(route.fieldMap).map(([field, key], index) => (
            <span key={field}>
              {index > 0 && '، '}
              <bdi dir="ltr">
                {field} → {key}
              </bdi>
            </span>
          ))}
        </p>
      )}
      {failure && <FormAlert>{failure}</FormAlert>}
      <div className="flex flex-wrap items-center gap-3">
        {archived ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => run(() => archive.mutateAsync({ id: route.id, archive: false }))}
          >
            {t('catalog.actions.restore')}
          </Button>
        ) : (
          <>
            <span className="flex items-center gap-2 text-sm">
              <Switch
                id={`enabled-${route.id}`}
                checked={route.enabled}
                disabled={busy}
                onCheckedChange={(enabled) =>
                  run(() => update.mutateAsync({ id: route.id, body: { enabled } }))
                }
              />
              <label htmlFor={`enabled-${route.id}`}>{t('suppliers.routes.enabled')}</label>
            </span>
            <span className="flex items-center gap-2 text-sm">
              <span id={`priority-${route.id}`}>{t('suppliers.routes.priority')}</span>
              <Select
                items={priorities}
                value={String(route.priority)}
                onValueChange={(value) =>
                  run(() => update.mutateAsync({ id: route.id, body: { priority: Number(value) } }))
                }
              >
                <SelectTrigger className="w-20" aria-labelledby={`priority-${route.id}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {priorities.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </span>
            {manual ? (
              <Button variant="outline" size="sm" onClick={() => setEditing('cost')}>
                {t('suppliers.routes.manual.edit')}
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setEditing('fields')}>
                {t('suppliers.routes.editFields')}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => run(() => archive.mutateAsync({ id: route.id, archive: true }))}
            >
              {t('catalog.actions.archive')}
            </Button>
          </>
        )}
      </div>
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        {editing === 'fields' && (
          <FieldsDialog route={route} game={game} onDone={() => setEditing(null)} />
        )}
        {editing === 'cost' && (
          <ManualCostDialog
            title={t('suppliers.routes.manual.editTitle')}
            productId={null}
            routeId={route.id}
            initialUnits={route.offer.costUsdUnits}
            onDone={() => setEditing(null)}
          />
        )}
      </Dialog>
    </li>
  );
}

/** Rule RT3: the route's field map, edited against the game's live fields. */
function FieldsDialog({
  route,
  game,
  onDone,
}: {
  route: Route;
  game: GameDetail;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const update = useUpdateRoute();
  const [entries, setEntries] = useState<FieldMapEntry[]>(() =>
    fieldMapEntries(route.offer.requiredFields ?? [], route.fieldMap),
  );
  const [missing, setMissing] = useState<string[]>([]);
  const [failure, setFailure] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    try {
      await update.mutateAsync({ id: route.id, body: { fieldMap: toFieldMap(entries) } });
      onDone();
    } catch (error) {
      setMissing(unmappedOf(error));
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <DialogContent closeLabel={t('common.close')} className="max-w-lg">
      <DialogHeader>
        <DialogTitle>{t('suppliers.routes.fieldsTitle')}</DialogTitle>
        <DialogDescription>
          <bdi>{route.offer.name}</bdi>
        </DialogDescription>
      </DialogHeader>
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <FieldMapEditor
          entries={entries}
          fields={game.fields.filter((field) => field.archivedAt === null)}
          missing={missing}
          onChange={setEntries}
        />
        {failure && <FormAlert>{failure}</FormAlert>}
        <DialogFooter>
          <Button type="submit" disabled={update.isPending}>
            {t('catalog.actions.save')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

/**
 * Rule RT7: a manual route's cost in whole cents, after re-authentication; with `productId`, the
 * manual offer and its route are created at that cost.
 */
function ManualCostDialog({
  title,
  productId,
  routeId,
  initialUnits,
  onDone,
}: {
  title: string;
  productId: string | null;
  routeId: string | null;
  initialUnits: number | null;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const create = useCreateManualRoute(productId ?? '');
  const setCost = useSetManualCost();
  const [text, setText] = useState(() =>
    initialUnits === null ? '' : formatAmountInput('USD', initialUnits),
  );
  const [invalid, setInvalid] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const pending = create.isPending || setCost.isPending;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const parsed = manualCostSchema.safeParse(parseUsd(text));
    setInvalid(!parsed.success);
    if (!parsed.success) return;
    try {
      if (routeId) await setCost.mutateAsync({ id: routeId, costUsdUnits: parsed.data });
      else await create.mutateAsync(parsed.data);
      onDone();
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <DialogContent closeLabel={t('common.close')} className="max-w-md">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{t('suppliers.routes.manual.description')}</DialogDescription>
      </DialogHeader>
      <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
        <Field invalid={invalid}>
          <FieldLabel>{t('suppliers.routes.manual.cost')}</FieldLabel>
          <Input
            name="manualCost"
            dir="ltr"
            inputMode="decimal"
            autoComplete="off"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <FieldDescription>{t('suppliers.routes.manual.costHint')}</FieldDescription>
          <FieldError match={invalid}>{t('suppliers.routes.manual.costError')}</FieldError>
        </Field>
        {failure && <FormAlert>{failure}</FormAlert>}
        <DialogFooter>
          <Button type="submit" disabled={pending}>
            {t('catalog.actions.save')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function PriceHistory({ productId }: { productId: string }) {
  const { t } = useTranslation();
  const prices = useQuery(priceHistoryQuery(productId));
  return (
    <section className="flex flex-col gap-3" aria-labelledby="price-history">
      <h3 id="price-history" className="text-lg font-bold">
        {t('suppliers.prices.title')}
      </h3>
      {prices.isPending && <Skeleton className="h-32 w-full" aria-hidden="true" />}
      {prices.isError && <FormAlert>{errorMessage(t, prices.error)}</FormAlert>}
      {prices.isSuccess &&
        (prices.data.items.length === 0 ? (
          <EmptyState icon={<HistoryIcon />} title={t('suppliers.prices.empty')} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('suppliers.prices.time')}</TableHead>
                <TableHead>{t('suppliers.prices.price')}</TableHead>
                <TableHead>{t('suppliers.prices.cost')}</TableHead>
                <TableHead>{t('suppliers.prices.supplier')}</TableHead>
                <TableHead>{t('suppliers.prices.cause')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {prices.data.items.map((price) => (
                <TableRow key={price.id}>
                  <TableCell className="whitespace-nowrap">
                    {formatDateTime(price.createdAt)}
                  </TableCell>
                  <TableCell className="font-medium tabular-nums">
                    <bdi dir="ltr">{formatUsd(price.priceUsdUnits)}</bdi>
                  </TableCell>
                  <TableCell className="tabular-nums">
                    <bdi dir="ltr">{formatUsd(price.costUsdUnits)}</bdi>
                  </TableCell>
                  <TableCell>{t(`suppliers.names.${price.supplierCode}`)}</TableCell>
                  <TableCell>{t(`suppliers.prices.causes.${price.cause}`)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ))}
    </section>
  );
}
