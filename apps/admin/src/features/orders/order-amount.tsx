import { amountOfQuantity } from '@vertex-digital/contracts';

/** S25 AM6: an `amount` order reads as its face amount ("7,300 ل.س"), never a quantity. */
export function OrderAmount({
  product,
  quantity,
}: {
  product: { amountStep: number | null; amountUnitAr: string | null };
  quantity: number;
}) {
  return (
    <bdi>
      {amountOfQuantity(quantity, product.amountStep ?? undefined).toLocaleString('en-US')}{' '}
      {product.amountUnitAr}
    </bdi>
  );
}
