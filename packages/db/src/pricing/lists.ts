import { ROOT_PRICE_LIST_IDS } from '@vertex-digital/contracts';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import type { Database, Executor, Transaction } from '../client.js';
import {
  catalogGames,
  catalogProducts,
  marginRules,
  priceListFixedPrices,
  priceLists,
  productPrices,
} from '../schema/index.js';

/*
 * S20 decision 2 (owner, 2026-10-20): the wholesale and cost lists' global rules. Not seeded by a
 * migration: the release before S20 reads every live rule and the newest price row of any list,
 * so these rules, and the list rows they bring, arrive only once that release can no longer come
 * back (`pricing:reprice-lists` after a healthy deploy, RP4; `db:seed-local`; the tests' setup).
 */
const ROOT_LIST_RULES = [
  {
    id: '01a15a8c-b312-75f3-92d2-6da2e25d2df8',
    priceListId: ROOT_PRICE_LIST_IDS.wholesale,
    percentBp: 500,
    fixedUsdUnits: 0,
    minMarginUsdUnits: 50_000,
  },
  {
    id: '01a15a8c-b312-75f3-92d2-72570354506e',
    priceListId: ROOT_PRICE_LIST_IDS.cost,
    percentBp: 100,
    fixedUsdUnits: 0,
    minMarginUsdUnits: 10_000,
  },
] as const;

/**
 * Adds the wholesale and cost global rules with their fixed ids; a list that already has a live
 * global rule keeps it. Idempotent. Returns how many it added.
 */
export async function seedRootListRules(db: Database | Transaction): Promise<number> {
  const added = await db
    .insert(marginRules)
    .values(ROOT_LIST_RULES.map((rule) => ({ ...rule, scope: 'global' as const, targetId: null })))
    .onConflictDoNothing()
    .returning({ id: marginRules.id });
  return added.length;
}

/**
 * S20 LP1, RP5: the live fixed prices whose list's newest row for the product fell back to the
 * rule (`fixed_fallback`), with what the panel and the Telegram notice show. Unarchived lists
 * only (an archive archives its fixed prices).
 */
export function fixedPriceFallbacks(db: Executor) {
  const newest = db
    .selectDistinctOn([productPrices.productId, productPrices.priceListId], {
      productId: productPrices.productId,
      priceListId: productPrices.priceListId,
      source: productPrices.source,
      fixedPriceId: productPrices.fixedPriceId,
      priceUsdUnits: productPrices.priceUsdUnits,
      costUsdUnits: productPrices.costUsdUnits,
    })
    .from(productPrices)
    .innerJoin(
      priceListFixedPrices,
      and(
        eq(priceListFixedPrices.productId, productPrices.productId),
        eq(priceListFixedPrices.priceListId, productPrices.priceListId),
        isNull(priceListFixedPrices.archivedAt),
      ),
    )
    .orderBy(
      productPrices.productId,
      productPrices.priceListId,
      desc(productPrices.createdAt),
      desc(productPrices.id),
    )
    .as('newest');
  return db
    .select({
      priceListId: priceLists.id,
      priceListName: priceLists.name,
      productId: catalogProducts.id,
      productNameAr: catalogProducts.nameAr,
      gameNameAr: catalogGames.nameAr,
      costUsdUnits: newest.costUsdUnits,
      fixedPriceUsdUnits: priceListFixedPrices.priceUsdUnits,
      priceUsdUnits: newest.priceUsdUnits,
    })
    .from(newest)
    .innerJoin(priceListFixedPrices, eq(priceListFixedPrices.id, newest.fixedPriceId))
    .innerJoin(priceLists, eq(priceLists.id, newest.priceListId))
    .innerJoin(catalogProducts, eq(catalogProducts.id, newest.productId))
    .innerJoin(catalogGames, eq(catalogGames.id, catalogProducts.gameId))
    .where(
      and(
        eq(newest.source, 'fixed_fallback'),
        isNull(priceLists.archivedAt),
        isNull(priceListFixedPrices.archivedAt),
      ),
    )
    .orderBy(asc(priceLists.name), asc(catalogProducts.id));
}

/** A list's live fixed prices (one product's when given) with their pack and game names. */
export function listFixedPrices(db: Executor, priceListId: string, productId?: string) {
  return db
    .select({
      fixed: priceListFixedPrices,
      productNameAr: catalogProducts.nameAr,
      gameId: catalogGames.id,
      gameNameAr: catalogGames.nameAr,
    })
    .from(priceListFixedPrices)
    .innerJoin(catalogProducts, eq(catalogProducts.id, priceListFixedPrices.productId))
    .innerJoin(catalogGames, eq(catalogGames.id, catalogProducts.gameId))
    .where(
      and(
        eq(priceListFixedPrices.priceListId, priceListId),
        isNull(priceListFixedPrices.archivedAt),
        productId ? eq(priceListFixedPrices.productId, productId) : undefined,
      ),
    )
    .orderBy(asc(catalogGames.nameAr), asc(catalogProducts.sortOrder));
}
