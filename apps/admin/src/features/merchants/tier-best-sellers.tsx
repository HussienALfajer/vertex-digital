import { useQueries, useQuery } from '@tanstack/react-query';
import { formatUsd, type TierBestSellers } from '@vertex-digital/contracts';
import {
  Badge,
  Button,
  Card,
  CardTitle,
  Dialog,
  EmptyState,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@vertex-digital/ui';
import { CircleAlertIcon, PinIcon, TrendingUpIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '../../lib/errors';
import { FixedPriceDialog } from '../pricing/fixed-price-dialog';
import { listRulesQuery, priceListQuery } from '../pricing/pricing.queries';
import { merchantTierBestSellersQuery } from './merchants.queries';
import { TierChip } from './tier-chip';

type Item = TierBestSellers['items'][number];

/**
 * S23 PX5: the 20 packs merchants bought most in 30 days with each tier's price and margin; "سعر
 * ثابت للماسي" opens S20's fixed price dialog on Diamond's list for the pack (its fallback and the
 * parent cap still apply). No cost reaches a merchant: this is the panel's.
 */
export function TierBestSellersCard() {
  const { t } = useTranslation();
  const sellers = useQuery(merchantTierBestSellersQuery);
  const [fixing, setFixing] = useState<Item | null>(null);
  const diamondListId = sellers.data?.diamondListId ?? null;
  return (
    <Card className="gap-4" data-testid="tier-best-sellers">
      <div className="flex flex-col gap-1">
        <CardTitle className="flex items-center gap-2">
          <TrendingUpIcon className="size-5" aria-hidden="true" />
          {t('merchants.tiers.bestSellers.title')}
        </CardTitle>
        <p className="text-sm text-muted-foreground">{t('merchants.tiers.bestSellers.subtitle')}</p>
      </div>
      {sellers.isPending && <Skeleton className="h-48 w-full" aria-hidden="true" />}
      {sellers.isError && (
        <EmptyState
          icon={<CircleAlertIcon />}
          title={errorMessage(t, sellers.error)}
          action={
            <Button variant="outline" onClick={() => sellers.refetch()}>
              {t('common.retry')}
            </Button>
          }
        />
      )}
      {sellers.data && sellers.data.items.length === 0 && (
        <EmptyState icon={<TrendingUpIcon />} title={t('merchants.tiers.bestSellers.empty')} />
      )}
      {sellers.data && sellers.data.items.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('merchants.tiers.bestSellers.pack')}</TableHead>
              <TableHead>{t('merchants.tiers.bestSellers.units')}</TableHead>
              <TableHead>{t('merchants.tiers.bestSellers.cost')}</TableHead>
              {sellers.data.items[0]?.tiers.map((cell) => (
                <TableHead key={cell.tier}>
                  <TierChip tier={cell.tier} />
                </TableHead>
              ))}
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sellers.data.items.map((item) => (
              <TableRow key={item.productId}>
                <TableCell className="min-w-40 whitespace-normal">
                  <span className="flex flex-col">
                    <span className="font-medium">{item.nameAr}</span>
                    <span className="text-sm text-muted-foreground">{item.gameNameAr}</span>
                  </span>
                </TableCell>
                <TableCell className="tabular-nums">{item.deliveredUnits}</TableCell>
                <TableCell className="tabular-nums">
                  {item.costUsdUnits === null ? '—' : formatUsd(item.costUsdUnits)}
                </TableCell>
                {item.tiers.map((cell) => (
                  <TableCell key={cell.tier} className="whitespace-nowrap tabular-nums">
                    {cell.priceUsdUnits === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span className="flex flex-col items-start gap-1">
                        <bdi dir="ltr">{formatUsd(cell.priceUsdUnits)}</bdi>
                        {cell.marginUsdUnits !== null && (
                          <span className="text-xs text-muted-foreground">
                            {t('merchants.tiers.bestSellers.margin', {
                              margin: formatUsd(cell.marginUsdUnits),
                            })}
                          </span>
                        )}
                        {cell.fixed && (
                          <Badge tone="info">{t('merchants.tiers.bestSellers.fixed')}</Badge>
                        )}
                      </span>
                    )}
                  </TableCell>
                ))}
                <TableCell>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={diamondListId === null}
                    onClick={() => setFixing(item)}
                  >
                    <PinIcon />
                    {t('merchants.tiers.bestSellers.fix')}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Dialog open={fixing !== null} onOpenChange={(open) => !open && setFixing(null)}>
        {fixing && diamondListId && (
          <DiamondFixedPrice listId={diamondListId} item={fixing} onDone={() => setFixing(null)} />
        )}
      </Dialog>
    </Card>
  );
}

/** S20's fixed price dialog on Diamond's list, with the list's chain and rules. */
function DiamondFixedPrice({
  listId,
  item,
  onDone,
}: {
  listId: string;
  item: Item;
  onDone: () => void;
}) {
  const list = useQuery(priceListQuery(listId));
  const chain = list.data?.chain ?? [];
  const rules = useQueries({ queries: chain.map((link) => listRulesQuery(link.id)) });
  if (!list.data || !rules.every((read) => read.isSuccess)) {
    return <Skeleton className="h-48 w-full" aria-hidden="true" />;
  }
  const diamond = item.tiers.find((cell) => cell.tier === 'diamond');
  return (
    <FixedPriceDialog
      listId={listId}
      chain={list.data.list.chain}
      rules={rules.flatMap((read) => read.data ?? [])}
      initial={{
        gameId: item.gameId,
        productId: item.productId,
        priceUsdUnits: diamond?.fixed ? diamond.priceUsdUnits : null,
      }}
      onDone={onDone}
    />
  );
}
