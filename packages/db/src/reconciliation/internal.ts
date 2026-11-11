import {
  CURRENCIES,
  type InternalCheck,
  JOURNAL_ACCOUNT_KINDS,
  RECONCILIATION_MAX_OFFENDING_IDS,
} from '@vertex-digital/contracts';
import { type SQL, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../client.js';
import { type CheckResult, noDetails, type Offending, units } from './types.js';

/*
 * The internal checks (S13 rules C1–C10, RN3): exact, any difference is a mismatch. They run as SQL
 * aggregates in one `REPEATABLE READ` read-only transaction, so every check sees one snapshot of
 * the ledger and the records it is compared with. Each failing check lists up to 50 offending ids
 * and the total count, newest first (UUIDv7 ids).
 */

/** A check's result from the `(kind, id)` rows its query finds: none is `ok`. */
async function offendingResult(
  tx: Transaction,
  check: InternalCheck,
  subject: string,
  query: SQL,
): Promise<CheckResult> {
  const { rows } = await tx.execute<{ kind: Offending['kind']; id: string; total: string }>(sql`
    select kind, id, count(*) over () as total
    from (${query}) as offending (kind, id)
    order by id desc
    limit ${RECONCILIATION_MAX_OFFENDING_IDS}`);
  const offendingCount = rows.length === 0 ? 0 : units(rows[0]?.total);
  return {
    check,
    subject,
    status: offendingCount === 0 ? 'ok' : 'mismatch',
    currency: null,
    booksUnits: null,
    actualUnits: null,
    differenceUnits: null,
    allowedLowUnits: null,
    allowedHighUnits: null,
    offendingCount,
    details: {
      ...noDetails(),
      offending: rows.map((row) => ({ kind: row.kind, id: row.id })),
    },
  };
}

/** An exact comparison of two amounts in USD (books against what the records add up to). */
function amountResult(
  check: InternalCheck,
  subject: string,
  booksUnits: number,
  actualUnits: number,
): CheckResult {
  const differenceUnits = actualUnits - booksUnits;
  return {
    check,
    subject,
    status: differenceUnits === 0 ? 'ok' : 'mismatch',
    currency: 'USD',
    booksUnits,
    actualUnits,
    differenceUnits,
    allowedLowUnits: actualUnits,
    allowedHighUnits: actualUnits,
    offendingCount: differenceUnits === 0 ? 0 : 1,
    details: noDetails(),
  };
}

async function accountTotal(tx: Transaction, code: string): Promise<number> {
  const { rows } = await tx.execute<{ total: string }>(sql`
    select coalesce(sum(p.amount_units), 0)::text as total
    from ledger_postings p join ledger_accounts a on a.id = p.account_id
    where a.code = ${code}`);
  return units(rows[0]?.total);
}

/** The wallet postings of a journal for one customer, summed. */
const walletLeg = (journal: SQL, customer: SQL) => sql`coalesce((
  select sum(p.amount_units) from ledger_postings p
  join ledger_accounts a on a.id = p.account_id
  where p.journal_id = ${journal} and a.kind = 'customer_wallet' and a.customer_id = ${customer}
), 0)`;

/** S16 AM2, AM3: what a journal moved on owner drawings. */
const drawingsLeg = (journal: SQL) => sql`coalesce((
  select sum(p.amount_units) from ledger_postings p
  join ledger_accounts a on a.id = p.account_id
  where p.journal_id = ${journal} and a.code = 'owner_drawings:USD'
), 0)`;

/** S26: the shop wallet postings of a journal for one shop customer, summed. */
const shopWalletLeg = (journal: SQL, shopCustomer: SQL) => sql`coalesce((
  select sum(p.amount_units) from ledger_postings p
  join ledger_accounts a on a.id = p.account_id
  where p.journal_id = ${journal} and a.kind = 'shop_customer_wallet'
    and a.shop_customer_id = ${shopCustomer}
), 0)`;

/** Every customer wallet a journal touched, in absolute units. */
const customerWallets = (journal: SQL) => sql`coalesce((select sum(abs(p.amount_units))
  from ledger_postings p join ledger_accounts a on a.id = p.account_id
  where p.journal_id = ${journal} and a.kind = 'customer_wallet'), 0)`;

/**
 * What a journal of order `o` moved on its payer: the customer's wallet, owner drawings, or (S26
 * PR6) the shop customer's wallet of a shop order.
 */
const payerLeg = (journal: SQL) => sql`case when o.payer = 'owner' then ${drawingsLeg(journal)}
  when o.shop_customer_id is not null then ${shopWalletLeg(journal, sql`o.shop_customer_id`)}
  else ${walletLeg(journal, sql`o.customer_id`)} end`;

/**
 * The other payers' legs, which must be zero: an owner order touches no wallet, a customer's order
 * no drawings, and a shop order neither the merchant's wallet nor drawings.
 */
const otherLeg = (journal: SQL) => sql`case when o.payer = 'owner' then ${customerWallets(journal)}
  when o.shop_customer_id is not null
    then ${customerWallets(journal)} + abs(${drawingsLeg(journal)})
  else ${drawingsLeg(journal)} end`;

/** S26 PR6: a shop order's selling total of `units`, its sale row joined as `s` (else null). */
const sellTotal = (units: SQL) => sql`s.unit_sell_usd_units * ${units}`;

/** C1: every journal balances per currency and has exactly `posting_count` postings. */
const journalBalance = sql`
  select 'journal', j.id from ledger_journals j
  left join (select journal_id, count(*) as n from ledger_postings group by journal_id) p
    on p.journal_id = j.id
  where coalesce(p.n, 0) <> j.posting_count
  union
  select 'journal', journal_id from ledger_postings
  group by journal_id, currency having sum(amount_units) <> 0`;

/** C3: no customer wallet, and (S26, ADR 0040) no shop customer wallet, below zero. */
const walletNonNegative = sql`
  select 'customer', a.customer_id from ledger_accounts a
  join ledger_postings p on p.account_id = a.id
  where a.kind = 'customer_wallet'
  group by a.customer_id having sum(p.amount_units) < 0
  union
  select 'shop_customer', a.shop_customer_id from ledger_accounts a
  join ledger_postings p on p.account_id = a.id
  where a.kind = 'shop_customer_wallet'
  group by a.shop_customer_id having sum(p.amount_units) < 0`;

/** C4: every posting's account kind is allowed for its journal kind. */
function accountJournalKinds(): SQL {
  const pairs = Object.entries(JOURNAL_ACCOUNT_KINDS).flatMap(([journal, accounts]) =>
    accounts.map((account) => sql`(${journal}, ${account})`),
  );
  return sql`
    select distinct 'journal', j.id from ledger_postings p
    join ledger_journals j on j.id = p.journal_id
    join ledger_accounts a on a.id = p.account_id
    where (j.kind::text, a.kind::text) not in (values ${sql.join(pairs, sql`, `)})`;
}

/**
 * C5 (rule LS1): every attempt that delivered at a cost has one cost journal of `unit cost ×
 * delivered units`, `cost_of_goods:USD` −cost and `supplier_prepaid:<its supplier>` +cost; no
 * cost journal without such an attempt, and no cost journal on an attempt without a cost.
 */
const attemptCost = sql`
  with expected as (
    select f.id, f.cost_journal_id as journal_id,
      f.unit_cost_usd_units * f.delivered_quantity as cost,
      'supplier_prepaid:' || s.code as prepaid
    from fulfilment_attempts f join suppliers s on s.id = f.supplier_id
    where f.delivered_quantity > 0 and f.unit_cost_usd_units > 0
  )
  select 'attempt', e.id from expected e
  where e.journal_id is null
    or (select count(*) from ledger_postings p where p.journal_id = e.journal_id) <> 2
    or not exists (select 1 from ledger_postings p join ledger_accounts a on a.id = p.account_id
      where p.journal_id = e.journal_id and a.code = 'cost_of_goods:USD' and p.amount_units = -e.cost)
    or not exists (select 1 from ledger_postings p join ledger_accounts a on a.id = p.account_id
      where p.journal_id = e.journal_id and a.code = e.prepaid and p.amount_units = e.cost)
  union
  select 'attempt', f.id from fulfilment_attempts f
  where f.cost_journal_id is not null and not (f.delivered_quantity > 0 and f.unit_cost_usd_units > 0)
  union
  select 'journal', j.id from ledger_journals j
  where j.kind = 'cost_of_goods'
    and not exists (select 1 from fulfilment_attempts f where f.cost_journal_id = j.id)`;

/**
 * C6: every paid order has a purchase journal; a single order's journal takes its total from its
 * customer's wallet (S16 AP15: an owner-funded order's from owner drawings, and nothing from a
 * wallet), a checkout's journal the sum of its orders' totals; every purchase journal belongs to
 * an order.
 */
const orderPurchase = sql`
  select 'order', o.id from orders o
  where (o.paid_at is not null) <> (o.purchase_journal_id is not null)
  union
  select 'order', o.id from orders o
  where o.shop_customer_id is not null
    and not exists (select 1 from shop_order_sales s
      where s.order_id = o.id and s.shop_customer_id = o.shop_customer_id
        and s.unit_buy_usd_units = o.unit_price_usd_units and s.quantity = o.quantity)
  union
  select 'order', o.id from orders o
  left join shop_order_sales s on s.order_id = o.id
  where o.checkout_id is null and o.purchase_journal_id is not null
    and (${payerLeg(sql`o.purchase_journal_id`)}
        <> -coalesce(${sellTotal(sql`o.quantity`)}, o.total_usd_units)
      or ${otherLeg(sql`o.purchase_journal_id`)} <> 0)
  union
  select 'journal', o.purchase_journal_id from orders o
  where o.checkout_id is not null and o.purchase_journal_id is not null
  group by o.purchase_journal_id, o.customer_id
  having ${walletLeg(sql`o.purchase_journal_id`, sql`o.customer_id`)} <> -sum(o.total_usd_units)
  union
  select 'journal', j.id from ledger_journals j
  where j.kind = 'purchase'
    and not exists (select 1 from orders o where o.purchase_journal_id = j.id)`;

/**
 * C7: an order's refund equals its refund journal's wallet credit (S16 AP15: owner drawings' for
 * an owner-funded order; none when nothing was refunded); every refund journal belongs to one
 * order.
 */
const orderRefund = sql`
  select 'order', o.id from orders o
  left join shop_order_sales s on s.order_id = o.id
  where (o.refund_journal_id is null) <> (o.refunded_usd_units = 0)
    or (o.refund_journal_id is not null
      and (${payerLeg(sql`o.refund_journal_id`)}
          <> coalesce(${sellTotal(sql`o.refunded_quantity`)}, o.refunded_usd_units)
        or ${otherLeg(sql`o.refund_journal_id`)} <> 0))
  union
  select 'journal', j.id from ledger_journals j
  where j.kind = 'refund'
    and (select count(*) from orders o where o.refund_journal_id = j.id) <> 1`;

/**
 * C8: every credited deposit has its journal `deposit:<id>` with the postings S03 M1–M2 and S04
 * M1 name: the wallet gets the credit; Sham Cash USD from its receipts; Sham Cash SYP the pounds
 * received through the exchange; USDT the amount received from the network's receipts, the rest
 * to rounding. No deposit journal without a credited deposit.
 */
const depositCredit = sql`
  with credited as (
    select d.id, d.journal_id, d.customer_id, d.method::text as method,
      d.received_currency::text as currency,
      coalesce(d.received_amount_units, 0) as received, coalesce(d.credited_usd_units, 0) as credit,
      coalesce(t.method::text, d.method::text) as network
    from deposits d
    left join usdt_deposits u on u.deposit_id = d.id
    left join usdt_transfers t on t.id = u.transfer_id
    where d.status = 'credited'
  ),
  expected as (
    select id, 'customer_wallet:' || customer_id as code, credit as amount from credited
    union all
    select id, 'sham_cash_receipts:USD', -credit from credited
    where method = 'sham_cash' and currency = 'USD'
    union all
    select id, 'sham_cash_receipts:SYP', -received from credited
    where method = 'sham_cash' and currency = 'SYP'
    union all
    select id, 'currency_exchange:SYP', received from credited
    where method = 'sham_cash' and currency = 'SYP'
    union all
    select id, 'currency_exchange:USD', -credit from credited
    where method = 'sham_cash' and currency = 'SYP'
    union all
    select id, 'usdt_receipts:' || network, -received from credited where method <> 'sham_cash'
    union all
    select id, 'deposit_rounding:USD', received - credit from credited
    where method <> 'sham_cash' and received > credit
  ),
  actual as (
    select c.id, a.code, sum(p.amount_units) as amount
    from credited c
    join ledger_postings p on p.journal_id = c.journal_id
    join ledger_accounts a on a.id = p.account_id
    group by c.id, a.code
  )
  select 'deposit', coalesce(e.id, a.id) from expected e
  full join actual a on a.id = e.id and a.code = e.code
  where e.amount is distinct from a.amount
  union
  select 'deposit', c.id from credited c
  left join ledger_journals j on j.id = c.journal_id
  where j.id is null or j.idempotency_key <> 'deposit:' || c.id
  union
  select 'journal', j.id from ledger_journals j
  where j.kind = 'deposit'
    and not exists (select 1 from deposits d where d.journal_id = j.id and d.status = 'credited')`;

/**
 * C9: every adjustment (S02 M1–M3) and treasury movement (S13 M1–M4) has its journal with the
 * accounts, amounts and signs its row says; no `adjustment` or `treasury` journal without its row.
 * S26: so does every shop transfer, return and settlement (WL1, WL5, WL9), named by its journal;
 * no `shop_transfer` journal without its row, and a settlement's cash `adjustment` counts as one.
 */
const manualJournals = sql`
  with adjustment as (
    select w.id, w.journal_id, w.customer_id, w.category::text as category,
      case when w.direction = 'credit' then w.amount_usd_units else -w.amount_usd_units end as signed
    from wallet_adjustments w
  ),
  movement as (
    select m.id, m.journal_id, f.code as from_code, t.code as to_code,
      m.sent_currency::text as sent_currency, m.received_currency::text as received_currency,
      m.sent_units as sent, m.received_units as received,
      case when m.reverses_movement_id is null then 1 else -1 end as sign
    from treasury_movements m
    join ledger_accounts f on f.id = m.from_account_id
    join ledger_accounts t on t.id = m.to_account_id
  ),
  shop_money as (
    select t.journal_id, 'customer_wallet:' || s.merchant_id as merchant_code,
      'shop_customer_wallet:' || t.shop_customer_id as shop_code,
      case when t.direction = 'to_customer' then t.amount_usd_units else -t.amount_usd_units end
        as to_customer
    from shop_transfers t
    join merchant_shops s on s.id = t.shop_id
    union all
    select x.journal_id,
      case when x.target = 'merchant' then 'customer_wallet:' || s.merchant_id
        else 'adjustments:cash_refund' end,
      'shop_customer_wallet:' || x.shop_customer_id, -x.amount_usd_units
    from shop_settlements x
    join merchant_shops s on s.id = x.shop_id
    union all
    -- S26 PR10: Vertex's part (and the margin when the store covers it) from the adjustments,
    -- the margin part from the merchant's wallet.
    select c.adjustment_journal_id, 'adjustments:compensation',
      'shop_customer_wallet:' || c.shop_customer_id,
      c.vertex_usd_units + case when c.margin_from = 'store' then c.margin_usd_units else 0 end
    from shop_compensations c
    union all
    select c.margin_journal_id, 'customer_wallet:' || s.merchant_id,
      'shop_customer_wallet:' || c.shop_customer_id, c.margin_usd_units
    from shop_compensations c
    join merchant_shops s on s.id = c.shop_id
    where c.margin_journal_id is not null
  ),
  expected as (
    select 'adjustment' as kind, id, journal_id, 'customer_wallet:' || customer_id as code,
      signed as amount from adjustment
    union all
    select 'adjustment', id, journal_id, 'adjustments:' || category, -signed from adjustment
    union all
    select 'movement', id, journal_id, from_code, sign * sent from movement
    union all
    select 'movement', id, journal_id, to_code, -sign * received from movement
    union all
    select 'movement', id, journal_id, 'transfer_fees:' || sent_currency, -sign * (sent - received)
    from movement where sent_currency = received_currency and sent > received
    union all
    select 'movement', id, journal_id, 'currency_exchange:' || sent_currency, -sign * sent
    from movement where sent_currency <> received_currency
    union all
    select 'movement', id, journal_id, 'currency_exchange:' || received_currency, sign * received
    from movement where sent_currency <> received_currency
    union all
    select 'journal', journal_id, journal_id, merchant_code, -to_customer from shop_money
    union all
    select 'journal', journal_id, journal_id, shop_code, to_customer from shop_money
  ),
  owners as (select distinct kind, id, journal_id from expected),
  actual as (
    select o.kind, o.id, a.code, sum(p.amount_units) as amount
    from owners o
    join ledger_postings p on p.journal_id = o.journal_id
    join ledger_accounts a on a.id = p.account_id
    group by o.kind, o.id, a.code
  )
  select coalesce(e.kind, a.kind), coalesce(e.id, a.id) from expected e
  full join actual a on a.kind = e.kind and a.id = e.id and a.code = e.code
  where e.amount is distinct from a.amount
  union
  select 'journal', j.id from ledger_journals j
  where (j.kind = 'adjustment'
      and not exists (select 1 from wallet_adjustments w where w.journal_id = j.id)
      and not exists (select 1 from shop_settlements x where x.journal_id = j.id)
      and not exists (select 1 from shop_compensations c where c.adjustment_journal_id = j.id))
    or (j.kind = 'treasury'
      and not exists (select 1 from treasury_movements m where m.journal_id = j.id))
    or (j.kind = 'shop_transfer'
      and not exists (select 1 from shop_transfers t where t.journal_id = j.id)
      and not exists (select 1 from shop_settlements x where x.journal_id = j.id))`;

/**
 * S26 PR8 (C10): every terminal shop order released the margin of its delivered units, once, with
 * its `shop-margin:<order>` journal (held −m, the merchant's wallet +m) or none at zero; an open
 * one released nothing. Every `shop_margin` journal is such a release or a compensation's margin.
 */
const shopMargins = sql`
  with sale as (
    select o.id, o.customer_id, o.finished_at,
      (s.unit_sell_usd_units - s.unit_buy_usd_units) * o.delivered_quantity as due,
      s.margin_released_usd_units as released,
      (select j.id from ledger_journals j
        where j.idempotency_key = 'shop-margin:' || o.id) as journal_id
    from orders o join shop_order_sales s on s.order_id = o.id
  )
  select 'order', sale.id from sale
  where (sale.finished_at is null and (sale.released is not null or sale.journal_id is not null))
    or (sale.finished_at is not null and sale.released is distinct from sale.due)
    or ((sale.journal_id is not null) <> (coalesce(sale.released, 0) > 0))
    or (sale.journal_id is not null and (
      ${walletLeg(sql`sale.journal_id`, sql`sale.customer_id`)} <> sale.released
      or coalesce((select sum(p.amount_units) from ledger_postings p
        join ledger_accounts a on a.id = p.account_id
        where p.journal_id = sale.journal_id and a.code = 'shop_margin_held:USD'), 0)
        <> -sale.released))
  union
  select 'journal', j.id from ledger_journals j
  where j.kind = 'shop_margin'
    and not exists (select 1 from orders o where j.idempotency_key = 'shop-margin:' || o.id)
    and not exists (select 1 from shop_compensations c where c.margin_journal_id = j.id)`;

export interface InternalChecks {
  /** The highest posting position the snapshot held; null on an empty ledger. */
  snapshotPosition: number | null;
  results: CheckResult[];
}

/** Rule RN3: C1–C10 in one `REPEATABLE READ` read-only snapshot. */
export function runInternalChecks(db: Database): Promise<InternalChecks> {
  return db.transaction((tx) => internalChecks(tx), {
    isolationLevel: 'repeatable read',
    accessMode: 'read only',
  });
}

/** C1–C10 in the caller's transaction, which `runInternalChecks` makes one snapshot. */
export async function internalChecks(tx: Transaction): Promise<InternalChecks> {
  const { rows } = await tx.execute<{ position: string | null }>(
    sql`select max(position)::text as position from ledger_postings`,
  );
  const position = rows[0]?.position ?? null;
  const results: CheckResult[] = [];
  results.push(await offendingResult(tx, 'journal_balance', 'ledger', journalBalance));
  // C2: all postings sum to zero per currency.
  const totals = await tx.execute<{ currency: string; total: string }>(
    sql`select currency::text, sum(amount_units)::text as total from ledger_postings group by currency`,
  );
  for (const currency of CURRENCIES) {
    const total = units(totals.rows.find((row) => row.currency === currency)?.total);
    results.push({
      ...amountResult('ledger_total', `ledger:${currency}`, total, 0),
      currency,
    });
  }
  results.push(await offendingResult(tx, 'wallet_non_negative', 'wallets', walletNonNegative));
  results.push(await offendingResult(tx, 'account_journal_kinds', 'ledger', accountJournalKinds()));
  results.push(await offendingResult(tx, 'attempt_cost', 'attempts', attemptCost));
  results.push(await offendingResult(tx, 'order_purchase', 'orders', orderPurchase));
  const paid = await tx.execute<{ total: string }>(
    sql`select coalesce(sum(total_usd_units), 0)::text as total from orders where paid_at is not null`,
  );
  results.push(
    amountResult(
      'order_purchase',
      'sales_revenue:USD',
      await accountTotal(tx, 'sales_revenue:USD'),
      units(paid.rows[0]?.total),
    ),
  );
  results.push(await offendingResult(tx, 'order_refund', 'orders', orderRefund));
  const refunded = await tx.execute<{ total: string }>(
    sql`select coalesce(sum(refunded_usd_units), 0)::text as total from orders`,
  );
  results.push(
    amountResult(
      'order_refund',
      'refunds:USD',
      -(await accountTotal(tx, 'refunds:USD')),
      units(refunded.rows[0]?.total),
    ),
  );
  results.push(await offendingResult(tx, 'deposit_credit', 'deposits', depositCredit));
  results.push(await offendingResult(tx, 'manual_journals', 'ledger', manualJournals));
  results.push(await offendingResult(tx, 'shop_margin_held', 'orders', shopMargins));
  // C10: what the held account holds is the open shop orders' margins, net of their refunds.
  const held = await tx.execute<{ total: string }>(sql`
    select coalesce(sum((s.unit_sell_usd_units - s.unit_buy_usd_units)
      * (o.quantity - o.refunded_quantity) - coalesce(s.margin_released_usd_units, 0)), 0)::text
      as total
    from orders o join shop_order_sales s on s.order_id = o.id
    where o.paid_at is not null`);
  results.push(
    amountResult(
      'shop_margin_held',
      'shop_margin_held:USD',
      await accountTotal(tx, 'shop_margin_held:USD'),
      units(held.rows[0]?.total),
    ),
  );
  return { snapshotPosition: position === null ? null : units(position), results };
}
