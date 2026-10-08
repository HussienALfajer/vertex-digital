import type { PriceReviewStatus, ProductPrice, SupplierCode } from '@vertex-digital/contracts';
import { and, count, desc, eq, inArray, type SQL } from 'drizzle-orm';
import type { Database, Transaction } from '../client.js';
import {
  catalogGames,
  catalogProducts,
  priceReviews,
  productPrices,
  productRoutes,
  suppliers,
} from '../schema/index.js';
import type { ReviewRow } from './routing.js';

/*
 * Reads of stored prices and reviews with their product, game and supplier (S07 "Screens"),
 * shared here because they join the catalog's and the suppliers' tables.
 */

type Executor = Database | Transaction;

export interface ReviewListRow {
  review: ReviewRow;
  productNameAr: string;
  gameId: string;
  gameNameAr: string;
  supplierCode: SupplierCode;
  supplierNameAr: string;
}

const reviewColumns = {
  review: priceReviews,
  productNameAr: catalogProducts.nameAr,
  gameId: catalogGames.id,
  gameNameAr: catalogGames.nameAr,
  supplierCode: suppliers.code,
  supplierNameAr: suppliers.nameAr,
};

function reviewsQuery(db: Executor, where: SQL | undefined) {
  return db
    .select(reviewColumns)
    .from(priceReviews)
    .innerJoin(catalogProducts, eq(catalogProducts.id, priceReviews.productId))
    .innerJoin(catalogGames, eq(catalogGames.id, catalogProducts.gameId))
    .innerJoin(productRoutes, eq(productRoutes.id, priceReviews.routeId))
    .innerJoin(suppliers, eq(suppliers.id, productRoutes.supplierId))
    .where(where);
}

/** A page of reviews by status and supplier, oldest open first, newest decided first. */
export async function priceReviewPage(
  db: Executor,
  query: { status: PriceReviewStatus; supplier?: SupplierCode; page: number; pageSize: number },
): Promise<{ rows: ReviewListRow[]; total: number }> {
  const where = and(
    eq(priceReviews.status, query.status),
    query.supplier ? eq(suppliers.code, query.supplier) : undefined,
  );
  const [rows, [total]] = await Promise.all([
    reviewsQuery(db, where)
      .orderBy(
        query.status === 'open' ? priceReviews.createdAt : desc(priceReviews.decidedAt),
        priceReviews.id,
      )
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db
      .select({ total: count() })
      .from(priceReviews)
      .innerJoin(productRoutes, eq(productRoutes.id, priceReviews.routeId))
      .innerJoin(suppliers, eq(suppliers.id, productRoutes.supplierId))
      .where(where),
  ]);
  return { rows, total: total?.total ?? 0 };
}

/** Reviews by id, with their product, game and supplier. */
export function priceReviewsById(db: Executor, ids: readonly string[]): Promise<ReviewListRow[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return reviewsQuery(db, inArray(priceReviews.id, [...ids]));
}

/** A page of a product's stored prices, newest first, with each basis route's supplier. */
export async function productPricePage(
  db: Executor,
  productId: string,
  page: { page: number; pageSize: number },
): Promise<{ items: ProductPrice[]; total: number }> {
  const [rows, [total]] = await Promise.all([
    db
      .select({ price: productPrices, supplierCode: suppliers.code })
      .from(productPrices)
      .innerJoin(productRoutes, eq(productRoutes.id, productPrices.routeId))
      .innerJoin(suppliers, eq(suppliers.id, productRoutes.supplierId))
      .where(eq(productPrices.productId, productId))
      .orderBy(desc(productPrices.createdAt), desc(productPrices.id))
      .limit(page.pageSize)
      .offset((page.page - 1) * page.pageSize),
    db.select({ total: count() }).from(productPrices).where(eq(productPrices.productId, productId)),
  ]);
  return {
    items: rows.map(({ price, supplierCode }) => ({
      id: price.id,
      priceUsdUnits: price.priceUsdUnits,
      costUsdUnits: price.costUsdUnits,
      routeId: price.routeId,
      supplierCode,
      ruleId: price.ruleId,
      percentBp: price.percentBp,
      fixedUsdUnits: price.fixedUsdUnits,
      minMarginUsdUnits: price.minMarginUsdUnits,
      cause: price.cause,
      reviewId: price.reviewId,
      createdAt: price.createdAt.toISOString(),
    })),
    total: total?.total ?? 0,
  };
}
