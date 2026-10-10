import { type DayBounds, REVIEW_TIME_ZONE } from '@vertex-digital/contracts';
import { and, count, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../client.js';
import { fulfilmentAttempts, orderEvents, orders } from '../schema/index.js';
import { damascusDate } from '../suppliers/validations.js';

/*
 * The order figures of the admin's dashboard (S11 rules DB2–DB4, DB6): real customers' sales,
 * cost and refunds by the orders finished in a period, and the conflicts of the last week. Reads
 * only, on `orders_finished_at_idx` and `order_events_conflict_idx`.
 */

type Executor = Database | Transaction;

/** The order events of a late result that disagreed (S08 F5): the notes the dashboard lists. */
const CONFLICT_REASONS = ['webhook_conflict', 'late_result_conflict'];

const CONFLICT_DAYS = 7;
const CONFLICT_ORDERS_SHOWN = 5;

export interface PeriodFigures {
  salesUsdUnits: number;
  costUsdUnits: number;
  delivered: number;
  refunds: number;
  refundedUsdUnits: number;
}

export interface OrderFigures {
  today: PeriodFigures;
  /** Yesterday from its start to the same clock time (rule DB1). */
  yesterday: PeriodFigures;
  medianDeliveryMs: number | null;
  /** Rule DB3: oldest first, today last. */
  salesLine: { date: string; salesUsdUnits: number }[];
  /** Rule DB4: what open paid orders still owe their customers. */
  openValueUsdUnits: number;
  conflicts: { count: number; newestAt: Date | null; orders: { id: string; number: string }[] };
}

const real = eq(orders.isTest, false);
const finishedIn = (from: Date, to: Date) =>
  and(real, gte(orders.finishedAt, from), lt(orders.finishedAt, to));

/** Rule DB2: the orders finished in `[from, to)`. */
async function period(db: Executor, from: Date, to: Date): Promise<PeriodFigures> {
  const [[row], [cost]] = await Promise.all([
    db
      .select({
        sales: sql<string>`coalesce(sum(${orders.deliveredQuantity}::bigint * ${orders.unitPriceUsdUnits}), 0)::text`,
        delivered: sql<number>`(count(*) filter (where ${orders.status} in ('delivered', 'partially_refunded')))::int`,
        refunds: sql<number>`(count(*) filter (where ${orders.status} in ('refunded', 'partially_refunded')))::int`,
        refunded: sql<string>`coalesce(sum(${orders.refundedUsdUnits}), 0)::text`,
      })
      .from(orders)
      .where(finishedIn(from, to)),
    // The cost of those orders: their delivered attempts' units at each attempt's cost.
    db
      .select({
        units: sql<string>`coalesce(sum(${fulfilmentAttempts.deliveredQuantity}::bigint * ${fulfilmentAttempts.unitCostUsdUnits}), 0)::text`,
      })
      .from(fulfilmentAttempts)
      .innerJoin(orders, eq(orders.id, fulfilmentAttempts.orderId))
      .where(and(finishedIn(from, to), eq(fulfilmentAttempts.status, 'delivered'))),
  ]);
  return {
    salesUsdUnits: Number(row?.sales ?? 0),
    costUsdUnits: Number(cost?.units ?? 0),
    delivered: row?.delivered ?? 0,
    refunds: row?.refunds ?? 0,
    refundedUsdUnits: Number(row?.refunded ?? 0),
  };
}

/** Rules DB2–DB4, DB6 at `now`, with the Damascus days the caller computed. */
export async function orderFigures(
  db: Executor,
  bounds: DayBounds,
  now: Date,
): Promise<OrderFigures> {
  const lineStart = bounds.days[0] as Date;
  // The zone inline: a bound parameter would make the GROUP BY a different expression.
  const day = sql<string>`to_char(${orders.finishedAt} at time zone ${sql.raw(`'${REVIEW_TIME_ZONE}'`)}, 'YYYY-MM-DD')`;
  const conflictSince = new Date(now.getTime() - CONFLICT_DAYS * 24 * 60 * 60_000);
  const conflict = and(
    eq(orderEvents.kind, 'note'),
    inArray(orderEvents.reason, CONFLICT_REASONS),
    gte(orderEvents.createdAt, conflictSince),
  );
  const [today, yesterday, [median], line, [open], [conflictCount], conflictOrders] =
    await Promise.all([
      period(db, bounds.todayStart, now),
      period(db, bounds.yesterdayStart, bounds.sameTimeYesterday),
      db
        .select({
          ms: sql<string | null>`(percentile_disc(0.5) within group (order by
            extract(epoch from ${orders.deliveredAt} - ${orders.paidAt}) * 1000))::bigint::text`,
        })
        .from(orders)
        .where(and(finishedIn(bounds.todayStart, now), eq(orders.status, 'delivered'))),
      db
        .select({
          day,
          sales: sql<string>`coalesce(sum(${orders.deliveredQuantity}::bigint * ${orders.unitPriceUsdUnits}), 0)::text`,
        })
        .from(orders)
        .where(finishedIn(lineStart, now))
        .groupBy(day),
      db
        .select({
          value: sql<string>`coalesce(sum((${orders.quantity} - ${orders.deliveredQuantity} - ${orders.refundedQuantity})::bigint * ${orders.unitPriceUsdUnits}), 0)::text`,
        })
        .from(orders)
        .where(
          and(real, inArray(orders.status, ['paid', 'sent_to_supplier', 'failed', 'needs_review'])),
        ),
      db.select({ count: count() }).from(orderEvents).where(conflict),
      db
        .selectDistinctOn([orders.id], {
          id: orders.id,
          number: orders.number,
          at: orderEvents.createdAt,
        })
        .from(orderEvents)
        .innerJoin(orders, eq(orders.id, orderEvents.orderId))
        .where(conflict)
        .orderBy(orders.id, desc(orderEvents.createdAt)),
    ]);
  const salesOf = new Map(line.map((row) => [row.day, Number(row.sales)]));
  const newest = [...conflictOrders]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, CONFLICT_ORDERS_SHOWN);
  return {
    today,
    yesterday,
    medianDeliveryMs: median?.ms == null ? null : Math.max(0, Number(median.ms)),
    salesLine: bounds.days.map((start) => {
      // The day's date is the Damascus date of its start (any instant of the day would do).
      const date = damascusDate(start);
      return { date, salesUsdUnits: salesOf.get(date) ?? 0 };
    }),
    openValueUsdUnits: Number(open?.value ?? 0),
    conflicts: {
      count: conflictCount?.count ?? 0,
      newestAt: newest[0]?.at ?? null,
      orders: newest.map(({ id, number }) => ({ id, number })),
    },
  };
}
