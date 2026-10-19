import { SUPPLIER_COST_MAX_USD_UNITS } from '@vertex-digital/contracts';
import { and, eq, isNull } from 'drizzle-orm';
import type { Transaction } from '../client.js';
import { newId } from '../id.js';
import { repriceProducts } from '../pricing/reprice.js';
import type { RoutingContext } from '../pricing/routing.js';
import { productRoutes, supplierCostChanges, supplierOffers } from '../schema/index.js';

/**
 * S18 PQ3, CH3, in the caller's transaction: a unit cost read at purchase time (a quote before
 * the first send, or what the supplier charged) that differs from the offer's stored cost becomes
 * its cost, confirmed now, with a `supplier_cost_changes` row naming the attempt; the products
 * its routes serve are repriced as after a sync (cause `cost_sync`: a large change opens a review,
 * and the margin guard pauses what is no longer profitable). True when the cost changed. No audit
 * entry: a supplier's own figure, like a sync.
 */
export async function recordObservedCost(
  tx: Transaction,
  input: { offerId: string; unitCostUsdUnits: number; attemptId: string; context: RoutingContext },
): Promise<boolean> {
  const units = input.unitCostUsdUnits;
  if (!Number.isSafeInteger(units) || units < 1 || units > SUPPLIER_COST_MAX_USD_UNITS) {
    return false;
  }
  const [offer] = await tx
    .select({ costUsdUnits: supplierOffers.costUsdUnits })
    .from(supplierOffers)
    .where(eq(supplierOffers.id, input.offerId))
    // Its key never changes: a route's foreign key check (`FOR KEY SHARE`) never waits on it.
    .for('no key update');
  if (!offer || offer.costUsdUnits === units) return false;
  await tx
    .update(supplierOffers)
    .set({ costUsdUnits: units, costRaw: null, costConfirmedAt: input.context.now })
    .where(eq(supplierOffers.id, input.offerId));
  await tx.insert(supplierCostChanges).values({
    id: newId(),
    offerId: input.offerId,
    fromUsdUnits: offer.costUsdUnits,
    toUsdUnits: units,
    attemptId: input.attemptId,
  });
  const served = await tx
    .selectDistinct({ productId: productRoutes.productId })
    .from(productRoutes)
    .where(and(eq(productRoutes.offerId, input.offerId), isNull(productRoutes.archivedAt)));
  await repriceProducts(tx, {
    productIds: served.map((row) => row.productId),
    cause: 'cost_sync',
    context: input.context,
  });
  return true;
}
