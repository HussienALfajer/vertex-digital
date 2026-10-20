import {
  type BreakdownReport,
  type CustomersReport,
  DEPOSIT_METHODS,
  type DepositsReport,
  heldUnits,
  type LedgerReport,
  marginPercent,
  REVIEW_TIME_ZONE,
  type RefundsReport,
  type ReportBreakdown,
  type SalesReport,
  TOP_CUSTOMERS_LIMIT,
  TREASURY_ACCOUNTS,
  TREASURY_PLACES,
} from '@vertex-digital/contracts';
import { type SQL, sql } from 'drizzle-orm';
import { type Database, readAll, type Transaction } from '../client.js';

/*
 * The reports (S13 rules RP1–RP9, ADR 0025): read-only SQL over the orders, attempts, deposits,
 * adjustments and the ledger, by `Asia/Damascus` day. R1–R5 count real customers only; R6 shows
 * test customers' share apart. Sales and cost follow the dashboard's definitions exactly (rule
 * RP3): sales are delivered units × unit price of the orders finished in the period, cost their
 * delivered attempts' units × unit cost. Never a phone number, player id, address or code.
 */

type Executor = Database | Transaction;

export interface ReportPeriod {
  /** `Asia/Damascus` dates, inclusive (rule RP1). */
  from: string;
  to: string;
}

/** The zone inline: a bound parameter would make each GROUP BY a different expression. */
const ZONE = sql.raw(`'${REVIEW_TIME_ZONE}'`);

const startOf = (period: ReportPeriod) =>
  sql`(${period.from}::date)::timestamp at time zone ${ZONE}`;
const endOf = (period: ReportPeriod) =>
  sql`(${period.to}::date + 1)::timestamp at time zone ${ZONE}`;
const within = (column: SQL, period: ReportPeriod) =>
  sql`${column} >= ${startOf(period)} and ${column} < ${endOf(period)}`;
const dayOf = (column: SQL) => sql`to_char(${column} at time zone ${ZONE}, 'YYYY-MM-DD')`;

const num = (value: unknown): number => {
  const result = Number(value ?? 0);
  if (!Number.isSafeInteger(result)) throw new RangeError(`Not a safe integer: ${String(value)}`);
  return result;
};

/** Every date of the period, in order. */
function daysOf(period: ReportPeriod): string[] {
  const days: string[] = [];
  const end = Date.parse(`${period.to}T00:00:00Z`);
  for (let at = Date.parse(`${period.from}T00:00:00Z`); at <= end; at += 86_400_000) {
    days.push(new Date(at).toISOString().slice(0, 10));
  }
  return days;
}

const percent = (part: number, whole: number) =>
  whole === 0 ? null : Math.round((part * 1000) / whole) / 10;

/** The figures of rule RP3 from sales, cost and delivered orders. */
function figures(row: { delivered: unknown; sales: unknown; cost: unknown }) {
  const salesUsdUnits = num(row.sales);
  const costUsdUnits = num(row.cost);
  const profitUsdUnits = salesUsdUnits - costUsdUnits;
  return {
    delivered: num(row.delivered),
    salesUsdUnits,
    costUsdUnits,
    profitUsdUnits,
    marginPercent: marginPercent(profitUsdUnits, salesUsdUnits),
  };
}

const sum = <Row>(rows: Row[], pick: (row: Row) => number) =>
  rows.reduce((total, row) => total + pick(row), 0);

/**
 * Real customers' orders finished in the period, with their delivered attempts' cost: the ones
 * customers paid, or (S16 AP14) the owner-funded admin orders, which are reported apart.
 */
const finishedOrders = (period: ReportPeriod, payer: 'customer' | 'owner' = 'customer') => sql`
  select o.*,
    o.delivered_quantity::bigint * o.unit_price_usd_units as sales,
    coalesce((select sum(f.delivered_quantity::bigint * f.unit_cost_usd_units)
      from fulfilment_attempts f where f.order_id = o.id and f.status = 'delivered'), 0) as cost,
    (o.status in ('delivered', 'partially_refunded'))::int as is_delivered
  from orders o
  where not o.is_test and o.payer = ${payer} and ${within(sql`o.finished_at`, period)}`;

/** S16 AP14: the "طلبات من مال المالك" line of R1 and R2, the period's owner-funded orders. */
async function ownerFundedFigures(db: Executor, period: ReportPeriod) {
  const { rows } = await db.execute<{ delivered: string; sales: string; cost: string }>(sql`
    select coalesce(sum(is_delivered), 0)::text as delivered,
      coalesce(sum(sales), 0)::text as sales, coalesce(sum(cost), 0)::text as cost
    from (${finishedOrders(period, 'owner')}) o`);
  return figures(rows[0] ?? { delivered: 0, sales: 0, cost: 0 });
}

/** R1 (rule RP3): sales and profit by day, equal to the dashboard's for the same day. */
export async function salesReport(
  db: Executor,
  period: ReportPeriod,
): Promise<Omit<SalesReport, 'generatedAt'>> {
  const { rows } = await db.execute<{
    day: string;
    delivered: string;
    sales: string;
    cost: string;
  }>(sql`
    select ${dayOf(sql`finished_at`)} as day, sum(is_delivered)::text as delivered,
      sum(sales)::text as sales, sum(cost)::text as cost
    from (${finishedOrders(period)}) o group by 1`);
  const byDay = new Map(rows.map((row) => [row.day, row]));
  const days = daysOf(period).map((date) => ({
    date,
    ...figures(byDay.get(date) ?? { delivered: 0, sales: 0, cost: 0 }),
  }));
  return {
    ...period,
    rows: days,
    totals: figures({
      delivered: sum(days, (day) => day.delivered),
      sales: sum(days, (day) => day.salesUsdUnits),
      cost: sum(days, (day) => day.costUsdUnits),
    }),
    ownerFunded: await ownerFundedFigures(db, period),
  };
}

/**
 * R2 (rule RP4): the same figures by game, product or supplier (S20: or price list, or merchant),
 * by sales descending.
 */
export async function breakdownReport(
  db: Executor,
  period: ReportPeriod,
  by: ReportBreakdown,
): Promise<Omit<BreakdownReport, 'generatedAt'>> {
  type Row = {
    key: string;
    name_ar: string;
    game_name_ar: string | null;
    game_id: string | null;
    supplier: string | null;
    delivered: string;
    units: string;
    sales: string;
    cost: string;
    sent: string | null;
    failed: string | null;
    resolved: string | null;
  };
  let query: SQL;
  if (by === 'supplier') {
    // Per delivered attempt: an order split between suppliers counts on each for its units.
    query = sql`
      with delivered as (
        select f.supplier_id, f.order_id, f.delivered_quantity as units,
          f.delivered_quantity::bigint * o.unit_price_usd_units as sales,
          f.delivered_quantity::bigint * f.unit_cost_usd_units as cost, o.status
        from fulfilment_attempts f join orders o on o.id = f.order_id
        where f.status = 'delivered' and not o.is_test and o.payer = 'customer'
          and ${within(sql`o.finished_at`, period)}
      ),
      attempts as (
        select f.supplier_id,
          count(*) filter (where ${within(sql`f.sent_at`, period)}) as sent,
          count(*) filter (where f.status = 'failed' and ${within(sql`f.resolved_at`, period)}) as failed,
          count(*) filter (where f.status in ('delivered', 'failed') and ${within(sql`f.resolved_at`, period)}) as resolved
        from fulfilment_attempts f join orders o on o.id = f.order_id
        where not o.is_test
        group by f.supplier_id
      )
      select s.code::text as key, s.name_ar, null as game_name_ar, null as game_id,
        s.code::text as supplier,
        (select count(distinct d.order_id) from delivered d
          where d.supplier_id = s.id and d.status in ('delivered', 'partially_refunded'))::text as delivered,
        coalesce((select sum(units) from delivered d where d.supplier_id = s.id), 0)::text as units,
        coalesce((select sum(sales) from delivered d where d.supplier_id = s.id), 0)::text as sales,
        coalesce((select sum(cost) from delivered d where d.supplier_id = s.id), 0)::text as cost,
        coalesce(a.sent, 0)::text as sent, coalesce(a.failed, 0)::text as failed,
        coalesce(a.resolved, 0)::text as resolved
      from suppliers s left join attempts a on a.supplier_id = s.id
      where exists (select 1 from delivered d where d.supplier_id = s.id) or coalesce(a.sent, 0) > 0
        or coalesce(a.resolved, 0) > 0`;
  } else if (by === 'price_list') {
    // S20: by the list each order was charged at (`orders.price_list_id`).
    query = sql`
      select l.id::text as key, l.name as name_ar, null as game_name_ar, null as game_id,
        null as supplier,
        sum(o.is_delivered)::text as delivered, sum(o.delivered_quantity)::text as units,
        sum(o.sales)::text as sales, sum(o.cost)::text as cost,
        null as sent, null as failed, null as resolved
      from (${finishedOrders(period)}) o
      join price_lists l on l.id = o.price_list_id
      group by l.id, l.name`;
  } else if (by === 'merchant') {
    // S20: the orders of accounts that are or were merchants, by trade name.
    query = sql`
      select m.customer_id::text as key, m.trade_name as name_ar, null as game_name_ar,
        null as game_id, null as supplier,
        sum(o.is_delivered)::text as delivered, sum(o.delivered_quantity)::text as units,
        sum(o.sales)::text as sales, sum(o.cost)::text as cost,
        null as sent, null as failed, null as resolved
      from (${finishedOrders(period)}) o
      join merchant_profiles m on m.customer_id = o.customer_id
      group by m.customer_id, m.trade_name`;
  } else {
    const product = by === 'product';
    query = sql`
      select ${product ? sql`p.id::text` : sql`g.id::text`} as key,
        ${product ? sql`p.name_ar` : sql`g.name_ar`} as name_ar,
        ${product ? sql`g.name_ar` : sql`null`} as game_name_ar, g.id as game_id, null as supplier,
        sum(o.is_delivered)::text as delivered, sum(o.delivered_quantity)::text as units,
        sum(o.sales)::text as sales, sum(o.cost)::text as cost,
        null as sent, null as failed, null as resolved
      from (${finishedOrders(period)}) o
      join catalog_games g on g.id = o.game_id
      join catalog_products p on p.id = o.product_id
      group by ${product ? sql`p.id, p.name_ar, g.id, g.name_ar` : sql`g.id, g.name_ar`}`;
  }
  const { rows } = await db.execute<Row>(query);
  const items = rows
    .map((row) => {
      const resolved = row.resolved === null ? null : num(row.resolved);
      const failed = row.failed === null ? null : num(row.failed);
      return {
        key: row.key,
        nameAr: row.name_ar,
        gameNameAr: row.game_name_ar,
        gameId: row.game_id,
        supplier: row.supplier as BreakdownReport['rows'][number]['supplier'],
        ...figures(row),
        deliveredUnits: num(row.units),
        attemptsSent: row.sent === null ? null : num(row.sent),
        attemptsFailed: failed,
        failureRatePercent: resolved === null || failed === null ? null : percent(failed, resolved),
      };
    })
    .sort((a, b) => b.salesUsdUnits - a.salesUsdUnits || a.nameAr.localeCompare(b.nameAr));
  const supplierRows = by === 'supplier';
  const failedTotal = sum(items, (row) => row.attemptsFailed ?? 0);
  const resolvedTotal = sum(rows, (row) => num(row.resolved));
  return {
    ...period,
    by,
    rows: items,
    totals: {
      ...figures({
        delivered: sum(items, (row) => row.delivered),
        sales: sum(items, (row) => row.salesUsdUnits),
        cost: sum(items, (row) => row.costUsdUnits),
      }),
      deliveredUnits: sum(items, (row) => row.deliveredUnits),
      attemptsSent: supplierRows ? sum(items, (row) => row.attemptsSent ?? 0) : null,
      attemptsFailed: supplierRows ? failedTotal : null,
      failureRatePercent: supplierRows ? percent(failedTotal, resolvedTotal) : null,
    },
    ownerFunded: await ownerFundedFigures(db, period),
  };
}

/** R3 (rule RP5): deposits by method, decided (or expired) in the period. */
export async function depositsReport(
  db: Executor,
  period: ReportPeriod,
): Promise<Omit<DepositsReport, 'generatedAt'>> {
  const { rows } = await db.execute<{
    method: string;
    credited: string;
    credited_usd: string;
    received_syp: string;
    rejected: string;
    expired: string;
    median_minutes: string | null;
  }>(sql`
    select d.method::text as method,
      count(*) filter (where d.status = 'credited' and ${within(sql`d.decided_at`, period)}) as credited,
      coalesce(sum(d.credited_usd_units) filter (where d.status = 'credited' and ${within(sql`d.decided_at`, period)}), 0) as credited_usd,
      coalesce(sum(d.received_amount_units) filter (where d.status = 'credited' and d.received_currency = 'SYP' and ${within(sql`d.decided_at`, period)}), 0) as received_syp,
      count(*) filter (where d.status = 'rejected' and ${within(sql`d.decided_at`, period)}) as rejected,
      count(*) filter (where d.status = 'expired' and ${within(sql`d.expires_at`, period)}) as expired,
      percentile_cont(0.5) within group (order by extract(epoch from d.decided_at - d.submitted_at) / 60)
        filter (where d.status in ('credited', 'rejected') and d.submitted_at is not null
          and ${within(sql`d.decided_at`, period)}) as median_minutes
    from deposits d join customers c on c.id = d.customer_id
    where not c.is_test
      and (${within(sql`d.decided_at`, period)} or (d.status = 'expired' and ${within(sql`d.expires_at`, period)}))
    group by d.method`);
  const byMethod = new Map(rows.map((row) => [row.method, row]));
  const items = DEPOSIT_METHODS.map((method) => {
    const row = byMethod.get(method);
    return {
      method,
      credited: num(row?.credited),
      creditedUsdUnits: num(row?.credited_usd),
      rejected: num(row?.rejected),
      expired: num(row?.expired),
      receivedSypUnits: method === 'sham_cash' ? num(row?.received_syp) : null,
      medianReviewMinutes:
        method === 'sham_cash' && row?.median_minutes != null
          ? Math.round(Number(row.median_minutes) * 10) / 10
          : null,
    };
  });
  const { rows: manual } = await db.execute<{ count: string; usd: string }>(sql`
    select count(*) filter (where w.reverses_adjustment_id is null) as count,
      coalesce(sum(case when w.direction = 'credit' then w.amount_usd_units else -w.amount_usd_units end), 0) as usd
    from wallet_adjustments w join customers c on c.id = w.customer_id
    where w.category = 'manual_deposit' and not c.is_test and ${within(sql`w.created_at`, period)}`);
  return {
    ...period,
    rows: items,
    manualDeposits: { count: num(manual[0]?.count), usdUnits: num(manual[0]?.usd) },
    totals: {
      credited: sum(items, (row) => row.credited),
      creditedUsdUnits: sum(items, (row) => row.creditedUsdUnits),
      rejected: sum(items, (row) => row.rejected),
      expired: sum(items, (row) => row.expired),
    },
  };
}

/** R4 (rule RP6): refunds by reason, refund rates by product, failure rates by supplier. */
export async function refundsReport(
  db: Executor,
  period: ReportPeriod,
): Promise<Omit<RefundsReport, 'generatedAt'>> {
  const [reasons, products, suppliers] = await readAll(db, [
    () =>
      db.execute<{ reason: string; orders: string; usd: string }>(sql`
      select refund_reason::text as reason, count(*) as orders, sum(refunded_usd_units) as usd
      from (${finishedOrders(period)}) o
      where refunded_quantity > 0 group by refund_reason order by 3 desc`),
    () =>
      db.execute<{
        id: string;
        name_ar: string;
        game_name_ar: string;
        game_id: string;
        finished: string;
        refunded: string;
      }>(sql`
      select p.id, p.name_ar, g.name_ar as game_name_ar, g.id as game_id, count(*) as finished,
        count(*) filter (where o.status in ('refunded', 'partially_refunded')) as refunded
      from (${finishedOrders(period)}) o
      join catalog_products p on p.id = o.product_id join catalog_games g on g.id = o.game_id
      group by p.id, p.name_ar, g.id, g.name_ar`),
    () =>
      db.execute<{ code: string; name_ar: string; resolved: string; failed: string }>(sql`
      select s.code::text as code, s.name_ar, count(*) as resolved,
        count(*) filter (where f.status = 'failed') as failed
      from fulfilment_attempts f
      join orders o on o.id = f.order_id join suppliers s on s.id = f.supplier_id
      where not o.is_test and f.status in ('delivered', 'failed') and ${within(sql`f.resolved_at`, period)}
      group by s.code, s.name_ar`),
  ]);
  const byReason = reasons.rows.map((row) => ({
    reason: row.reason as RefundsReport['byReason'][number]['reason'],
    orders: num(row.orders),
    usdUnits: num(row.usd),
  }));
  return {
    ...period,
    byReason,
    products: products.rows
      .map((row) => ({
        productId: row.id,
        nameAr: row.name_ar,
        gameNameAr: row.game_name_ar,
        gameId: row.game_id,
        finished: num(row.finished),
        refunded: num(row.refunded),
        refundRatePercent: percent(num(row.refunded), num(row.finished)),
      }))
      .sort((a, b) => b.refunded - a.refunded || b.finished - a.finished),
    suppliers: suppliers.rows.map((row) => ({
      supplier: row.code as RefundsReport['suppliers'][number]['supplier'],
      nameAr: row.name_ar,
      resolved: num(row.resolved),
      failed: num(row.failed),
      failureRatePercent: percent(num(row.failed), num(row.resolved)),
    })),
    totals: {
      orders: sum(byReason, (row) => row.orders),
      usdUnits: sum(byReason, (row) => row.usdUnits),
    },
  };
}

/** R5 (rule RP7): the top customers by sales, with name and email only. */
export async function customersReport(
  db: Executor,
  period: ReportPeriod,
): Promise<Omit<CustomersReport, 'generatedAt'>> {
  const { rows } = await db.execute<{
    id: string;
    name: string;
    email: string;
    delivered: string;
    sales: string;
    cost: string;
    deposits: string;
  }>(sql`
    select c.id, c.name, c.email, sum(o.is_delivered) as delivered, sum(o.sales) as sales,
      sum(o.cost) as cost,
      coalesce((select sum(d.credited_usd_units) from deposits d
        where d.customer_id = c.id and d.status = 'credited' and ${within(sql`d.decided_at`, period)}), 0) as deposits
    from (${finishedOrders(period)}) o join customers c on c.id = o.customer_id
    group by c.id, c.name, c.email
    order by sum(o.sales) desc, c.id
    limit ${TOP_CUSTOMERS_LIMIT}`);
  const items = rows.map((row) => {
    const salesUsdUnits = num(row.sales);
    return {
      customerId: row.id,
      name: row.name,
      email: row.email,
      delivered: num(row.delivered),
      salesUsdUnits,
      profitUsdUnits: salesUsdUnits - num(row.cost),
      depositsUsdUnits: num(row.deposits),
    };
  });
  return {
    ...period,
    rows: items,
    totals: {
      delivered: sum(items, (row) => row.delivered),
      salesUsdUnits: sum(items, (row) => row.salesUsdUnits),
      profitUsdUnits: sum(items, (row) => row.profitUsdUnits),
      depositsUsdUnits: sum(items, (row) => row.depositsUsdUnits),
    },
  };
}

type LedgerLine = LedgerReport['rows'][number];

const OWNER_DRAWINGS_CODE = 'owner_drawings:USD';

/**
 * R6 (rule RP8): the ledger's USD money movement by journal day, and each place at the start and
 * the end. Lines that touch a wallet show test customers' share apart. A treasury movement counts
 * at its USD side; one with no USD side (pounds to pounds) is left out.
 */
export async function ledgerReport(
  db: Executor,
  period: ReportPeriod,
): Promise<Omit<LedgerReport, 'generatedAt'>> {
  const { rows } = await db.execute<{
    day: string;
    line: LedgerLine['line'];
    detail: string | null;
    real: string;
    test: string | null;
  }>(sql`
    with journal as (
      select j.id, j.kind::text as kind, ${dayOf(sql`j.created_at`)} as day
      from ledger_journals j where ${within(sql`j.created_at`, period)}
    ),
    wallet as (
      select p.journal_id, sum(p.amount_units) as amount, bool_or(c.is_test) as test
      from ledger_postings p join ledger_accounts a on a.id = p.account_id
      join customers c on c.id = a.customer_id
      where a.kind = 'customer_wallet' and p.journal_id in (select id from journal)
      group by p.journal_id
    ),
    system as (
      select p.journal_id, a.code, sum(p.amount_units) as amount
      from ledger_postings p join ledger_accounts a on a.id = p.account_id
      where a.kind <> 'customer_wallet' and p.currency = 'USD' and p.journal_id in (select id from journal)
      group by p.journal_id, a.code
    ),
    lines as (
      select j.day, 'deposit' as line, d.method::text as detail, w.amount, w.test
      from journal j join wallet w on w.journal_id = j.id left join deposits d on d.journal_id = j.id
      where j.kind = 'deposit'
      union all
      select j.day, 'purchase', null, -w.amount, w.test
      from journal j join wallet w on w.journal_id = j.id where j.kind = 'purchase'
      union all
      select j.day, 'refund', null, w.amount, w.test
      from journal j join wallet w on w.journal_id = j.id where j.kind = 'refund'
      union all
      select j.day, case when w.amount > 0 then 'adjustment_credit' else 'adjustment_debit' end,
        a.category::text, abs(w.amount), w.test
      from journal j join wallet w on w.journal_id = j.id
      left join wallet_adjustments a on a.journal_id = j.id
      where j.kind = 'adjustment'
      union all
      select j.day, 'cost_of_goods', null, -s.amount, null
      from journal j join system s on s.journal_id = j.id
      where j.kind = 'cost_of_goods' and s.code = 'cost_of_goods:USD'
      union all
      select j.day, 'transfer_fee', null, -s.amount, null
      from journal j join system s on s.journal_id = j.id where s.code = 'transfer_fees:USD'
      union all
      select j.day, 'rounding_gain', null, s.amount, null
      from journal j join system s on s.journal_id = j.id where s.code = 'deposit_rounding:USD'
      union all
      -- S16 AM2, AM3: owner-funded orders and their refunds.
      select j.day, case when j.kind = 'purchase' then 'owner_drawing' else 'owner_drawing_refund' end,
        null, abs(s.amount), null
      from journal j join system s on s.journal_id = j.id
      where j.kind in ('purchase', 'refund') and s.code = 'owner_drawings:USD'
      union all
      select j.day,
        case
          when m.kind = 'supplier_correction' then 'supplier_correction'
          when fa.kind = 'outside_funds' then 'treasury_injection'
          when ta.kind = 'outside_funds' then 'treasury_withdrawal'
          when ta.kind = 'supplier_prepaid' then 'treasury_funding'
          else 'treasury_transfer'
        end,
        null,
        (case when m.reverses_movement_id is null then 1 else -1 end)
          * (case
            when m.kind = 'supplier_correction' and ta.kind = 'supplier_prepaid' then m.received_units
            when m.kind = 'supplier_correction' then -m.sent_units
            when m.received_currency = 'USD' then m.received_units
            else m.sent_units
          end),
        null
      from journal j join treasury_movements m on m.journal_id = j.id
      join ledger_accounts fa on fa.id = m.from_account_id
      join ledger_accounts ta on ta.id = m.to_account_id
      where 'USD' in (m.sent_currency::text, m.received_currency::text)
    )
    select day, line, detail,
      coalesce(sum(amount) filter (where test is distinct from true), 0)::text as real,
      case when bool_or(test is not null) then coalesce(sum(amount) filter (where test), 0)::text end as test
    from lines group by day, line, detail order by day, line, detail`);
  const items = rows.map((row) => ({
    date: row.day,
    line: row.line,
    detail: row.detail as LedgerLine['detail'],
    usdUnits: num(row.real),
    testUsdUnits: row.test === null ? null : num(row.test),
  }));
  const totals = new Map<string, Omit<LedgerLine, 'date'>>();
  for (const { date: _date, ...item } of items) {
    const key = `${item.line}/${item.detail}`;
    const total = totals.get(key);
    totals.set(
      key,
      total
        ? {
            ...total,
            usdUnits: total.usdUnits + item.usdUnits,
            testUsdUnits:
              total.testUsdUnits === null && item.testUsdUnits === null
                ? null
                : (total.testUsdUnits ?? 0) + (item.testUsdUnits ?? 0),
          }
        : { ...item },
    );
  }
  const { rows: balances } = await db.execute<{ code: string; start: string; finish: string }>(sql`
    select a.code,
      coalesce(sum(p.amount_units) filter (where j.created_at < ${startOf(period)}), 0)::text as start,
      coalesce(sum(p.amount_units) filter (where j.created_at < ${endOf(period)}), 0)::text as finish
    from ledger_accounts a
    join ledger_postings p on p.account_id = a.id join ledger_journals j on j.id = p.journal_id
    where a.code in (${sql.join(
      [
        ...TREASURY_PLACES.map((place) => sql`${TREASURY_ACCOUNTS[place].code}`),
        sql`${OWNER_DRAWINGS_CODE}`,
      ],
      sql`, `,
    )})
    group by a.code`);
  const byCode = new Map(balances.map((row) => [row.code, row]));
  return {
    ...period,
    rows: items,
    totals: [...totals.values()],
    places: TREASURY_PLACES.map((place) => {
      const account = TREASURY_ACCOUNTS[place];
      const row = byCode.get(account.code);
      return {
        place,
        currency: account.currency,
        startUnits: heldUnits(account.kind, num(row?.start)),
        endUnits: heldUnits(account.kind, num(row?.finish)),
      };
    }),
    ownerDrawings: {
      startUnits: heldUnits('owner_drawings', num(byCode.get(OWNER_DRAWINGS_CODE)?.start)),
      endUnits: heldUnits('owner_drawings', num(byCode.get(OWNER_DRAWINGS_CODE)?.finish)),
    },
  };
}
