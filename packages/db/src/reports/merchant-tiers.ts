import {
  damascusMonth,
  MERCHANT_TIERS,
  type MerchantTier,
  type MerchantTierReport,
  monthRange,
  ROOT_PRICE_LIST_IDS,
  tierMove,
} from '@vertex-digital/contracts';
import { sql } from 'drizzle-orm';
import { type Database, readAll, type Transaction } from '../client.js';
import { netPurchases } from '../merchants/levels.js';

/*
 * S23 AD4: the report by tier for a month, read only. Holders and their net purchases come from
 * `merchant_tier_months` for an ended month and from today's effective tiers for the current one.
 * Sales, cost and profit are R1's (S13 rule RP3) over the month's finished merchant orders, by the
 * tier whose list priced each order (wholesale is Bronze; a list no tier names is left out).
 * Rises and falls are the month's `merchant_tier_changes`. Test merchants are left out (S13).
 */

type Executor = Database | Transaction;

const num = (value: unknown): number => {
  const result = Number(value ?? 0);
  if (!Number.isSafeInteger(result)) throw new RangeError(`Not a safe integer: ${String(value)}`);
  return result;
};

export async function merchantTierReport(
  db: Executor,
  month: string,
  now: Date,
): Promise<Omit<MerchantTierReport, 'generatedAt'>> {
  const range = monthRange(month);
  const current = month === damascusMonth(now);
  const [holders, sales, changes] = await readAll(db, [
    () =>
      current
        ? db.execute<{ customer_id: string; tier: MerchantTier }>(sql`
            select p.customer_id, coalesce(l.tier::text, 'bronze') as tier
            from merchant_profiles p
            join customers c on c.id = p.customer_id
            left join merchant_levels l on l.id = p.level_id and l.archived_at is null
            where c.account_type = 'merchant' and not c.is_test and p.revoked_at is null`)
        : db.execute<{ customer_id: string; tier: MerchantTier; net: string }>(sql`
            select m.customer_id, m.held_tier::text as tier, m.net_purchases_usd_units::text as net
            from merchant_tier_months m
            join customers c on c.id = m.customer_id
            where m.month = ${`${month}-01`}::date and not c.is_test`),
    () =>
      db.execute<{ tier: MerchantTier; delivered: string; sales: string; cost: string }>(sql`
        with tier_lists as (
          select ${ROOT_PRICE_LIST_IDS.wholesale}::uuid as price_list_id, 'bronze' as tier
          union all
          (select distinct on (price_list_id) price_list_id, tier::text
          from merchant_levels
          where tier is not null and price_list_id <> ${ROOT_PRICE_LIST_IDS.wholesale}::uuid
          order by price_list_id, archived_at desc nulls first, created_at desc)
        )
        select t.tier,
          sum((o.status in ('delivered', 'partially_refunded'))::int)::text as delivered,
          coalesce(sum(o.delivered_quantity::bigint * o.unit_price_usd_units), 0)::text as sales,
          coalesce(sum((select sum(f.delivered_quantity::bigint * f.unit_cost_usd_units)
            from fulfilment_attempts f where f.order_id = o.id and f.status = 'delivered')), 0)::text
            as cost
        from orders o
        join customers c on c.id = o.customer_id
        join tier_lists t on t.price_list_id = o.price_list_id
        where c.account_type = 'merchant' and not o.is_test and o.payer = 'customer'
          and o.status <> 'cancelled'
          and o.finished_at >= ${range.start.toISOString()}::timestamptz
          and o.finished_at < ${range.end.toISOString()}::timestamptz
        group by t.tier`),
    () =>
      db.execute<{ from_tier: MerchantTier; to_tier: MerchantTier }>(sql`
        select ch.from_tier::text, ch.to_tier::text
        from merchant_tier_changes ch
        join customers c on c.id = ch.customer_id
        where not c.is_test
          and ch.created_at >= ${range.start.toISOString()}::timestamptz
          and ch.created_at < ${range.end.toISOString()}::timestamptz`),
  ]);
  const rows = new Map(
    MERCHANT_TIERS.map((tier) => [
      tier,
      {
        tier,
        merchants: 0,
        netPurchasesUsdUnits: 0,
        delivered: 0,
        salesUsdUnits: 0,
        costUsdUnits: 0,
        profitUsdUnits: 0,
        rises: 0,
        falls: 0,
      },
    ]),
  );
  const row = (tier: MerchantTier) => rows.get(tier) as NonNullable<ReturnType<typeof rows.get>>;
  for (const holder of holders.rows) {
    const entry = row(holder.tier);
    entry.merchants += 1;
    entry.netPurchasesUsdUnits +=
      'net' in holder
        ? num(holder.net)
        : await netPurchases(db, holder.customer_id, range.start, range.end);
  }
  for (const line of sales.rows) {
    const entry = row(line.tier);
    entry.delivered = num(line.delivered);
    entry.salesUsdUnits = num(line.sales);
    entry.costUsdUnits = num(line.cost);
    entry.profitUsdUnits = entry.salesUsdUnits - entry.costUsdUnits;
  }
  for (const change of changes.rows) {
    const move = tierMove(change.from_tier, change.to_tier);
    if (move === 'rise') row(change.to_tier).rises += 1;
    if (move === 'fall') row(change.from_tier).falls += 1;
  }
  return { month, current, rows: [...rows.values()] };
}
