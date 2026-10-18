import { and, eq, isNull } from 'drizzle-orm';
import type { Transaction } from '../client.js';
import { repriceProducts } from '../pricing/reprice.js';
import type { RoutingContext } from '../pricing/routing.js';
import { productRoutes, supplierOffers } from '../schema/index.js';

/**
 * S17 rule WR8, in the transaction that fails the attempt: a first send refused as out of stock
 * marks a finite-stock offer (`stock` not null) out of stock, `stock = 0`, and reprices the
 * products its routes serve; the next sync writes the supplier's real values back. An offer with
 * unlimited stock is never marked. True when the offer was marked. No audit entry: a system stock
 * read, like a sync.
 */
export async function markOfferOutOfStock(
  tx: Transaction,
  offerId: string,
  context: RoutingContext,
): Promise<boolean> {
  const [offer] = await tx
    .select({ stock: supplierOffers.stock })
    .from(supplierOffers)
    .where(eq(supplierOffers.id, offerId))
    // Its key never changes: a route's foreign key check (`FOR KEY SHARE`) never waits on it.
    .for('no key update');
  if (!offer || offer.stock === null) return false;
  await tx
    .update(supplierOffers)
    .set({ inStock: false, stock: 0 })
    .where(eq(supplierOffers.id, offerId));
  const served = await tx
    .selectDistinct({ productId: productRoutes.productId })
    .from(productRoutes)
    .where(and(eq(productRoutes.offerId, offerId), isNull(productRoutes.archivedAt)));
  await repriceProducts(tx, {
    productIds: served.map((row) => row.productId),
    cause: 'route_change',
    context,
  });
  return true;
}
