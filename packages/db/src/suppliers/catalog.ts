import {
  type CategoryNodeFacts,
  type CategoryOfferFacts,
  type CategoryStanding,
  categoryStandings,
  type StockLevel,
  stockLevel,
} from '@vertex-digital/contracts';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../client.js';
import { currentSupplierPolicy } from '../pricing/routing.js';
import {
  catalogGames,
  catalogProducts,
  productRoutes,
  supplierCategories,
  supplierOffers,
} from '../schema/index.js';

/*
 * S16's supplier catalog reads shared by the API (the browser, the supplier cards) and the worker
 * (the low-stock step, the daily summary): a supplier's tree with rule SC5's standings, the count
 * of new offers (SC11), and the stock levels of mapped offers of active products (SF2).
 */

type Executor = Database | Transaction;

export type SupplierCategoryRow = typeof supplierCategories.$inferSelect;

/**
 * An offer has an unarchived route (S07 rule RT1). The outer row is named in full: in a select
 * list Drizzle writes a single table's columns unqualified, which the subquery would read as its
 * own.
 */
const offerMapped = sql<boolean>`exists (select 1 from ${productRoutes}
  where ${productRoutes.offerId} = "supplier_offers"."id" and ${productRoutes.archivedAt} is null)`;

/** A supplier's whole tree with each node's standing (rules SC4, SC5). */
export async function supplierCategoryTree(
  db: Executor,
  supplierId: string,
): Promise<{ rows: SupplierCategoryRow[]; standings: Map<string, CategoryStanding> }> {
  const [rows, offers] = await Promise.all([
    db.select().from(supplierCategories).where(eq(supplierCategories.supplierId, supplierId)),
    db
      .select({
        categoryId: supplierOffers.categoryId,
        mapped: offerMapped,
        ignored: sql<boolean>`${supplierOffers.ignoredAt} is not null`,
        supported: sql<boolean>`${supplierOffers.unsupportedReason} is null`,
        inStock: supplierOffers.inStock,
        missing: sql<boolean>`${supplierOffers.missingSince} is not null`,
      })
      .from(supplierOffers)
      .where(and(eq(supplierOffers.supplierId, supplierId), isNotNull(supplierOffers.categoryId))),
  ]);
  const nodes: CategoryNodeFacts[] = rows.map((row) => ({
    categoryId: row.categoryId,
    parentCategoryId: row.parentCategoryId,
    gameId: row.gameId,
    ignored: row.ignoredAt !== null,
  }));
  return { rows, standings: categoryStandings(nodes, offers as CategoryOfferFacts[]) };
}

/**
 * Rule SC11: per supplier, the offers counted new in imported categories: the new packs of every
 * node the tree holds no parent for (roots, and nodes whose parent the supplier no longer lists).
 */
export async function newOfferCounts(
  db: Executor,
  supplierIds: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const supplierId of supplierIds) {
    const { rows, standings } = await supplierCategoryTree(db, supplierId);
    const held = new Set(rows.map((row) => row.categoryId));
    let total = 0;
    for (const row of rows) {
      if (row.parentCategoryId !== null && held.has(row.parentCategoryId)) continue;
      total += standings.get(row.categoryId)?.newPacks ?? 0;
    }
    counts.set(supplierId, total);
  }
  return counts;
}

/** A mapped offer of an active product of an active game, with its stock level (rule SF2). */
export interface MappedStockOffer {
  id: string;
  supplierId: string;
  offerId: string;
  stock: number | null;
  inStock: boolean;
  stockAlert: StockLevel | null;
  level: StockLevel;
  productId: string;
  productNameAr: string;
  gameNameAr: string;
}

/**
 * Rule SF2: the offers an unarchived, enabled route maps to an `active`, unarchived product of an
 * `active`, unarchived game, still listed by the supplier, with their level at the policy's
 * threshold. Locked `FOR UPDATE` when `lock` is set (the sync's alert step).
 */
export async function mappedStockOffers(
  db: Executor,
  options: { supplierIds?: readonly string[]; lock?: boolean } = {},
): Promise<MappedStockOffer[]> {
  if (options.supplierIds?.length === 0) return [];
  const policy = await currentSupplierPolicy(db);
  const query = db
    .select({
      id: supplierOffers.id,
      supplierId: supplierOffers.supplierId,
      offerId: supplierOffers.offerId,
      stock: supplierOffers.stock,
      inStock: supplierOffers.inStock,
      stockAlert: supplierOffers.stockAlert,
      productId: catalogProducts.id,
      productNameAr: catalogProducts.nameAr,
      gameNameAr: catalogGames.nameAr,
    })
    .from(productRoutes)
    .innerJoin(supplierOffers, eq(supplierOffers.id, productRoutes.offerId))
    .innerJoin(catalogProducts, eq(catalogProducts.id, productRoutes.productId))
    .innerJoin(catalogGames, eq(catalogGames.id, catalogProducts.gameId))
    .where(
      and(
        isNull(productRoutes.archivedAt),
        eq(productRoutes.enabled, true),
        eq(catalogProducts.status, 'active'),
        isNull(catalogProducts.archivedAt),
        eq(catalogGames.status, 'active'),
        isNull(catalogGames.archivedAt),
        isNull(supplierOffers.missingSince),
        options.supplierIds
          ? inArray(supplierOffers.supplierId, [...options.supplierIds])
          : undefined,
      ),
    )
    .orderBy(supplierOffers.id);
  const rows = options.lock ? await query.for('update', { of: supplierOffers }) : await query;
  return rows.map((row) => ({
    ...row,
    level: stockLevel(row.stock, row.inStock, policy.lowStockUnits),
  }));
}

/** Rule SF2's counts per supplier: mapped offers of active products low and out of stock. */
export async function lowStockCounts(
  db: Executor,
  supplierIds?: readonly string[],
): Promise<Map<string, { low: number; out: number }>> {
  const counts = new Map<string, { low: number; out: number }>();
  for (const offer of await mappedStockOffers(db, supplierIds ? { supplierIds } : {})) {
    const count = counts.get(offer.supplierId) ?? { low: 0, out: 0 };
    if (offer.level === 'low') count.low += 1;
    if (offer.level === 'out') count.out += 1;
    counts.set(offer.supplierId, count);
  }
  return counts;
}
