import {
  QUICK_LINK_RETENTION_DAYS,
  type QuickLinkAttribution,
  type QuickLinkResolve,
  type QuickLinkStats,
  type QuickLinkStatsQuery,
} from '@vertex-digital/contracts';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../client.js';
import { newId } from '../id.js';
import { countHit } from '../rate-limits.js';
import {
  catalogCategories,
  catalogGames,
  catalogProducts,
  orders,
  quickLinkEvents,
} from '../schema/index.js';

type Executor = Database | Transaction;

/*
 * Direct buy links (S22 DL1–DL5, ADR 0037): a product's permanent code resolves to its pack, its
 * game or the home page; opens and the orders they led to go to an append-only counting log, kept
 * 90 days and never tied to money. Owned by the api `catalog` module; the purchase write path
 * (`purchaseOrder`) writes the order rows.
 */

/** One counted open per address, code and hour (DL2). */
const OPEN_WINDOW_MS = 60 * 60 * 1000;

/**
 * DL2: where a code leads. An active product of a shown game opens its pack; an archived or paused
 * product its game page; a paused or archived game (or its category), or an unknown code, the home
 * page. `productId` is set only for a pack that counts an open. S23 OP5: a game or product in a
 * running early-access window reads as paused (the link is public, it knows no viewer).
 */
export async function resolveQuickCode(
  db: Executor,
  code: string,
): Promise<{ resolve: QuickLinkResolve; productId: string | null } | null> {
  const [row] = await db
    .select({
      productId: catalogProducts.id,
      productLive: sql<boolean>`(${catalogProducts.status} = 'active'
        and ${catalogProducts.archivedAt} is null
        and (${catalogProducts.earlyAccessUntil} is null or ${catalogProducts.earlyAccessUntil} <= now()))`,
      gameSlug: catalogGames.slug,
      gameShown: sql<boolean>`(${catalogGames.status} = 'active' and ${catalogGames.archivedAt} is null
        and ${catalogCategories.archivedAt} is null
        and (${catalogGames.earlyAccessUntil} is null or ${catalogGames.earlyAccessUntil} <= now()))`,
    })
    .from(catalogProducts)
    .innerJoin(catalogGames, eq(catalogGames.id, catalogProducts.gameId))
    .innerJoin(catalogCategories, eq(catalogCategories.id, catalogGames.categoryId))
    .where(eq(catalogProducts.quickCode, code));
  if (!row) return null;
  if (!row.gameShown) return { resolve: { target: 'home' }, productId: null };
  if (!row.productLive)
    return { resolve: { target: 'game', gameSlug: row.gameSlug }, productId: null };
  return {
    resolve: { target: 'pack', gameSlug: row.gameSlug, productId: row.productId },
    productId: row.productId,
  };
}

/**
 * DL2: counts an open of `productId` from `address`, at most once per address, code and hour
 * (the rate counters; the address is never written to the log). True when it was counted.
 */
export async function recordQuickLinkOpen(
  db: Database,
  input: { productId: string; code: string; campaign: string | null; address: string },
): Promise<boolean> {
  const hits = await countHit(db, `quick-open:${input.address}:${input.code}`, OPEN_WINDOW_MS);
  if (hits > 1) return false;
  await db.insert(quickLinkEvents).values({
    id: newId(),
    productId: input.productId,
    campaign: input.campaign,
    kind: 'open',
  });
  return true;
}

/**
 * DL4: the attribution row of a new order, in its purchase transaction, when the link's code is
 * the order's product's (otherwise ignored). `order_id` is unique: a replay writes nothing.
 */
export async function recordQuickLinkOrder(
  tx: Transaction,
  order: { id: string; productId: string },
  productQuickCode: string,
  link: QuickLinkAttribution | undefined,
): Promise<void> {
  if (!link || link.code !== productQuickCode) return;
  await tx
    .insert(quickLinkEvents)
    .values({
      id: newId(),
      productId: order.productId,
      campaign: link.campaign ?? null,
      kind: 'order',
      orderId: order.id,
    })
    .onConflictDoNothing({ target: quickLinkEvents.orderId });
}

/**
 * DL5: per product and campaign in `[from, to)`, the opens, and the orders paid (a reservation
 * once A02 paid it, never a cancelled one) with their totals net of refunds; test customers'
 * orders are left out (edge case 22). Most opens first.
 */
export async function quickLinkStats(
  db: Executor,
  query: QuickLinkStatsQuery,
): Promise<QuickLinkStats> {
  const from = new Date(query.from);
  const to = new Date(query.to);
  const paid = sql`(${orders.paidAt} is not null and not ${orders.isTest})`;
  const opens = sql<number>`count(*) filter (where ${quickLinkEvents.kind} = 'open')::int`;
  const rows = await db
    .select({
      productId: quickLinkEvents.productId,
      productNameAr: catalogProducts.nameAr,
      gameNameAr: catalogGames.nameAr,
      quickCode: catalogProducts.quickCode,
      campaign: quickLinkEvents.campaign,
      opens,
      orders: sql<number>`count(*) filter (where ${paid})::int`,
      revenueUsdUnits: sql<string>`coalesce(sum(${orders.totalUsdUnits} - ${orders.refundedUsdUnits}) filter (where ${paid}), 0)::text`,
    })
    .from(quickLinkEvents)
    .innerJoin(catalogProducts, eq(catalogProducts.id, quickLinkEvents.productId))
    .innerJoin(catalogGames, eq(catalogGames.id, catalogProducts.gameId))
    .leftJoin(orders, eq(orders.id, quickLinkEvents.orderId))
    .where(
      and(
        gte(quickLinkEvents.createdAt, from),
        lt(quickLinkEvents.createdAt, to),
        query.productId ? eq(quickLinkEvents.productId, query.productId) : undefined,
      ),
    )
    .groupBy(
      quickLinkEvents.productId,
      catalogProducts.nameAr,
      catalogGames.nameAr,
      catalogProducts.quickCode,
      quickLinkEvents.campaign,
    )
    .orderBy(desc(opens), quickLinkEvents.productId, quickLinkEvents.campaign);
  return {
    items: rows.map((row) => ({ ...row, revenueUsdUnits: Number(row.revenueUsdUnits) })),
  };
}

/** The sweep: link events older than 90 days (the guard refuses younger ones). */
export async function deleteOldQuickLinkEvents(db: Executor): Promise<number> {
  const deleted = await db
    .delete(quickLinkEvents)
    .where(
      lt(
        quickLinkEvents.createdAt,
        sql`now() - ${`${QUICK_LINK_RETENTION_DAYS} days`}::interval - interval '1 minute'`,
      ),
    )
    .returning({ id: quickLinkEvents.id });
  return deleted.length;
}
