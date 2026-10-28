import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  formatSyp,
  formatUsd,
  type GameDetail,
  marginPercent,
  PRICE_MATRIX_MAX_LISTS,
  PRICE_MATRIX_MAX_PRODUCTS,
  type PriceMatrix,
  type Product,
  ROOT_PRICE_LIST_IDS,
} from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Callout,
  cn,
  Dialog,
  EmptyState,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@vertex-digital/ui';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  LinkIcon,
  PackageIcon,
  PlusIcon,
  RouteIcon,
  ShoppingCartIcon,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/confirm-dialog';
import { FormAlert } from '../../components/form-alert';
import { ReadFailure } from '../../components/read-failure';
import { formatDuration, ltr } from '../../lib/format';
import { priceListsQuery, priceMatrixQuery } from '../pricing/pricing.queries';
import { StockChip } from '../suppliers/offer-cells';
import { RoutesDrawer } from '../suppliers/routes-drawer';
import { UnusableReason } from '../suppliers/supplier-parts';
import { useArchiveProduct, useReorderProducts, useUpdateProduct } from './catalog.queries';
import { AvailabilityBadge, catalogFailure, MoveButton, StatusBadge } from './catalog-parts';
import { moved } from './catalog-search';
import { ProductDialog } from './product-dialog';
import { QuickLinkDialog } from './quick-link-dialog';

/**
 * "الباقات" (S06 screens): the game's products in order (name, kind, in-game amount, official
 * price, max quantity, status, availability), add and edit by kind, pause and resume (rule CT4),
 * order (rule CT5), archive after a confirmation (audit A7) and restore with an archived filter
 * (rule CT1). S07: the stored price
 * in USD and SYP, the supplier it follows, a held review, and each product's routes drawer.
 * S22 DL5: each pack's direct buy link, with its QR and campaign tag. Every other price list's
 * price beside retail, from the price matrix; a pack with no usable route shows its cheapest
 * route's cost and the prices it would take, marked as estimates.
 */
export function ProductsTab({ game }: { game: GameDetail }) {
  const { t } = useTranslation();
  const [archived, setArchived] = useState(false);
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const [routing, setRouting] = useState<string | null>(null);
  const [linking, setLinking] = useState<Product | null>(null);
  const [archiving, setArchiving] = useState<Product | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const reorder = useReorderProducts(game.id);
  const archive = useArchiveProduct();
  const update = useUpdateProduct();
  const products = game.products.filter((product) => (product.archivedAt !== null) === archived);
  const live = game.products.filter((product) => product.archivedAt === null);
  const busy = reorder.isPending || archive.isPending || update.isPending;
  const lists = useQuery(priceListsQuery);
  const others = (lists.data ?? [])
    .filter((list) => list.archivedAt === null && list.id !== ROOT_PRICE_LIST_IDS.retail)
    .slice(0, PRICE_MATRIX_MAX_LISTS - 1);
  const matrix = useQuery({
    ...priceMatrixQuery({ gameId: game.id, lists: others.map((list) => list.id) }),
    enabled: lists.isSuccess && live.length > 0,
  });
  const sheets = new Map((matrix.data?.rows ?? []).map((row) => [row.productId, row]));
  const listsFailure = lists.isError ? lists : matrix.isError ? matrix : null;
  // Until the matrix answers, its cells show a placeholder rather than "no price".
  const loadingSheets = !archived && !listsFailure && (lists.isPending || matrix.isPending);

  async function run(action: () => Promise<unknown>) {
    setFailure(null);
    try {
      await action();
    } catch (error) {
      setFailure(catalogFailure(t, error));
    }
  }

  const move = (index: number, step: -1 | 1) =>
    run(() =>
      reorder.mutateAsync(
        moved(
          live.map((item) => item.id),
          index,
          step,
        ),
      ),
    );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          value={archived ? 'archived' : 'live'}
          onValueChange={(value) => setArchived(value === 'archived')}
        >
          <TabsList className="w-auto">
            <TabsTrigger value="live">{t('catalog.filters.live')}</TabsTrigger>
            <TabsTrigger value="archived">{t('catalog.filters.archived')}</TabsTrigger>
          </TabsList>
        </Tabs>
        <Button onClick={() => setEditing('new')} disabled={game.archivedAt !== null}>
          <PlusIcon />
          {t('catalog.products.add')}
        </Button>
      </div>
      {failure && <FormAlert>{failure}</FormAlert>}
      {!archived && listsFailure && (
        <ReadFailure error={listsFailure.error} onRetry={() => listsFailure.refetch()} />
      )}
      {!archived && (matrix.data?.rows.length ?? 0) >= PRICE_MATRIX_MAX_PRODUCTS && (
        <Callout
          tone="info"
          title={t('pricing.matrix.truncated', { max: PRICE_MATRIX_MAX_PRODUCTS })}
        />
      )}
      {products.length === 0 ? (
        <EmptyState
          icon={<PackageIcon />}
          title={archived ? t('catalog.products.noneArchived') : t('catalog.products.empty')}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('catalog.products.columns.name')}</TableHead>
              <TableHead>{t('catalog.products.columns.kind')}</TableHead>
              <TableHead>{t('catalog.products.columns.amount')}</TableHead>
              <TableHead>{t('catalog.products.columns.official')}</TableHead>
              <TableHead>{t('catalog.products.columns.price')}</TableHead>
              <TableHead>{t('catalog.products.columns.lists')}</TableHead>
              <TableHead>{t('catalog.products.columns.cost')}</TableHead>
              <TableHead>{t('catalog.products.columns.maxQuantity')}</TableHead>
              <TableHead>{t('catalog.products.columns.status')}</TableHead>
              <TableHead>{t('catalog.products.columns.availability')}</TableHead>
              <TableHead>{t('catalog.products.columns.deliveryTime')}</TableHead>
              <TableHead>
                <span className="sr-only">{t('catalog.columns.actions')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {products.map((product, index) => (
              <TableRow key={product.id}>
                <TableCell className="font-medium">
                  <bdi>{product.nameAr}</bdi>
                </TableCell>
                <TableCell>
                  <Badge tone={product.kind === 'code' ? 'gold' : 'info'}>
                    {t(`catalog.products.kinds.${product.kind}`)}
                  </Badge>
                </TableCell>
                <TableCell className="tabular-nums">
                  {product.gameAmount === null ? '—' : product.gameAmount.toLocaleString('en-US')}
                </TableCell>
                <TableCell className="tabular-nums">
                  {product.officialPriceUsdUnits === null ? (
                    '—'
                  ) : (
                    <bdi dir="ltr">{formatUsd(product.officialPriceUsdUnits)}</bdi>
                  )}
                </TableCell>
                <TableCell>
                  {loadingSheets && product.priceUsdUnits === null ? (
                    <Skeleton className="h-5 w-16" aria-hidden="true" />
                  ) : (
                    <ProductPrice product={product} sheet={sheets.get(product.id)} />
                  )}
                </TableCell>
                <TableCell>
                  {loadingSheets ? (
                    <Skeleton className="h-10 w-28" aria-hidden="true" />
                  ) : (
                    <ListPrices
                      product={product}
                      sheet={sheets.get(product.id)}
                      lists={matrix.data?.lists ?? []}
                    />
                  )}
                </TableCell>
                <TableCell>
                  {loadingSheets && product.basisCostUsdUnits === null ? (
                    <Skeleton className="h-5 w-16" aria-hidden="true" />
                  ) : (
                    <ProductCost product={product} sheet={sheets.get(product.id)} />
                  )}
                </TableCell>
                <TableCell className="tabular-nums">{product.maxQuantity}</TableCell>
                <TableCell>
                  <StatusBadge status={product.status} />
                </TableCell>
                <TableCell>
                  <span className="flex flex-col items-start gap-1">
                    <AvailabilityBadge availability={product.availability} />
                    {product.reviewOpen && (
                      <Badge tone="warning">{t('catalog.products.reviewOpen')}</Badge>
                    )}
                    {product.waitingAlerts > 0 && (
                      <Badge tone="info">
                        {t('catalog.products.waitingAlerts', { count: product.waitingAlerts })}
                      </Badge>
                    )}
                  </span>
                </TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">
                  <span className="flex flex-col items-start gap-1">
                    {product.deliveryStats ? (
                      t('catalog.products.deliveryTime', {
                        median: formatDuration(product.deliveryStats.medianMs),
                        p90: formatDuration(product.deliveryStats.p90Ms),
                      })
                    ) : (
                      <span className="text-muted-foreground">
                        {t('catalog.products.noDeliveryData')}
                      </span>
                    )}
                    <Link
                      to="/orders"
                      search={{ productId: product.id }}
                      className="text-sm text-primary underline-offset-4 hover:underline"
                    >
                      {t('catalog.products.orders')}
                    </Link>
                  </span>
                </TableCell>
                <TableCell>
                  <fieldset
                    aria-label={product.nameAr}
                    className="m-0 min-w-0 border-0 p-0 flex items-center justify-end gap-1"
                  >
                    {archived ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          run(() => archive.mutateAsync({ id: product.id, archive: false }))
                        }
                      >
                        {t('catalog.actions.restore')}
                      </Button>
                    ) : (
                      <>
                        <MoveButton
                          label={t('catalog.order.up', { name: product.nameAr })}
                          disabled={busy}
                          onClick={index > 0 ? () => move(index, -1) : undefined}
                        >
                          <ArrowUpIcon />
                        </MoveButton>
                        <MoveButton
                          label={t('catalog.order.down', { name: product.nameAr })}
                          disabled={busy}
                          onClick={index < live.length - 1 ? () => move(index, 1) : undefined}
                        >
                          <ArrowDownIcon />
                        </MoveButton>
                        <Button variant="outline" size="sm" onClick={() => setEditing(product)}>
                          {t('catalog.actions.edit')}
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => setRouting(product.id)}>
                          <RouteIcon />
                          {t('catalog.products.routes')}
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => setLinking(product)}>
                          <LinkIcon />
                          {t('catalog.quickLink.open')}
                        </Button>
                        {/* S16: a purchase from the panel, this pack preset. */}
                        <Button
                          variant="outline"
                          size="sm"
                          render={
                            <Link
                              to="/orders/new"
                              search={{ gameId: product.gameId, productId: product.id }}
                            />
                          }
                        >
                          <ShoppingCartIcon />
                          {t('catalog.products.buy')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() =>
                            run(() =>
                              update.mutateAsync({
                                id: product.id,
                                body: { status: product.status === 'active' ? 'paused' : 'active' },
                              }),
                            )
                          }
                        >
                          {product.status === 'active'
                            ? t('catalog.actions.pause')
                            : t('catalog.actions.resume')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => setArchiving(product)}
                        >
                          {t('catalog.actions.archive')}
                        </Button>
                      </>
                    )}
                  </fieldset>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <RoutesDrawer
        game={game}
        product={game.products.find((product) => product.id === routing) ?? null}
        onClose={() => setRouting(null)}
      />
      <Dialog open={linking !== null} onOpenChange={(open) => !open && setLinking(null)}>
        {linking !== null && <QuickLinkDialog product={linking} />}
      </Dialog>
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        {editing !== null && (
          <ProductDialog
            gameId={game.id}
            product={editing === 'new' ? null : editing}
            onDone={() => setEditing(null)}
          />
        )}
      </Dialog>
      <ConfirmDialog
        open={archiving !== null}
        onClose={() => setArchiving(null)}
        title={t('catalog.products.archiveTitle')}
        body={t('catalog.products.archiveBody', { name: archiving?.nameAr ?? '' })}
        action={t('catalog.actions.archive')}
        destructive
        pending={archive.isPending}
        describeFailure={(error) => catalogFailure(t, error)}
        onConfirm={async () => {
          if (archiving) await archive.mutateAsync({ id: archiving.id, archive: true });
        }}
      />
    </div>
  );
}

type PriceSheet = PriceMatrix['rows'][number];

/** The retail price, stored or (without a row) estimated by the matrix. */
function retailFigure(product: Product, sheet: PriceSheet | undefined) {
  if (product.priceUsdUnits !== null) return { price: product.priceUsdUnits, estimated: false };
  const cell = sheet?.cells.find((item) => item.priceListId === ROOT_PRICE_LIST_IDS.retail);
  const estimated = cell?.estimatedPriceUsdUnits ?? null;
  return estimated === null ? null : { price: estimated, estimated: true };
}

/** The basis route's cost, or with no usable route the cheapest route's cost as an estimate. */
function costFigure(product: Product, sheet: PriceSheet | undefined) {
  if (product.basisCostUsdUnits !== null) {
    return { cost: product.basisCostUsdUnits, estimate: null };
  }
  return sheet?.estimate ? { cost: sheet.estimate.costUsdUnits, estimate: sheet.estimate } : null;
}

function EstimatedBadge() {
  const { t } = useTranslation();
  return <Badge tone="neutral">{t('catalog.products.estimated')}</Badge>;
}

/** What a price leaves over the cost, in dollars and as a share of the price. */
function Profit({ price, cost }: { price: number; cost: number }) {
  const { t } = useTranslation();
  const profit = price - cost;
  return (
    <span
      className={cn(
        'text-xs tabular-nums',
        profit > 0 ? 'text-status-success-foreground' : 'text-destructive-text',
      )}
    >
      {t('catalog.products.profit', {
        amount: ltr(formatUsd(profit)),
        percent: ltr(`${marginPercent(profit, price)}%`),
      })}
    </span>
  );
}

/**
 * The unit cost and what the retail price leaves over it; with no usable route, the cheapest
 * route's cost, its supplier and why it cannot serve now.
 */
function ProductCost({ product, sheet }: { product: Product; sheet: PriceSheet | undefined }) {
  const { t } = useTranslation();
  const figure = costFigure(product, sheet);
  if (figure === null) return <span className="text-muted-foreground">—</span>;
  const retail = retailFigure(product, sheet);
  return (
    <span className="flex flex-col items-start gap-0.5">
      <span className="flex items-center gap-1.5">
        <bdi dir="ltr" className="font-medium tabular-nums">
          {formatUsd(figure.cost)}
        </bdi>
        {figure.estimate && <EstimatedBadge />}
      </span>
      {retail && <Profit price={retail.price} cost={figure.cost} />}
      {figure.estimate && (
        <>
          <span className="text-xs text-muted-foreground">
            {t('catalog.products.estimateSupplier', {
              supplier: t(`suppliers.names.${figure.estimate.supplierCode}`),
            })}
          </span>
          <UnusableReason reason={figure.estimate.reason} />
        </>
      )}
    </span>
  );
}

/**
 * Every price list but retail (S20): its stored price and the profit over the cost, or the price
 * it would take, marked as an estimate.
 */
function ListPrices({
  product,
  sheet,
  lists,
}: {
  product: Product;
  sheet: PriceSheet | undefined;
  lists: PriceMatrix['lists'];
}) {
  const cost = costFigure(product, sheet)?.cost ?? null;
  const rows = lists.filter((list) => list.id !== ROOT_PRICE_LIST_IDS.retail);
  if (!sheet || rows.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <dl className="m-0 grid grid-cols-[auto_auto] items-baseline gap-x-3 gap-y-1">
      {rows.map((list) => {
        const cell = sheet.cells.find((item) => item.priceListId === list.id);
        const stored = cell?.priceUsdUnits ?? null;
        const price = stored ?? cell?.estimatedPriceUsdUnits ?? null;
        return (
          <div key={list.id} className="contents">
            <dt className="text-xs text-muted-foreground">{list.name}</dt>
            <dd className="m-0 flex flex-col items-start gap-0.5">
              {price === null ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                <span className="flex items-center gap-1.5">
                  <bdi
                    dir="ltr"
                    className={cn(
                      'text-sm font-medium tabular-nums',
                      stored === null && 'text-muted-foreground',
                    )}
                  >
                    {formatUsd(price)}
                  </bdi>
                  {stored === null && <EstimatedBadge />}
                </span>
              )}
              {price !== null && cost !== null && <Profit price={price} cost={cost} />}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/**
 * The retail price (S07 rule P2) with its SYP display price and the supplier it follows (P1); a
 * pack never priced shows the price it would take, marked as an estimate.
 */
function ProductPrice({ product, sheet }: { product: Product; sheet: PriceSheet | undefined }) {
  const { t } = useTranslation();
  const retail = retailFigure(product, sheet);
  if (retail === null) {
    return <span className="text-sm text-muted-foreground">{t('catalog.products.noPrice')}</span>;
  }
  if (retail.estimated) {
    return (
      <span className="flex flex-col items-start gap-0.5">
        <span className="flex items-center gap-1.5">
          <bdi dir="ltr" className="font-medium tabular-nums text-muted-foreground">
            {formatUsd(retail.price)}
          </bdi>
          <EstimatedBadge />
        </span>
        <span className="text-xs text-muted-foreground">{t('catalog.products.estimatedHint')}</span>
      </span>
    );
  }
  return (
    <span className="flex flex-col items-start gap-0.5">
      <bdi dir="ltr" className="font-medium tabular-nums">
        {formatUsd(retail.price)}
      </bdi>
      {product.priceSypUnits !== null && (
        <span className="text-xs text-muted-foreground tabular-nums">
          {t('catalog.products.syp', { amount: formatSyp(product.priceSypUnits) })}
        </span>
      )}
      {product.basisSupplierNameAr && (
        <span className="text-xs text-muted-foreground">
          {t('catalog.products.basis', { supplier: product.basisSupplierNameAr })}
        </span>
      )}
      {product.priceHeld && (
        <span className="text-xs text-status-warning-foreground">
          {t('catalog.products.priceHeld')}
        </span>
      )}
      {product.basisStockLevel && <StockChip level={product.basisStockLevel} quiet />}
    </span>
  );
}
