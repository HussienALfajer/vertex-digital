import {
  ALERT_EVENTS_KEEP_DAYS,
  type AlertKind,
  orderTotal,
  type ProductAvailability,
  RECENT_PLAYERS_DAYS,
  RECENT_PLAYERS_PER_GAME,
  saleProfit,
  WATCH_SUGGESTION_DAYS,
} from '@vertex-digital/contracts';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { Executor } from '../client.js';
import { accountPriceList } from '../customers/price-lists.js';
import { productRoutingStates, type RoutingContext } from '../pricing/index.js';
import {
  catalogCategories,
  catalogGames,
  catalogProducts,
  merchantAlertEvents,
  merchantOrderSales,
  merchantWatches,
  orders,
} from '../schema/index.js';

/*
 * The merchant area's reads (S21 F30, F31, F37) over orders, the catalog and the merchant's own
 * rows. Every amount a merchant sees is on their effective list (MA2), read as the game page's
 * private prices are: available only with a row on that list.
 */

export interface MerchantListPrice {
  productId: string;
  availability: ProductAvailability;
  /** The list price when the pack can be bought, else null. */
  priceUsdUnits: number | null;
}

/** MA2: the merchant's own prices of products on their effective list. */
export async function merchantListPrices(
  db: Executor,
  customerId: string,
  productIds: readonly string[],
  context: RoutingContext,
): Promise<Map<string, MerchantListPrice>> {
  const prices = new Map<string, MerchantListPrice>();
  if (productIds.length === 0) return prices;
  const pricing = await accountPriceList(db, customerId);
  if (!pricing) return prices;
  const states = await productRoutingStates(db, productIds, context, pricing.effectiveList.id);
  for (const [productId, state] of states) {
    prices.set(productId, {
      productId,
      availability: state.availability,
      priceUsdUnits:
        state.availability === 'available' ? (state.current?.priceUsdUnits ?? null) : null,
    });
  }
  return prices;
}

/** The store's shown games (S09 SF1), category then game order. */
export function shownGames(db: Executor) {
  return db
    .select({ id: catalogGames.id, slug: catalogGames.slug, nameAr: catalogGames.nameAr })
    .from(catalogGames)
    .innerJoin(catalogCategories, eq(catalogCategories.id, catalogGames.categoryId))
    .where(
      and(
        eq(catalogGames.status, 'active'),
        isNull(catalogGames.archivedAt),
        isNull(catalogCategories.archivedAt),
      ),
    )
    .orderBy(
      asc(catalogCategories.sortOrder),
      asc(catalogCategories.createdAt),
      asc(catalogGames.sortOrder),
      asc(catalogGames.createdAt),
    );
}

/** A game's unarchived packs in the store's order (paused ones included). */
export function gameProducts(db: Executor, gameIds: readonly string[]) {
  if (gameIds.length === 0) return Promise.resolve([]);
  return db
    .select({
      id: catalogProducts.id,
      gameId: catalogProducts.gameId,
      nameAr: catalogProducts.nameAr,
      kind: catalogProducts.kind,
    })
    .from(catalogProducts)
    .where(and(inArray(catalogProducts.gameId, [...gameIds]), isNull(catalogProducts.archivedAt)))
    .orderBy(asc(catalogProducts.sortOrder), asc(catalogProducts.createdAt));
}

export interface DashboardFacts {
  salesUsdUnits: number;
  profitUsdUnits: number;
  ordersWithoutSale: number;
  topProducts: {
    productId: string;
    gameNameAr: string;
    nameAr: string;
    units: number;
    salesUsdUnits: number;
  }[];
}

/**
 * DB2, DB4, DB5: the merchant's orders that finished delivering in `[from, to)` (at least one unit
 * delivered), with their sale rows: sales and profit (SP6) of the orders with a sale, the count of
 * those without, and the products sold most.
 */
export async function dashboardFacts(
  db: Executor,
  customerId: string,
  from: Date,
  to: Date,
  topCount: number,
): Promise<DashboardFacts> {
  const rows = await db
    .select({
      productId: orders.productId,
      deliveredQuantity: orders.deliveredQuantity,
      unitPriceUsdUnits: orders.unitPriceUsdUnits,
      unitUsdUnits: merchantOrderSales.unitUsdUnits,
      nameAr: catalogProducts.nameAr,
      gameNameAr: catalogGames.nameAr,
    })
    .from(orders)
    .leftJoin(merchantOrderSales, eq(merchantOrderSales.orderId, orders.id))
    .innerJoin(catalogProducts, eq(catalogProducts.id, orders.productId))
    .innerJoin(catalogGames, eq(catalogGames.id, orders.gameId))
    .where(
      and(
        eq(orders.customerId, customerId),
        isNotNull(orders.finishedAt),
        gte(orders.finishedAt, from),
        lt(orders.finishedAt, to),
        sql`${orders.deliveredQuantity} > 0`,
      ),
    );
  let salesUsdUnits = 0;
  let profitUsdUnits = 0;
  let ordersWithoutSale = 0;
  const byProduct = new Map<string, DashboardFacts['topProducts'][number]>();
  for (const row of rows) {
    const sale = row.unitUsdUnits === null ? null : { unitUsdUnits: row.unitUsdUnits };
    const profit = saleProfit(row, sale);
    const sales = sale === null ? 0 : orderTotal(sale.unitUsdUnits, row.deliveredQuantity);
    if (profit === null) ordersWithoutSale += 1;
    else {
      salesUsdUnits += sales;
      profitUsdUnits += profit;
    }
    const top = byProduct.get(row.productId) ?? {
      productId: row.productId,
      gameNameAr: row.gameNameAr,
      nameAr: row.nameAr,
      units: 0,
      salesUsdUnits: 0,
    };
    top.units += row.deliveredQuantity;
    top.salesUsdUnits += sales;
    byProduct.set(row.productId, top);
  }
  const topProducts = [...byProduct.values()]
    .sort((a, b) => b.units - a.units || b.salesUsdUnits - a.salesUsdUnits)
    .slice(0, topCount);
  return { salesUsdUnits, profitUsdUnits, ordersWithoutSale, topProducts };
}

export interface WatchedRows {
  games: { gameId: string; nameAr: string }[];
  products: { productId: string; gameId: string; gameNameAr: string; nameAr: string }[];
}

/** AL1: the merchant's follows, games and products in the store's order. */
export async function merchantWatchRows(db: Executor, customerId: string): Promise<WatchedRows> {
  const games = await db
    .select({ gameId: catalogGames.id, nameAr: catalogGames.nameAr })
    .from(merchantWatches)
    .innerJoin(catalogGames, eq(catalogGames.id, merchantWatches.gameId))
    .where(eq(merchantWatches.customerId, customerId))
    .orderBy(asc(catalogGames.sortOrder), asc(catalogGames.id));
  const products = await db
    .select({
      productId: catalogProducts.id,
      gameId: catalogGames.id,
      gameNameAr: catalogGames.nameAr,
      nameAr: catalogProducts.nameAr,
    })
    .from(merchantWatches)
    .innerJoin(catalogProducts, eq(catalogProducts.id, merchantWatches.productId))
    .innerJoin(catalogGames, eq(catalogGames.id, catalogProducts.gameId))
    .where(eq(merchantWatches.customerId, customerId))
    .orderBy(asc(catalogGames.sortOrder), asc(catalogProducts.sortOrder), asc(catalogProducts.id));
  return { games, products };
}

/**
 * AL1: suggestions not followed yet: the unarchived products the merchant bought in the last 30
 * days, and the games of their followed products.
 */
export async function watchSuggestions(
  db: Executor,
  customerId: string,
  followed: WatchedRows,
): Promise<WatchedRows> {
  const since = sql`now() - ${`${WATCH_SUGGESTION_DAYS} days`}::interval`;
  const bought = await db
    .selectDistinct({
      productId: catalogProducts.id,
      gameId: catalogGames.id,
      gameNameAr: catalogGames.nameAr,
      nameAr: catalogProducts.nameAr,
    })
    .from(orders)
    .innerJoin(catalogProducts, eq(catalogProducts.id, orders.productId))
    .innerJoin(catalogGames, eq(catalogGames.id, catalogProducts.gameId))
    .where(
      and(
        eq(orders.customerId, customerId),
        gte(orders.createdAt, since),
        isNull(catalogProducts.archivedAt),
        isNull(catalogGames.archivedAt),
      ),
    );
  const followedProducts = new Set(followed.products.map((row) => row.productId));
  const followedGames = new Set(followed.games.map((row) => row.gameId));
  const games = new Map<string, { gameId: string; nameAr: string }>();
  for (const row of followed.products) {
    if (!followedGames.has(row.gameId)) {
      games.set(row.gameId, { gameId: row.gameId, nameAr: row.gameNameAr });
    }
  }
  return {
    games: [...games.values()],
    products: bought.filter(
      (row) => !followedProducts.has(row.productId) && !followedGames.has(row.gameId),
    ),
  };
}

/**
 * AL2: the products a merchant follows now: followed products and the unarchived products of
 * followed games, both of unarchived games.
 */
export async function watchedProductIds(db: Executor, customerId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: catalogProducts.id })
    .from(merchantWatches)
    .innerJoin(
      catalogProducts,
      or(
        eq(catalogProducts.id, merchantWatches.productId),
        eq(catalogProducts.gameId, merchantWatches.gameId),
      ),
    )
    .innerJoin(catalogGames, eq(catalogGames.id, catalogProducts.gameId))
    .where(
      and(
        eq(merchantWatches.customerId, customerId),
        isNull(catalogProducts.archivedAt),
        isNull(catalogGames.archivedAt),
      ),
    )
    .orderBy(asc(catalogProducts.id));
  return rows.map((row) => row.id);
}

export interface AlertEventRow {
  id: string;
  productId: string;
  gameNameAr: string;
  productNameAr: string;
  kind: AlertKind;
  oldPriceUsdUnits: number | null;
  newPriceUsdUnits: number | null;
  createdAt: Date;
  /** The time as PostgreSQL prints it, for the cursor (microseconds). */
  cursorAt: string;
}

/** `GET /api/merchant/alerts` and AL4: the merchant's events since `since`, newest first. */
export async function alertEvents(
  db: Executor,
  customerId: string,
  input: { since?: Date; after?: { at: string; id: string } | null; limit: number },
): Promise<AlertEventRow[]> {
  const since = input.since ?? new Date(Date.now() - ALERT_EVENTS_KEEP_DAYS * 24 * 60 * 60 * 1000);
  return db
    .select({
      id: merchantAlertEvents.id,
      productId: merchantAlertEvents.productId,
      gameNameAr: catalogGames.nameAr,
      productNameAr: catalogProducts.nameAr,
      kind: merchantAlertEvents.kind,
      oldPriceUsdUnits: merchantAlertEvents.oldPriceUsdUnits,
      newPriceUsdUnits: merchantAlertEvents.newPriceUsdUnits,
      createdAt: merchantAlertEvents.createdAt,
      cursorAt: sql<string>`${merchantAlertEvents.createdAt}::text`,
    })
    .from(merchantAlertEvents)
    .innerJoin(catalogProducts, eq(catalogProducts.id, merchantAlertEvents.productId))
    .innerJoin(catalogGames, eq(catalogGames.id, catalogProducts.gameId))
    .where(
      and(
        eq(merchantAlertEvents.customerId, customerId),
        gte(merchantAlertEvents.createdAt, since),
        input.after
          ? sql`(${merchantAlertEvents.createdAt}, ${merchantAlertEvents.id}) < (${input.after.at}::timestamptz, ${input.after.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(merchantAlertEvents.createdAt), desc(merchantAlertEvents.id))
    .limit(input.limit);
}

/** The unarchived products among `ids` of unarchived games, with their game. */
export async function liveProducts(db: Executor, ids: readonly string[]) {
  if (ids.length === 0) return [];
  return db
    .select({ id: catalogProducts.id, gameId: catalogProducts.gameId })
    .from(catalogProducts)
    .innerJoin(catalogGames, eq(catalogGames.id, catalogProducts.gameId))
    .where(
      and(
        inArray(catalogProducts.id, [...ids]),
        isNull(catalogProducts.archivedAt),
        isNull(catalogGames.archivedAt),
      ),
    );
}

/** The unarchived games among `ids`. */
export async function liveGames(db: Executor, ids: readonly string[]) {
  if (ids.length === 0) return [];
  return db
    .select({ id: catalogGames.id })
    .from(catalogGames)
    .where(and(inArray(catalogGames.id, [...ids]), isNull(catalogGames.archivedAt)));
}

/**
 * PS2: the last 20 distinct field sets of the merchant's orders for the game in the last 90 days,
 * newest first, each with the name of its newest validated order. Computed on read, never stored.
 */
export async function recentPlayers(
  db: Executor,
  customerId: string,
  gameId: string,
): Promise<{ fields: Record<string, string>; playerName: string | null; lastUsedAt: Date }[]> {
  const result = await db.execute<{
    fields: Record<string, string>;
    player_name: string | null;
    last_used_at: string;
  }>(sql`
    select used.fields, used.last_used_at,
      (select named.player_name from ${orders} as named
        where named.customer_id = ${customerId} and named.game_id = ${gameId}
          and named.fields = used.fields and named.player_check = 'valid'
          and named.player_name is not null
        order by named.created_at desc limit 1) as player_name
    from (
      select ${orders.fields} as fields, max(${orders.createdAt}) as last_used_at
      from ${orders}
      where ${orders.customerId} = ${customerId} and ${orders.gameId} = ${gameId}
        and ${orders.createdAt} > now() - make_interval(days => ${RECENT_PLAYERS_DAYS})
      group by ${orders.fields}
    ) as used
    order by used.last_used_at desc
    limit ${RECENT_PLAYERS_PER_GAME}`);
  return result.rows.map((row) => ({
    fields: row.fields,
    playerName: row.player_name,
    lastUsedAt: new Date(row.last_used_at),
  }));
}
