import { formatSyp, formatUsd, type GameDetail, type Product } from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
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
import { ArrowDownIcon, ArrowUpIcon, PackageIcon, PlusIcon, RouteIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { RoutesDrawer } from '../suppliers/routes-drawer';
import { useArchiveProduct, useReorderProducts, useUpdateProduct } from './catalog.queries';
import { AvailabilityBadge, catalogFailure, MoveButton, StatusBadge } from './catalog-parts';
import { moved } from './catalog-search';
import { ProductDialog } from './product-dialog';

/**
 * "الباقات" (S06 screens): the game's products in order (name, kind, in-game amount, official
 * price, max quantity, status, availability), add and edit by kind, pause and resume (rule CT4),
 * order (rule CT5), archive and restore with an archived filter (rule CT1). S07: the stored price
 * in USD and SYP, the supplier it follows, a held review, and each product's routes drawer.
 */
export function ProductsTab({ game }: { game: GameDetail }) {
  const { t } = useTranslation();
  const [archived, setArchived] = useState(false);
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const [routing, setRouting] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const reorder = useReorderProducts(game.id);
  const archive = useArchiveProduct();
  const update = useUpdateProduct();
  const products = game.products.filter((product) => (product.archivedAt !== null) === archived);
  const live = game.products.filter((product) => product.archivedAt === null);
  const busy = reorder.isPending || archive.isPending || update.isPending;

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
              <TableHead>{t('catalog.products.columns.maxQuantity')}</TableHead>
              <TableHead>{t('catalog.products.columns.status')}</TableHead>
              <TableHead>{t('catalog.products.columns.availability')}</TableHead>
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
                <TableCell className="tabular-nums">{product.gameAmount ?? '—'}</TableCell>
                <TableCell className="tabular-nums">
                  {product.officialPriceUsdUnits === null ? (
                    '—'
                  ) : (
                    <bdi dir="ltr">{formatUsd(product.officialPriceUsdUnits)}</bdi>
                  )}
                </TableCell>
                <TableCell>
                  <ProductPrice product={product} />
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
                  </span>
                </TableCell>
                <TableCell>
                  <span className="flex items-center justify-end gap-1">
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
                          onClick={() =>
                            run(() => archive.mutateAsync({ id: product.id, archive: true }))
                          }
                        >
                          {t('catalog.actions.archive')}
                        </Button>
                      </>
                    )}
                  </span>
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
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        {editing !== null && (
          <ProductDialog
            gameId={game.id}
            product={editing === 'new' ? null : editing}
            onDone={() => setEditing(null)}
          />
        )}
      </Dialog>
    </div>
  );
}

/** The stored price (S07 rule P2) with its SYP display price, and the supplier it follows (P1). */
function ProductPrice({ product }: { product: Product }) {
  const { t } = useTranslation();
  if (product.priceUsdUnits === null) {
    return <span className="text-sm text-muted-foreground">{t('catalog.products.noPrice')}</span>;
  }
  return (
    <span className="flex flex-col gap-0.5">
      <bdi dir="ltr" className="font-medium tabular-nums">
        {formatUsd(product.priceUsdUnits)}
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
    </span>
  );
}
