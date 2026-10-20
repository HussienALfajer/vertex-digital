import {
  costChangeBasisPoints,
  listChain,
  listPrice,
  needsReview,
  type PriceChangeCause,
  ROOT_PRICE_LIST_IDS,
  resolveListEntry,
} from '@vertex-digital/contracts';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { readAll, type Transaction } from '../client.js';
import { newId } from '../id.js';
import {
  catalogGames,
  catalogProducts,
  marginRules,
  priceListFixedPrices,
  priceLists,
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
  ruleValues,
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
  // S20 RP4: the backfill and list changes never move retail past a review either.
  'list_change',
]);

export interface RepriceResult {
  /** Products that got a new retail `product_prices` row. */
  repriced: number;
  reviewsOpened: number;
  /** S20 RP1: rows appended on the other lists. */
  listRowsAppended: number;
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

/**
 * Appends the product's retail price at its target (rule P1, S20 LP1) with the cause; the caller
 * holds the lock. The other lists follow through `repriceListsAfterRetail`.
 */
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
      priceListId: ROOT_PRICE_LIST_IDS.retail,
      source: state.targetSource,
      fixedPriceId: state.targetFixedPriceId,
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

/** A product whose retail price is settled, for its other lists (S20 RP1). */
export interface SettledRetail {
  state: ProductRoutingState;
  /** The retail row in force after this change: appended now, or the current one. */
  retailRow: PriceRow;
}

/**
 * S20 RP1, LP1–LP4: prices every unarchived list but retail for products whose retail price is
 * settled (none under review), from the same basis route and cost, capped at the retail row. A
 * list's row is appended only when its price, source, basis route, rule id, rule values or fixed
 * price differ from its current row (Q21 per list). The caller holds the product locks.
 */
export async function repriceListsAfterRetail(
  tx: Transaction,
  settled: readonly SettledRetail[],
  cause: PriceChangeCause,
  reviewId: string | null = null,
): Promise<number> {
  const priced = settled.filter(({ state }) => state.basis !== null);
  if (priced.length === 0) return 0;
  const ids = priced.map(({ state }) => state.productId);
  const [lists, rules, fixedPrices, currentRows] = await readAll(tx, [
    () =>
      tx
        .select({ id: priceLists.id, parentListId: priceLists.parentListId })
        .from(priceLists)
        .where(isNull(priceLists.archivedAt))
        .orderBy(asc(priceLists.id)),
    () => tx.select().from(marginRules).where(isNull(marginRules.archivedAt)),
    () =>
      tx
        .select()
        .from(priceListFixedPrices)
        .where(
          and(
            inArray(priceListFixedPrices.productId, ids),
            isNull(priceListFixedPrices.archivedAt),
          ),
        ),
    () =>
      tx
        .selectDistinctOn([productPrices.productId, productPrices.priceListId])
        .from(productPrices)
        .where(inArray(productPrices.productId, ids))
        .orderBy(
          productPrices.productId,
          productPrices.priceListId,
          desc(productPrices.createdAt),
          desc(productPrices.id),
        ),
  ]);
  const chains = new Map(
    lists
      .filter((list) => list.id !== ROOT_PRICE_LIST_IDS.retail)
      .map((list) => [list.id, listChain(lists, list.id)]),
  );
  // Lists whose root has no global rule yet are not priced (`seedRootListRules`): until then the
  // database holds retail rows only, which the release before S20 reads correctly.
  const others = lists.filter((list) => {
    const root = chains.get(list.id)?.at(-1);
    return (
      root !== undefined &&
      rules.some((rule) => rule.priceListId === root && rule.scope === 'global')
    );
  });
  const currentOf = new Map(currentRows.map((row) => [`${row.productId}:${row.priceListId}`, row]));
  const rows: (typeof productPrices.$inferInsert)[] = [];
  for (const { state, retailRow } of priced) {
    const basis = state.basis as NonNullable<ProductRoutingState['basis']>;
    const cost = basis.costUsdUnits as number;
    for (const list of others) {
      const entry = resolveListEntry(
        chains.get(list.id) as string[],
        { rules, fixedPrices },
        { productId: state.productId, gameId: state.gameId, categoryId: state.categoryId },
      );
      const values = ruleValues(entry.rule);
      const price = listPrice(
        cost,
        { fixedPriceUsdUnits: entry.fixed?.priceUsdUnits ?? null, rule: values },
        {
          priceUsdUnits: retailRow.priceUsdUnits,
          minMarginUsdUnits: retailRow.minMarginUsdUnits,
        },
      );
      const capped = price.source === 'retail_cap';
      const row = {
        source: price.source,
        fixedPriceId: price.source === 'rule' || capped ? null : (entry.fixed?.id ?? null),
        priceUsdUnits: price.priceUsdUnits,
        routeId: basis.id,
        ruleId: capped ? retailRow.ruleId : entry.rule.id,
        percentBp: capped ? retailRow.percentBp : values.percentBp,
        fixedUsdUnits: capped ? retailRow.fixedUsdUnits : values.fixedUsdUnits,
        minMarginUsdUnits: price.minMarginUsdUnits,
      };
      const current = currentOf.get(`${state.productId}:${list.id}`);
      if (
        current &&
        current.source === row.source &&
        current.fixedPriceId === row.fixedPriceId &&
        current.priceUsdUnits === row.priceUsdUnits &&
        current.routeId === row.routeId &&
        current.ruleId === row.ruleId &&
        current.percentBp === row.percentBp &&
        current.fixedUsdUnits === row.fixedUsdUnits &&
        current.minMarginUsdUnits === row.minMarginUsdUnits
      ) {
        continue;
      }
      rows.push({
        id: newId(),
        productId: state.productId,
        priceListId: list.id,
        costUsdUnits: cost,
        ...row,
        cause:
          current && current.routeId !== basis.id && cause === 'cost_sync' ? 'route_change' : cause,
        reviewId,
      });
    }
  }
  if (rows.length > 0) await tx.insert(productPrices).values(rows);
  return rows.length;
}

/**
 * Rule P2 for the given products, in the caller's transaction: locks them, computes each target
 * from fresh facts, then
 * - no usable route: nothing (the last price stays; the product is unavailable, P6);
 * - an open review: the price stays, the review's figures follow the target (P2, P5);
 * - the target is the current price on the same basis route under the same rule values: nothing;
 * - the basis route's own cost moved beyond the threshold since the price (P3, edge case 7), not
 *   by the admin's manual cost (RT7): a review opens, the price stays;
 * - S19 RT10 (Q17): the basis moved from one automatic route to another and the price would move
 *   beyond the threshold: a review opens, the price stays. A move to or from a `manual` route
 *   (a fallback and its end) reprices at once (owner, 2026-10-20);
 * - otherwise a price row is appended. A cost change seen through another basis route is a
 *   `route_change` (ADR 0021: route changes reprice at once).
 */
export async function repriceProducts(
  tx: Transaction,
  input: { productIds: readonly string[]; cause: PriceChangeCause; context: RoutingContext },
): Promise<RepriceResult> {
  const result: RepriceResult = { repriced: 0, reviewsOpened: 0, listRowsAppended: 0 };
  const ids = await lockProductsForPricing(tx, input.productIds);
  if (ids.length === 0) return result;
  const [states, policy] = await readAll(tx, [
    () => productRoutingStates(tx, ids, input.context),
    () => currentSupplierPolicy(tx),
  ]);
  // S20 RP1, RP2: products whose retail price is settled; a held one keeps every list.
  const settled: SettledRetail[] = [];
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
    const fromManual =
      state.routes.find((route) => route.id === current?.routeId)?.supplierCode === 'manual';
    // Q21: the stored row names the governing rule and its values, which a purchase copies (its
    // minimum margin decides the profitable fallback routes), so a rule change writes a row even
    // when the price stays.
    const sameRule =
      current?.ruleId === state.rule.id &&
      current.percentBp === state.rule.values.percentBp &&
      current.fixedUsdUnits === state.rule.values.fixedUsdUnits &&
      current.minMarginUsdUnits === state.rule.values.minMarginUsdUnits &&
      current.source === state.targetSource &&
      current.fixedPriceId === state.targetFixedPriceId;
    if (current && sameRoute && sameRule && current.priceUsdUnits === target) {
      settled.push({ state, retailRow: current });
      continue;
    }
    const reviewed =
      current !== null &&
      REVIEWED_CAUSES.has(input.cause) &&
      basis.supplierCode !== 'manual' &&
      (sameRoute
        ? needsReview(current.costUsdUnits, cost, policy.priceReviewThresholdBp)
        : !fromManual && needsReview(current.priceUsdUnits, target, policy.priceReviewThresholdBp));
    if (current && reviewed) {
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
    settled.push({ state, retailRow: await appendProductPrice(tx, state, cause) });
    result.repriced += 1;
  }
  result.listRowsAppended = await repriceListsAfterRetail(tx, settled, input.cause);
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
