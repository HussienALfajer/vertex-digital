import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { SupplierDetail, SupplierOffer } from '@vertex-digital/contracts';
import {
  Button,
  Card,
  CardTitle,
  EmptyState,
  Pagination,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@vertex-digital/ui';
import { PackageSearchIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormAlert } from '../../components/form-alert';
import { errorMessage } from '../../lib/errors';
import { OfferCost, OfferFields, OfferMarks, StockChip } from './offer-cells';
import { IgnoreButton } from './offers-tab';
import { LIST_PAGE_SIZE, offersQuery, useOfferIgnored } from './suppliers.queries';

/**
 * The packs of the selected category's subtree (S16 SF1): cost, original price and discount,
 * stock, fields, support, the mapped product, and per-pack ignore (SC6).
 */
export function CategoryPacks({
  supplier,
  categoryId,
  onClose,
}: {
  supplier: SupplierDetail;
  categoryId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const packs = useQuery(offersQuery(supplier.code, { categoryId, page }));
  const ignore = useOfferIgnored();
  const [failure, setFailure] = useState<string | null>(null);

  async function setIgnored(offer: SupplierOffer, ignored: boolean) {
    setFailure(null);
    try {
      await ignore.mutateAsync({ id: offer.id, ignored });
    } catch (error) {
      setFailure(errorMessage(t, error));
    }
  }

  return (
    <Card className="gap-4">
      <div className="flex items-center justify-between gap-3">
        <CardTitle>{t('suppliers.catalog.packs.title')}</CardTitle>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('suppliers.catalog.hidePacks')}
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>
      {failure && <FormAlert>{failure}</FormAlert>}
      {packs.isPending && <Skeleton className="h-48 w-full" aria-hidden="true" />}
      {packs.isError && (
        <div className="flex flex-col items-start gap-3">
          <FormAlert>{errorMessage(t, packs.error)}</FormAlert>
          <Button variant="outline" onClick={() => packs.refetch()}>
            {t('common.retry')}
          </Button>
        </div>
      )}
      {packs.isSuccess &&
        (packs.data.items.length === 0 ? (
          <EmptyState icon={<PackageSearchIcon />} title={t('suppliers.catalog.packs.empty')} />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('suppliers.offers.columns.name')}</TableHead>
                  <TableHead>{t('suppliers.offers.columns.cost')}</TableHead>
                  <TableHead>{t('suppliers.offers.columns.stock')}</TableHead>
                  <TableHead>{t('suppliers.offers.columns.fields')}</TableHead>
                  <TableHead>{t('suppliers.offers.columns.product')}</TableHead>
                  <TableHead>
                    <span className="sr-only">{t('suppliers.offers.columns.actions')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {packs.data.items.map((offer) => (
                  <TableRow key={offer.id}>
                    <TableCell>
                      <span className="flex flex-col gap-0.5">
                        <bdi className="font-medium">{offer.name}</bdi>
                        <bdi dir="ltr" className="text-xs text-muted-foreground">
                          {offer.offerId}
                        </bdi>
                        {offer.categoryPath.length > 0 && (
                          <bdi className="text-xs text-muted-foreground">
                            {offer.categoryPath.join(' › ')}
                          </bdi>
                        )}
                        <OfferMarks offer={offer} />
                      </span>
                    </TableCell>
                    <TableCell>
                      <OfferCost offer={offer} />
                    </TableCell>
                    <TableCell>
                      <StockChip level={offer.stockLevel} stock={offer.stock} />
                    </TableCell>
                    <TableCell>
                      <OfferFields offer={offer} />
                    </TableCell>
                    <TableCell>
                      {offer.mapped ? (
                        <Link
                          to="/catalog/games/$id"
                          params={{ id: offer.mapped.gameId }}
                          search={{ tab: 'products' }}
                          className="flex flex-col gap-0.5 hover:underline"
                        >
                          <bdi className="font-medium">{offer.mapped.productNameAr}</bdi>
                          <bdi className="text-xs text-muted-foreground">
                            {offer.mapped.gameNameAr}
                          </bdi>
                        </Link>
                      ) : (
                        <span className="text-sm text-muted-foreground">
                          {t('suppliers.offers.unmapped')}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {!offer.mapped && (
                        <IgnoreButton
                          offer={offer}
                          disabled={ignore.isPending}
                          onChange={(ignored) => setIgnored(offer, ignored)}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Pagination
              page={page}
              pageCount={Math.max(1, Math.ceil(packs.data.total / LIST_PAGE_SIZE))}
              onPageChange={setPage}
              summary={t('suppliers.offers.total', { total: packs.data.total })}
              previousLabel={t('common.previous')}
              nextLabel={t('common.next')}
            />
          </>
        ))}
    </Card>
  );
}
