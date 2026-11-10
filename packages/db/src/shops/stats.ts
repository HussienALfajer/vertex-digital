import { sql } from 'drizzle-orm';
import type { Executor } from '../client.js';

/*
 * A shop's statistics (S26 SP3) by Damascus day: page views and sign-ups from the day's counters,
 * and from the records the shop's orders, sales at the selling price, margins released, transfers
 * and returns. Counters and sums only, never a customer's data.
 */

export interface ShopStatsDay {
  date: string;
  visits: number;
  signUps: number;
  orders: number;
  salesUsdUnits: number;
  marginReleasedUsdUnits: number;
  transfersUsdUnits: number;
  returnsUsdUnits: number;
}

const DAMASCUS = sql.raw(`'Asia/Damascus'`);
const day = (column: string) => sql.raw(`(${column} at time zone 'Asia/Damascus')::date`);

/**
 * Every Damascus day from `from` to `to` (inclusive, `YYYY-MM-DD`) with its figures, and the
 * customers who bought in the period. An order counts on its paid day; its sales (delivered units
 * at the selling price) and released margin on its finished day.
 */
export async function shopStatsDays(
  db: Executor,
  shopId: string,
  from: string,
  to: string,
): Promise<{ days: ShopStatsDay[]; activeCustomers: number }> {
  const result = await db.execute<{
    date: string;
    visits: string;
    sign_ups: string;
    orders: string;
    sales: string;
    margin: string;
    transfers: string;
    returns: string;
  }>(sql`
    with days as (
      select d::date as date from generate_series(${from}::date, ${to}::date, interval '1 day') d
    ),
    counters as (
      select damascus_date as date, visits, sign_ups from shop_daily_stats
      where shop_id = ${shopId} and damascus_date between ${from}::date and ${to}::date
    ),
    paid as (
      select ${day('o.paid_at')} as date, count(*) as orders
      from shop_order_sales s join orders o on o.id = s.order_id
      where s.shop_id = ${shopId} and o.paid_at is not null
        and ${day('o.paid_at')} between ${from}::date and ${to}::date
      group by 1
    ),
    finished as (
      select ${day('o.finished_at')} as date,
        sum(s.unit_sell_usd_units * o.delivered_quantity) as sales,
        sum(coalesce(s.margin_released_usd_units, 0)) as margin
      from shop_order_sales s join orders o on o.id = s.order_id
      where s.shop_id = ${shopId} and o.finished_at is not null
        and ${day('o.finished_at')} between ${from}::date and ${to}::date
      group by 1
    ),
    moved as (
      select ${day('t.created_at')} as date,
        sum(t.amount_usd_units) filter (where t.direction = 'to_customer') as transfers,
        sum(t.amount_usd_units) filter (where t.direction = 'to_merchant') as returns
      from shop_transfers t
      where t.shop_id = ${shopId} and ${day('t.created_at')} between ${from}::date and ${to}::date
      group by 1
    )
    select days.date::text as date,
      coalesce(c.visits, 0)::text as visits, coalesce(c.sign_ups, 0)::text as sign_ups,
      coalesce(p.orders, 0)::text as orders,
      coalesce(f.sales, 0)::text as sales, coalesce(f.margin, 0)::text as margin,
      coalesce(m.transfers, 0)::text as transfers, coalesce(m.returns, 0)::text as returns
    from days
    left join counters c on c.date = days.date
    left join paid p on p.date = days.date
    left join finished f on f.date = days.date
    left join moved m on m.date = days.date
    order by days.date`);
  const active = await db.execute<{ customers: string }>(sql`
    select count(distinct s.shop_customer_id)::text as customers
    from shop_order_sales s join orders o on o.id = s.order_id
    where s.shop_id = ${shopId} and o.paid_at is not null
      and (o.paid_at at time zone ${DAMASCUS})::date between ${from}::date and ${to}::date`);
  return {
    days: result.rows.map((row) => ({
      date: row.date,
      visits: Number(row.visits),
      signUps: Number(row.sign_ups),
      orders: Number(row.orders),
      salesUsdUnits: Number(row.sales),
      marginReleasedUsdUnits: Number(row.margin),
      transfersUsdUnits: Number(row.transfers),
      returnsUsdUnits: Number(row.returns),
    })),
    activeCustomers: Number(active.rows[0]?.customers ?? 0),
  };
}
