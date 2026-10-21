import { type ProductKind, QUICK_BUY_CARDS, type SavedPlayer } from '@vertex-digital/contracts';
import { and, eq, inArray, isNotNull, notInArray, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../client.js';
import { catalogProducts, orders } from '../schema/index.js';
import { customerSavedPlayers } from './reads.js';

type Executor = Database | Transaction;

export interface QuickBuyRow {
  savedPlayer: SavedPlayer;
  product: {
    id: string;
    nameAr: string;
    kind: ProductKind;
    gameAmount: number | null;
    /** Active and unarchived; availability and price are the caller's (S09 SF1, S20). */
    live: boolean;
  };
  quantity: number;
}

/**
 * S22 QB2: the "اشحن مجدداً" cards' facts: the customer's saved IDs, newest used first, skipping
 * hidden ones and those of games not shown; each with the pack and quantity of the customer's
 * latest paid order of that game with the same fields (`paid_at` set, so never a waiting or
 * cancelled reservation). A saved ID with no such order is skipped; at most 6.
 */
export async function quickBuyRows(db: Executor, customerId: string): Promise<QuickBuyRow[]> {
  const saved = (await customerSavedPlayers(db, customerId)).filter(
    (row) => row.gameShown && !row.quickBuyHidden,
  );
  if (saved.length === 0) return [];
  const gameIds = [...new Set(saved.map((row) => row.gameId))];
  // Every paid order of these games, newest first; the first per fields is the card's.
  const paid = await db
    .selectDistinctOn([orders.gameId, orders.fields], {
      gameId: orders.gameId,
      fields: orders.fields,
      quantity: orders.quantity,
      product: {
        id: catalogProducts.id,
        nameAr: catalogProducts.nameAr,
        kind: catalogProducts.kind,
        gameAmount: catalogProducts.gameAmount,
        live: sql<boolean>`(${catalogProducts.status} = 'active' and ${catalogProducts.archivedAt} is null)`,
      },
    })
    .from(orders)
    .innerJoin(catalogProducts, eq(catalogProducts.id, orders.productId))
    .where(
      and(
        eq(orders.customerId, customerId),
        inArray(orders.gameId, gameIds),
        isNotNull(orders.paidAt),
        notInArray(orders.status, ['awaiting_balance', 'cancelled']),
      ),
    )
    .orderBy(orders.gameId, orders.fields, sql`${orders.paidAt} desc`);
  const rows: QuickBuyRow[] = [];
  for (const savedPlayer of saved) {
    const last = paid.find(
      (order) =>
        order.gameId === savedPlayer.gameId && sameFields(order.fields, savedPlayer.fields),
    );
    if (!last) continue;
    rows.push({ savedPlayer, product: last.product, quantity: last.quantity });
    if (rows.length === QUICK_BUY_CARDS) break;
  }
  return rows;
}

/** jsonb equality, as `fields` compare in PostgreSQL: the same keys with the same values. */
function sameFields(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/** S22 BG1: the totals of the customer's open reservations, which A02 pays first. */
export async function reservedUsdUnits(db: Executor, customerId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${orders.totalUsdUnits}), 0)::text` })
    .from(orders)
    .where(and(eq(orders.customerId, customerId), eq(orders.status, 'awaiting_balance')));
  return Number(row?.total ?? 0);
}
