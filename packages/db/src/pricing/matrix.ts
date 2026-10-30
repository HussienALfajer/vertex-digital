import {
  listPrice,
  marginBasisPoints,
  matrixCellWarnings,
  PRICE_MATRIX_MAX_LISTS,
  type PriceMatrix,
  type PriceMatrixCell,
  type PriceMatrixQuery,
  productAvailability,
  ROOT_PRICE_LIST_IDS,
  resolveListEntry,
  selectMatrixRows,
} from '@vertex-digital/contracts';
import { and, asc, desc, eq, ilike, inArray, isNull, or } from 'drizzle-orm';
import { type Executor, readAll } from '../client.js';
import { catalogGames, catalogProducts, priceLists, productPrices } from '../schema/index.js';
import {
  type ListPricingFacts,
  listPricingFacts,
  listTargets,
  type RetailFigures,
} from './reprice.js';
import {
  type ProductRoutingState,
  productRoutingStates,
  type RouteState,
  type RoutingContext,
  ruleValues,
} from './routing.js';

/*
 * The product × list matrix of the panel (S20 screens): per product the basis cost, and per list
 * its current price, margin, source and availability (PO1), its fixed price, the target it would
 * take while a review holds every list (RP2), and its warnings. Reads only. A list without a row
 * shows the price it would take, and a product with no usable route its cheapest known route's
 * cost and why it cannot serve, so a paused pack still shows its prices (display only). The whole
 * scope is read, so the chips' counts match the rows; `selectMatrixRows` filters and pages it.
 */

const DEFAULT_COLUMNS = [ROOT_PRICE_LIST_IDS.wholesale, ROOT_PRICE_LIST_IDS.cost];

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (char) => `\\${char}`);

export type MatrixScopeQuery = Pick<
  Partial<PriceMatrixQuery>,
  'gameId' | 'q' | 'categoryId' | 'listIds'
>;

/** The filtered, paged answer of a query, read once by `matrixScope` and selected here. */
export async function priceMatrix(
  db: Executor,
  query: Partial<PriceMatrixQuery>,
  context: RoutingContext,
): Promise<PriceMatrix> {
  const { lists, rows } = await matrixScope(db, query, context);
  return { lists, ...selectMatrixRows(rows, query) };
}

/** Every row of a scope; a wide scope is thousands, so callers bound how many run at once. */
export async function matrixScope(
  db: Executor,
  query: MatrixScopeQuery,
  context: RoutingContext,
): Promise<Pick<PriceMatrix, 'lists' | 'rows'>> {
  // Retail first, then at most the other columns the contract allows (audit A05-69).
  const wanted = [
    ROOT_PRICE_LIST_IDS.retail,
    ...(query.listIds ?? DEFAULT_COLUMNS)
      .filter((id) => id !== ROOT_PRICE_LIST_IDS.retail)
      .slice(0, PRICE_MATRIX_MAX_LISTS - 1),
  ];
  const [listRows, products] = await readAll(db, [
    () =>
      db
        .select({ id: priceLists.id, kind: priceLists.kind, name: priceLists.name })
        .from(priceLists)
        .where(and(inArray(priceLists.id, wanted), isNull(priceLists.archivedAt))),
    () => {
      const pattern = query.q ? `%${escapeLike(query.q)}%` : null;
      return db
        .select({
          id: catalogProducts.id,
          nameAr: catalogProducts.nameAr,
          gameId: catalogGames.id,
          gameNameAr: catalogGames.nameAr,
        })
        .from(catalogProducts)
        .innerJoin(catalogGames, eq(catalogGames.id, catalogProducts.gameId))
        .where(
          and(
            isNull(catalogProducts.archivedAt),
            isNull(catalogGames.archivedAt),
            query.gameId ? eq(catalogProducts.gameId, query.gameId) : undefined,
            query.categoryId ? eq(catalogGames.categoryId, query.categoryId) : undefined,
            pattern
              ? or(ilike(catalogProducts.nameAr, pattern), ilike(catalogGames.nameAr, pattern))
              : undefined,
          ),
        )
        .orderBy(asc(catalogGames.nameAr), asc(catalogProducts.sortOrder), asc(catalogProducts.id));
    },
  ]);
  const lists = wanted.flatMap((id) => listRows.filter((list) => list.id === id));
  const ids = products.map((product) => product.id);
  if (ids.length === 0) return { lists, rows: [] };
  // One read of the routes: each list's availability follows from its row (audit A05-70).
  const [states, facts, currentRows] = await readAll(db, [
    () => productRoutingStates(db, ids, context),
    () => listPricingFacts(db, ids),
    () =>
      db
        .selectDistinctOn([productPrices.productId, productPrices.priceListId], {
          productId: productPrices.productId,
          priceListId: productPrices.priceListId,
          priceUsdUnits: productPrices.priceUsdUnits,
          costUsdUnits: productPrices.costUsdUnits,
          source: productPrices.source,
          minMarginUsdUnits: productPrices.minMarginUsdUnits,
          ruleId: productPrices.ruleId,
          percentBp: productPrices.percentBp,
          fixedUsdUnits: productPrices.fixedUsdUnits,
        })
        .from(productPrices)
        .where(inArray(productPrices.productId, ids))
        .orderBy(
          productPrices.productId,
          productPrices.priceListId,
          desc(productPrices.createdAt),
          desc(productPrices.id),
        ),
  ]);
  const currentOf = new Map(currentRows.map((row) => [`${row.productId}:${row.priceListId}`, row]));
  const fixedOf = new Map(
    facts.fixedPrices.map((row) => [`${row.productId}:${row.priceListId}`, row]),
  );
  const rows: PriceMatrix['rows'] = [];
  for (const product of products) {
    const state = states.get(product.id);
    if (!state) continue;
    const cost = state.basis ? (state.basis.costUsdUnits as number) : null;
    // A held price (S17 WR4) keeps its row; an estimate is only for a product no route serves.
    const estimate = state.basis || state.priceHeld ? null : estimateRoute(state);
    const held = state.openReview !== null;
    const retailRow = currentOf.get(`${product.id}:${ROOT_PRICE_LIST_IDS.retail}`) ?? null;
    const retailEstimate = estimate ? estimatedRetail(state, facts, estimate) : null;
    // Every list's target while a review holds the product (RP2), and the price a list without a
    // row would take, each with the tier lists' parent cap (S23 PX2).
    const heldTargets =
      held && state.targetPriceUsdUnits !== null
        ? listTargets(facts, state, {
            priceUsdUnits: state.targetPriceUsdUnits,
            minMarginUsdUnits: state.rule.values.minMarginUsdUnits,
            ruleId: state.rule.id,
            percentBp: state.rule.values.percentBp,
            fixedUsdUnits: state.rule.values.fixedUsdUnits,
          })
        : null;
    const figures = retailRow ?? retailEstimate;
    const basis = state.basis ?? estimate;
    const estimates = figures && basis ? listTargets(facts, { ...state, basis }, figures) : null;
    const cells = lists.map((list): PriceMatrixCell => {
      const retail = list.id === ROOT_PRICE_LIST_IDS.retail;
      const current = currentOf.get(`${product.id}:${list.id}`) ?? null;
      const known = facts.lists.find((candidate) => candidate.id === list.id);
      const parentId = known?.parentListId ?? null;
      const parent = parentId ? (currentOf.get(`${product.id}:${parentId}`) ?? null) : null;
      const availability = retail
        ? state.availability
        : productAvailability({
            ...state.availabilityFacts,
            price: current && {
              priceUsdUnits: current.priceUsdUnits,
              minMarginUsdUnits: current.minMarginUsdUnits,
            },
          });
      let target: number | null = null;
      if (held && state.targetPriceUsdUnits !== null) {
        target = retail
          ? state.targetPriceUsdUnits
          : (heldTargets?.get(list.id)?.priceUsdUnits ?? null);
      }
      const price = current?.priceUsdUnits ?? null;
      let estimated: number | null = null;
      if (price === null) {
        estimated = retail
          ? (state.targetPriceUsdUnits ?? retailEstimate?.priceUsdUnits ?? null)
          : (estimates?.get(list.id)?.priceUsdUnits ?? null);
      }
      const marginCost = cost ?? current?.costUsdUnits ?? null;
      const fixed = fixedOf.get(`${product.id}:${list.id}`);
      return {
        priceListId: list.id,
        priceUsdUnits: price,
        source: current?.source ?? null,
        marginUsdUnits: price !== null && marginCost !== null ? price - marginCost : null,
        marginBp:
          price !== null && marginCost !== null ? marginBasisPoints(price, marginCost) : null,
        availability,
        targetPriceUsdUnits: target,
        fixedPriceUsdUnits: fixed?.priceUsdUnits ?? null,
        estimatedPriceUsdUnits: estimated,
        warnings: matrixCellWarnings({
          source: current?.source ?? null,
          priceUsdUnits: price,
          parentPriceUsdUnits: parent?.priceUsdUnits ?? null,
          held,
          available: availability === 'available',
        }),
      };
    });
    rows.push({
      productId: product.id,
      productNameAr: product.nameAr,
      gameId: product.gameId,
      gameNameAr: product.gameNameAr,
      costUsdUnits: cost,
      supplierCode: state.basis?.supplierCode ?? null,
      estimate: estimate
        ? {
            costUsdUnits: estimate.costUsdUnits as number,
            supplierCode: estimate.supplierCode,
            reason: estimate.unusableReason as NonNullable<RouteState['unusableReason']>,
          }
        : null,
      held,
      cells,
    });
  }
  return { lists, rows };
}

/** The cheapest enabled, unarchived, unusable route with a known cost. */
function estimateRoute(state: ProductRoutingState): RouteState | null {
  let cheapest: RouteState | null = null;
  for (const route of state.routes) {
    if (route.archivedAt !== null || !route.enabled || route.costUsdUnits === null) continue;
    if (route.unusableReason === null) continue;
    if (!cheapest || route.costUsdUnits < (cheapest.costUsdUnits as number)) cheapest = route;
  }
  return cheapest;
}

/** Retail's figures at an estimate's cost (LS4 with retail's fixed prices, LP1), for display. */
function estimatedRetail(
  state: ProductRoutingState,
  facts: ListPricingFacts,
  route: RouteState,
): RetailFigures {
  const entry = resolveListEntry([ROOT_PRICE_LIST_IDS.retail], facts, {
    productId: state.productId,
    gameId: state.gameId,
    categoryId: state.categoryId,
  });
  const values = ruleValues(entry.rule);
  const price = listPrice(
    route.costUsdUnits as number,
    { fixedPriceUsdUnits: entry.fixed?.priceUsdUnits ?? null, rule: values },
    null,
  );
  return {
    priceUsdUnits: price.priceUsdUnits,
    minMarginUsdUnits: price.minMarginUsdUnits,
    ruleId: entry.rule.id,
    percentBp: values.percentBp,
    fixedUsdUnits: values.fixedUsdUnits,
  };
}
