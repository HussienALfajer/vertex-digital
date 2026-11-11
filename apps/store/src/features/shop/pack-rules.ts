import type { ShopProduct } from '@vertex-digital/contracts';

/** PR3: a pack is sold when available with a selling price. Type-only import: no contracts code. */
export const shopPackSellable = (product: ShopProduct) =>
  product.available && product.unitSellUsdUnits !== null;
