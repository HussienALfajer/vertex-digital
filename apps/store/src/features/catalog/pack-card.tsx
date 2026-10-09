import { formatSyp, formatUsd, type StoreProduct } from '@vertex-digital/contracts';
import { Badge } from '@vertex-digital/ui/components/badge';
import { ClockIcon } from 'lucide-react';
import { ltr } from '@/lib/format';
import { t } from '@/lib/i18n';
import { deliveryChipText } from './delivery';

/** Whether a pack can be bought: available, with a price (S06 CT9). */
export const packAvailable = (product: StoreProduct) =>
  product.available && product.priceUsdUnits !== null;

/**
 * What a pack card shows (rule SF2): the Arabic name and in-game amount, the USD price large, the
 * SYP after "≈" muted, the savings badge (S06 PR7) and the delivery chip (SF3); an unavailable
 * pack has no price (S06 CT9). Rendered on the server, so the money formatting never reaches the
 * game page's first load; `PackButton` makes it selectable.
 */
export function PackContent({ product }: { product: StoreProduct }) {
  const available = packAvailable(product);
  const delivery = available ? deliveryChipText(product.deliveryStats) : null;
  return (
    <>
      <span className="flex items-start justify-between gap-2">
        <bdi className="font-bold break-words">{product.nameAr}</bdi>
        {available && product.savings?.percent && (
          <Badge tone="success" className="shrink-0">
            {t('catalog.price.savings', { percent: ltr(`${product.savings.percent}%`) })}
          </Badge>
        )}
      </span>
      {available && product.priceUsdUnits !== null ? (
        <span className="flex flex-col">
          <bdi dir="ltr" className="text-xl font-bold tabular-nums">
            {formatUsd(product.priceUsdUnits)}
          </bdi>
          {product.priceSypUnits !== null && (
            <span className="text-sm text-muted-foreground tabular-nums">
              {t('catalog.price.syp', { amount: formatSyp(product.priceSypUnits) })}
            </span>
          )}
        </span>
      ) : (
        <span className="text-sm text-muted-foreground">{t('catalog.status.unavailable')}</span>
      )}
      {delivery && (
        <span className="mt-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          <ClockIcon className="size-3.5 shrink-0" aria-hidden="true" />
          {delivery}
        </span>
      )}
      {product.kind === 'code' && product.regionAr && (
        <span className="text-xs text-muted-foreground">
          {t('purchase.region')} {product.regionAr}
        </span>
      )}
    </>
  );
}
