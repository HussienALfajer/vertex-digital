import {
  type AttemptStatus,
  LIVE_COLUMN_LIMIT,
  LIVE_COLUMNS,
  LIVE_FINISHED_MINUTES,
  type LiveBoard,
  type LiveBoardQuery,
  type LiveColumn,
  type LiveOrderCard,
  liveColumn,
  type SupplierCode,
  slowAfterSeconds,
} from '@vertex-digital/contracts';
import { and, count, eq, inArray, or, type SQL, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../client.js';
import {
  catalogGames,
  catalogProducts,
  customers,
  fulfilmentAttempts,
  orders,
  suppliers,
} from '../schema/index.js';
import { productDeliveryStats } from './reads.js';

/*
 * The admin's live room (S11 rules LR1–LR3): the open orders and those finished within the hour,
 * each with its open (else newest) attempt, placed in a column by the contracts' `liveColumn`.
 * Reads only, never cached; no field values or codes.
 */

type Executor = Database | Transaction;

const OPEN_STATUSES = ['paid', 'sent_to_supplier', 'failed', 'needs_review'] as const;
const FINISHED_STATUSES = ['delivered', 'partially_refunded', 'refunded'] as const;

/** The board's filters as SQL, the supplier aside (it is the attempt's). */
function boardFilters(query: Pick<LiveBoardQuery, 'gameId' | 'test'>): SQL[] {
  return [
    ...(query.gameId ? [eq(orders.gameId, query.gameId)] : []),
    ...(query.test === 'hide' ? [eq(orders.isTest, false)] : []),
    ...(query.test === 'only' ? [eq(orders.isTest, true)] : []),
  ];
}

/** Each order on the board now, its column and the attempt it shows (LR1). */
async function boardRows(db: Executor, query: LiveBoardQuery, now: Date) {
  const since = new Date(now.getTime() - LIVE_FINISHED_MINUTES * 60_000);
  // The open attempt first, else the newest one.
  const attempt = sql`lateral (
    select ${fulfilmentAttempts.status} as status, ${fulfilmentAttempts.sentAt} as sent_at,
      ${suppliers.code} as supplier_code, ${suppliers.nameAr} as supplier_name_ar,
      ${fulfilmentAttempts.status} in ('sending', 'pending', 'unknown') as open
    from ${fulfilmentAttempts}
    join ${suppliers} on ${suppliers.id} = ${fulfilmentAttempts.supplierId}
    where ${fulfilmentAttempts.orderId} = ${orders.id}
    order by open desc, ${fulfilmentAttempts.createdAt} desc, ${fulfilmentAttempts.id} desc
    limit 1)`;
  const rows = await db
    .select({
      id: orders.id,
      status: orders.status,
      paidAt: orders.paidAt,
      finishedAt: orders.finishedAt,
      attemptStatus: sql<AttemptStatus | null>`last.status`,
      sentAt: sql<string | null>`last.sent_at`,
      supplierCode: sql<SupplierCode | null>`last.supplier_code`,
      supplierNameAr: sql<string | null>`last.supplier_name_ar`,
      open: sql<boolean | null>`last.open`,
    })
    .from(orders)
    .leftJoin(sql`${attempt} last`, sql`true`)
    .where(
      and(
        or(
          inArray(orders.status, [...OPEN_STATUSES]),
          and(
            inArray(orders.status, [...FINISHED_STATUSES]),
            sql`${orders.finishedAt} >= ${since}`,
          ),
        ),
        ...boardFilters(query),
        ...(query.supplier ? [sql`last.supplier_code = ${query.supplier}`] : []),
      ),
    );
  return rows.map((row) => ({
    ...row,
    column: liveColumn(
      row,
      row.open && row.supplierCode ? { supplierCode: row.supplierCode } : null,
      now,
    ),
  }));
}

/** Rule DB4: the count in each column, test orders included (the admin acts on them). */
export async function liveCounts(
  db: Executor,
  now: Date,
): Promise<Record<LiveColumn, number> & { awaitingBalance: number }> {
  const [rows, [awaiting]] = await Promise.all([
    boardRows(db, { test: 'all' }, now),
    db.select({ count: count() }).from(orders).where(eq(orders.status, 'awaiting_balance')),
  ]);
  const counts = Object.fromEntries(LIVE_COLUMNS.map((column) => [column, 0])) as Record<
    LiveColumn,
    number
  >;
  for (const row of rows) if (row.column) counts[row.column] += 1;
  return { ...counts, awaitingBalance: awaiting?.count ?? 0 };
}

/**
 * `GET /api/admin/orders/live` (rules LR1–LR3): per column its exact count and at most 100 cards,
 * the three open columns oldest paid first, `finished` newest first; the `awaiting_balance` count
 * under the same game and test filters.
 */
export async function liveBoard(
  db: Executor,
  query: LiveBoardQuery,
  now: Date,
): Promise<LiveBoard> {
  const [rows, [awaiting]] = await Promise.all([
    boardRows(db, query, now),
    db
      .select({ count: count() })
      .from(orders)
      .where(and(eq(orders.status, 'awaiting_balance'), ...boardFilters(query))),
  ]);
  const time = (date: Date | null) => date?.getTime() ?? 0;
  const shown = new Map<LiveColumn, typeof rows>();
  const counts = new Map<LiveColumn, number>();
  for (const column of LIVE_COLUMNS) {
    const inColumn = rows.filter((row) => row.column === column);
    inColumn.sort((a, b) =>
      column === 'finished'
        ? time(b.finishedAt) - time(a.finishedAt) || b.id.localeCompare(a.id)
        : time(a.paidAt) - time(b.paidAt) || a.id.localeCompare(b.id),
    );
    counts.set(column, inColumn.length);
    shown.set(column, inColumn.slice(0, LIVE_COLUMN_LIMIT));
  }
  const ids = [...shown.values()].flat().map((row) => row.id);
  const details =
    ids.length === 0
      ? []
      : await db
          .select({
            id: orders.id,
            number: orders.number,
            productId: orders.productId,
            quantity: orders.quantity,
            totalUsdUnits: orders.totalUsdUnits,
            isTest: orders.isTest,
            reviewSince: orders.reviewSince,
            customerEmail: customers.email,
            product: { id: catalogProducts.id, nameAr: catalogProducts.nameAr },
            game: { id: catalogGames.id, nameAr: catalogGames.nameAr },
          })
          .from(orders)
          .innerJoin(customers, eq(customers.id, orders.customerId))
          .innerJoin(catalogProducts, eq(catalogProducts.id, orders.productId))
          .innerJoin(catalogGames, eq(catalogGames.id, orders.gameId))
          .where(inArray(orders.id, ids));
  const detailOf = new Map(details.map((row) => [row.id, row]));
  const atSupplier = shown.get('at_supplier') ?? [];
  const stats = await productDeliveryStats(db, [
    ...new Set(atSupplier.map((row) => detailOf.get(row.id)?.productId as string)),
  ]);
  const card = (row: (typeof rows)[number], column: LiveColumn): LiveOrderCard => {
    const detail = detailOf.get(row.id) as (typeof details)[number];
    return {
      id: row.id,
      number: detail.number,
      status: row.status,
      game: detail.game,
      product: detail.product,
      quantity: detail.quantity,
      totalUsdUnits: detail.totalUsdUnits,
      isTest: detail.isTest,
      customerEmail: detail.customerEmail,
      attempt:
        row.supplierCode && row.attemptStatus
          ? {
              supplierCode: row.supplierCode,
              supplierNameAr: row.supplierNameAr as string,
              status: row.attemptStatus,
            }
          : null,
      paidAt: (row.paidAt as Date).toISOString(),
      sentAt: row.open && row.sentAt ? new Date(row.sentAt).toISOString() : null,
      reviewSince: detail.reviewSince?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
      slowAfterSeconds:
        column === 'at_supplier' ? slowAfterSeconds(stats.get(detail.productId) ?? null) : null,
    };
  };
  const columns = Object.fromEntries(
    LIVE_COLUMNS.map((column) => [
      column,
      {
        count: counts.get(column) ?? 0,
        cards: (shown.get(column) ?? []).map((row) => card(row, column)),
      },
    ]),
  ) as LiveBoard['columns'];
  return { columns, awaitingBalance: awaiting?.count ?? 0, generatedAt: now.toISOString() };
}
