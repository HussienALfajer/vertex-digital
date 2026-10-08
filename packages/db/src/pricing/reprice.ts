import {
  costChangeBasisPoints,
  needsReview,
  type PriceChangeCause,
} from '@vertex-digital/contracts';
import { asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Transaction } from '../client.js';
import { newId } from '../id.js';
import {
  catalogGames,
  catalogProducts,
  priceReviews,
  productPrices,
  productRoutes,
} from '../schema/index.js';
import {
  currentSupplierPolicy,
  type PriceRow,
  type ProductRoutingState,
  productRoutingStates,
  type RoutingContext,
} from './routing.js';

/*
 * The repricing write path (S07 rules P2–P5, ADR 0021), the only writer of `product_prices` and of
 * open reviews' figures, shared by the API (routes, imports, rule changes, decisions) and the
 * worker (sync, health, balances). Every price is computed from fresh facts under the product
 * locks, so parallel repricings of one product serialize and each sees the other's result.
 */

/**
 * Causes whose cost change on the price's own route is reviewed (rule P3, edge case 7): a sync,
 * and a route coming back usable or a rule change that meets a cost a sync moved while the route
 * was unusable. Decisions on a review are not; neither is an admin's manual cost (rule RT7).
 */
const REVIEWED_CAUSES: ReadonlySet<PriceChangeCause> = new Set([
  'cost_sync',
  'route_change',
  'rule_change',
]);

export interface RepriceResult {
  /** Products that got a new `product_prices` row. */
  repriced: number;
  reviewsOpened: number;
}

/**
 * Locks the products for repricing: their games `FOR SHARE`, then the products `FOR UPDATE`, each
 * in id order. A catalog change locks its game first (S06), so the two never wait on each other in
 * opposite orders. Returns the ids that exist.
 */
export async function lockProductsForPricing(
  tx: Transaction,
  productIds: readonly string[],
): Promise<string[]> {
  if (productIds.length === 0) return [];
  const ids = [...new Set(productIds)];
  await tx
    .select({ id: catalogGames.id })
    .from(catalogGames)
    .where(
      inArray(
        catalogGames.id,
        tx
          .select({ gameId: catalogProducts.gameId })
          .from(catalogProducts)
          .where(inArray(catalogProducts.id, ids)),
      ),
    )
    .orderBy(asc(catalogGames.id))
    .for('share');
  const rows = await tx
    .select({ id: catalogProducts.id })
    .from(catalogProducts)
    .where(inArray(catalogProducts.id, ids))
    .orderBy(asc(catalogProducts.id))
    .for('update');
  return rows.map((row) => row.id);
}

/** Appends the product's price at its target (rule P1) with the cause; the caller holds the lock. */
export async function appendProductPrice(
  tx: Transaction,
  state: ProductRoutingState,
  cause: PriceChangeCause,
  reviewId: string | null = null,
): Promise<PriceRow> {
  const { basis, targetPriceUsdUnits: price } = state;
  if (!basis || price === null) throw new Error(`Product ${state.productId} has no usable route`);
  const [row] = await tx
    .insert(productPrices)
    .values({
      id: newId(),
      productId: state.productId,
      priceUsdUnits: price,
      costUsdUnits: basis.costUsdUnits as number,
      routeId: basis.id,
      ruleId: state.rule.id,
      ...state.rule.values,
      cause,
      reviewId,
    })
    .returning();
  return row as PriceRow;
}

/**
 * Rule P2 for the given products, in the caller's transaction: locks them, computes each target
 * from fresh facts, then
 * - no usable route: nothing (the last price stays; the product is unavailable, P6);
 * - an open review: the price stays, the review's figures follow the target (P2, P5);
 * - the target is the current price on the same basis route: nothing;
 * - the basis route's own cost moved beyond the threshold since the price (P3, edge case 7), not
 *   by the admin's manual cost (RT7): a review opens, the price stays;
 * - otherwise a price row is appended. A cost change seen through another basis route is a
 *   `route_change` (ADR 0021: route changes reprice at once).
 */
export async function repriceProducts(
  tx: Transaction,
  input: { productIds: readonly string[]; cause: PriceChangeCause; context: RoutingContext },
): Promise<RepriceResult> {
  const result: RepriceResult = { repriced: 0, reviewsOpened: 0 };
  const ids = await lockProductsForPricing(tx, input.productIds);
  if (ids.length === 0) return result;
  const [states, policy] = await Promise.all([
    productRoutingStates(tx, ids, input.context),
    currentSupplierPolicy(tx),
  ]);
  for (const id of ids) {
    const state = states.get(id);
    const target = state?.targetPriceUsdUnits ?? null;
    if (!state?.basis || target === null) continue;
    const { basis, current, openReview } = state;
    const cost = basis.costUsdUnits as number;
    if (openReview) {
      const changed =
        openReview.routeId !== basis.id ||
        openReview.costAfterUsdUnits !== cost ||
        openReview.proposedPriceUsdUnits !== target;
      if (changed) {
        await tx
          .update(priceReviews)
          .set({
            routeId: basis.id,
            costAfterUsdUnits: cost,
            changeBp: costChangeBasisPoints(openReview.costBeforeUsdUnits, cost),
            proposedPriceUsdUnits: target,
          })
          .where(eq(priceReviews.id, openReview.id));
      }
      continue;
    }
    const sameRoute = current?.routeId === basis.id;
    if (current && sameRoute && current.priceUsdUnits === target) continue;
    if (
      current &&
      sameRoute &&
      REVIEWED_CAUSES.has(input.cause) &&
      basis.supplierCode !== 'manual' &&
      needsReview(current.costUsdUnits, cost, policy.priceReviewThresholdBp)
    ) {
      await tx.insert(priceReviews).values({
        id: newId(),
        productId: id,
        routeId: basis.id,
        costBeforeUsdUnits: current.costUsdUnits,
        costAfterUsdUnits: cost,
        changeBp: costChangeBasisPoints(current.costUsdUnits, cost),
        priceBeforeUsdUnits: current.priceUsdUnits,
        proposedPriceUsdUnits: target,
      });
      result.reviewsOpened += 1;
      continue;
    }
    const cause =
      current && !sameRoute && input.cause === 'cost_sync' ? 'route_change' : input.cause;
    await appendProductPrice(tx, state, cause);
    result.repriced += 1;
  }
  return result;
}

/** Every product with an unarchived route, for a change that can move any of them (a policy). */
export async function routedProducts(tx: Transaction): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ productId: productRoutes.productId })
    .from(productRoutes)
    .where(isNull(productRoutes.archivedAt));
  return rows.map((row) => row.productId);
}
