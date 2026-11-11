import type { ShopProduct } from '@vertex-digital/contracts';
import { ClockIcon } from 'lucide-react';
import { deliveryChipText } from '@/features/catalog/delivery';
import { packAmountText } from '@/features/catalog/pack-amount';
import { ltr } from '@/lib/format';
import { t } from '@/lib/i18n';
import { ts } from './i18n';
import { ShopMoney } from './money';
import { shopPackSellable } from './pack-rules';

/**
 * A shop's pack card (S26 screens, PR4): the name and in-game amount, the selling price SYP first
 * and the USD after "≈", the delivery chip; "غير متوفر حالياً" for a pack not sold (out of stock,
 * below cost, a SYP price without a rate). Rendered on the server, so the money formatting stays
 * out of the page's first load.
 */
export function ShopPackContent({ product }: { product: ShopProduct }) {
  const sellable = shopPackSellable(product);
  const delivery = sellable ? deliveryChipText(product.deliveryStats) : null;
  const amount = packAmountText(product.nameAr, product.gameAmount);
  return (
    <>
      <bdi className="font-bold break-words">{product.nameAr}</bdi>
      {amount && (
        <span className="text-sm text-muted-foreground">
          {t('catalog.amount', { amount: ltr(amount) })}
        </span>
      )}
      {sellable && product.unitSellUsdUnits !== null ? (
        <ShopMoney usd={product.unitSellUsdUnits} syp={product.unitSellSypUnits} />
      ) : (
        <span className="text-sm text-muted-foreground">{ts('game.unavailable')}</span>
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
