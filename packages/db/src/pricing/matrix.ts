import {
  marginBasisPoints,
  matrixCellWarnings,
  PRICE_MATRIX_MAX_PRODUCTS,
  type PriceMatrix,
  type PriceMatrixCell,
  ROOT_PRICE_LIST_IDS,
} from '@vertex-digital/contracts';
import { and, asc, desc, eq, ilike, inArray, isNull, or } from 'drizzle-orm';
import { type Executor, readAll } from '../client.js';
import { catalogGames, catalogProducts, priceLists, productPrices } from '../schema/index.js';
import { listIsPriced, listPricingFacts, listTarget } from './reprice.js';
import { type PriceRow, productRoutingStates, type RoutingContext } from './routing.js';

/*
 * The product × list matrix of the panel (S20 screens): per product the basis cost, and per list
 * its current price, margin, source and availability (PO1), its fixed price, the target it would
 * take while a review holds every list (RP2), and its warnings. Reads only.
 */

const DEFAULT_COLUMNS = [ROOT_PRICE_LIST_IDS.wholesale, ROOT_PRICE_LIST_IDS.cost];

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (char) => `\\${char}`);

export async function priceMatrix(
  db: Executor,
  query: { gameId?: string; q?: string; listIds?: readonly string[]; warnings?: boolean },
  context: RoutingContext,
): Promise<PriceMatrix> {
  const wanted = [
    ROOT_PRICE_LIST_IDS.retail,
    ...(query.listIds ?? DEFAULT_COLUMNS).filter((id) => id !== ROOT_PRICE_LIST_IDS.retail),
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
            pattern
              ? or(ilike(catalogProducts.nameAr, pattern), ilike(catalogGames.nameAr, pattern))
              : undefined,
          ),
        )
        .orderBy(asc(catalogGames.nameAr), asc(catalogProducts.sortOrder), asc(catalogProducts.id))
        .limit(PRICE_MATRIX_MAX_PRODUCTS);
    },
  ]);
  const lists = wanted.flatMap((id) => listRows.filter((list) => list.id === id));
  const ids = products.map((product) => product.id);
  if (ids.length === 0) return { lists, rows: [] };
  const [states, facts, currentRows, ...listStates] = await readAll(db, [
    () => productRoutingStates(db, ids, context),
    () => listPricingFacts(db, ids),
    () =>
      db
        .selectDistinctOn([productPrices.productId, productPrices.priceListId])
        .from(productPrices)
        .where(inArray(productPrices.productId, ids))
        .orderBy(
          productPrices.productId,
          productPrices.priceListId,
          desc(productPrices.createdAt),
          desc(productPrices.id),
        ),
    ...lists
      .filter((list) => list.id !== ROOT_PRICE_LIST_IDS.retail)
      .map((list) => () => productRoutingStates(db, ids, context, list.id)),
  ]);
  const availabilityOf = new Map(
    lists
      .filter((list) => list.id !== ROOT_PRICE_LIST_IDS.retail)
      .map((list, index) => [list.id, listStates[index]] as const),
  );
  const currentOf = new Map<string, PriceRow>(
    currentRows.map((row) => [`${row.productId}:${row.priceListId}`, row]),
  );
  const rows: PriceMatrix['rows'] = [];
  for (const product of products) {
    const state = states.get(product.id);
    if (!state) continue;
    const cost = state.basis ? (state.basis.costUsdUnits as number) : null;
    const held = state.openReview !== null;
    const cells = lists.map((list): PriceMatrixCell => {
      const retail = list.id === ROOT_PRICE_LIST_IDS.retail;
      const current = currentOf.get(`${product.id}:${list.id}`) ?? null;
      const known = facts.lists.find((candidate) => candidate.id === list.id);
      const parentId = known?.parentListId ?? null;
      const parent = parentId ? (currentOf.get(`${product.id}:${parentId}`) ?? null) : null;
      const availability = retail
        ? state.availability
        : (availabilityOf.get(list.id)?.get(product.id)?.availability ?? 'out_of_stock');
      let target: number | null = null;
      if (held && state.targetPriceUsdUnits !== null) {
        if (retail) target = state.targetPriceUsdUnits;
        else if (known && listIsPriced(facts, known.chain)) {
          target =
            listTarget(facts, known.chain, state, {
              priceUsdUnits: state.targetPriceUsdUnits,
              minMarginUsdUnits: state.rule.values.minMarginUsdUnits,
              ruleId: state.rule.id,
              percentBp: state.rule.values.percentBp,
              fixedUsdUnits: state.rule.values.fixedUsdUnits,
            })?.priceUsdUnits ?? null;
        }
      }
      const price = current?.priceUsdUnits ?? null;
      const marginCost = cost ?? current?.costUsdUnits ?? null;
      const fixed = facts.fixedPrices.find(
        (candidate) => candidate.priceListId === list.id && candidate.productId === product.id,
      );
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
        warnings: matrixCellWarnings({
          source: current?.source ?? null,
          priceUsdUnits: price,
          parentPriceUsdUnits: parent?.priceUsdUnits ?? null,
          held,
          available: availability === 'available',
        }),
      };
    });
    if (query.warnings && cells.every((cell) => cell.warnings.length === 0)) continue;
    rows.push({
      productId: product.id,
      productNameAr: product.nameAr,
      gameId: product.gameId,
      gameNameAr: product.gameNameAr,
      costUsdUnits: cost,
      supplierCode: state.basis?.supplierCode ?? null,
      held,
      cells,
    });
  }
  return { lists, rows };
}
