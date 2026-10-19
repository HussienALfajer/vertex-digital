import {
  CHARGE_MISMATCH_BP,
  type Currency,
  heldUnits,
  RECONCILIATION_MAX_OFFENDING_IDS,
  type ReconciliationDetails,
  type SupplierCode,
  supplierPlace,
  TREASURY_ACCOUNTS,
  type TreasuryPlace,
  type UsdtMethod,
  withinRange,
} from '@vertex-digital/contracts';
import { sql } from 'drizzle-orm';
import type { Database, Transaction } from '../client.js';
import { type CheckResult, noDetails, units } from './types.js';

/*
 * The external checks (S13 rules E1–E6, RN4): a real balance against the books, within a range of
 * money in flight plus the tolerance. The caller reads the outside balance first, then calls these
 * in a fresh read, so a movement posted between the two is in the books.
 */

type Executor = Database | Transaction;

/** Rule LS2: what the books say a place holds. */
export async function placeBooks(db: Executor, place: TreasuryPlace): Promise<number> {
  const account = TREASURY_ACCOUNTS[place];
  const { rows } = await db.execute<{ total: string }>(sql`
    select coalesce(sum(p.amount_units), 0)::text as total
    from ledger_postings p join ledger_accounts a on a.id = p.account_id
    where a.code = ${account.code}`);
  return heldUnits(account.kind, units(rows[0]?.total));
}

/** Rule T6: true when an opening balance into the place stands (not reversed). */
export async function openingRecorded(db: Executor, place: TreasuryPlace): Promise<boolean> {
  const { rows } = await db.execute<{ found: boolean }>(sql`
    select exists (
      select 1 from treasury_movements m
      join ledger_accounts a on a.id = m.to_account_id
      where a.code = ${TREASURY_ACCOUNTS[place].code} and m.opening_balance
        and not exists (select 1 from treasury_movements r where r.reverses_movement_id = m.id)
    ) as found`);
  return rows[0]?.found === true;
}

interface Line {
  kind: ReconciliationDetails['lines'][number]['kind'];
  id: string;
  amountUnits: number;
}

type ExternalCheckName =
  | 'supplier_balance'
  | 'usdt_balance'
  | 'sham_cash_count'
  | 'supplier_charges';

/** A result from the books, the actual balance and the range it may fall in (rule E1). */
function rangeResult(input: {
  check: ExternalCheckName;
  place: TreasuryPlace;
  currency: Currency;
  booksUnits: number;
  actualUnits: number;
  lowUnits: number;
  highUnits: number;
  toleranceUnits: number;
  lines: Line[];
}): CheckResult {
  const ok = withinRange(input.actualUnits, input.lowUnits, input.highUnits, input.toleranceUnits);
  return {
    check: input.check,
    subject: input.place,
    status: ok ? 'ok' : 'mismatch',
    currency: input.currency,
    booksUnits: input.booksUnits,
    actualUnits: input.actualUnits,
    differenceUnits: input.actualUnits - input.booksUnits,
    allowedLowUnits: input.lowUnits,
    allowedHighUnits: input.highUnits,
    offendingCount: ok ? 0 : 1,
    details: { ...noDetails(), lines: input.lines.slice(0, RECONCILIATION_MAX_OFFENDING_IDS) },
  };
}

/** A skipped external check (rules E2, E5, RN4): no amounts compared, the reason in details. */
export function skippedResult(
  check: ExternalCheckName,
  place: TreasuryPlace,
  reason: ReconciliationDetails['reason'],
  booksUnits: number | null = null,
  /** A count keeps the amount the admin typed: its replay and the proposed opening read it. */
  actualUnits: number | null = null,
): CheckResult {
  return {
    check,
    subject: place,
    status: 'skipped',
    currency: TREASURY_ACCOUNTS[place].currency,
    booksUnits,
    actualUnits,
    differenceUnits: null,
    allowedLowUnits: null,
    allowedHighUnits: null,
    offendingCount: 0,
    details: { ...noDetails(), reason },
  };
}

/**
 * Rule E2: a supplier's balance read now against the held amount on `supplier_prepaid:<code>`; the
 * range is `[held − in flight, held]`, in flight = Σ unit cost × quantity of its open attempts,
 * since a supplier may charge before it delivers.
 */
export async function supplierBalanceCheck(
  db: Executor,
  input: { supplier: SupplierCode; actualUnits: number; toleranceUsdUnits: number },
): Promise<CheckResult> {
  const place = supplierPlace(input.supplier);
  const booksUnits = await placeBooks(db, place);
  if (!(await openingRecorded(db, place))) {
    return skippedResult('supplier_balance', place, 'opening_missing', booksUnits);
  }
  const { rows } = await db.execute<{ id: string; amount: string }>(sql`
    select f.id, (f.unit_cost_usd_units * f.quantity)::text as amount
    from fulfilment_attempts f join suppliers s on s.id = f.supplier_id
    where s.code = ${input.supplier} and f.status in ('sending', 'pending', 'unknown')
    order by f.id`);
  const lines = rows.map((row) => ({
    kind: 'in_flight_attempt' as const,
    id: row.id,
    amountUnits: units(row.amount),
  }));
  const inFlight = lines.reduce((sum, line) => sum + line.amountUnits, 0);
  return rangeResult({
    check: 'supplier_balance',
    place,
    currency: 'USD',
    booksUnits,
    actualUnits: input.actualUnits,
    lowUnits: booksUnits - inFlight,
    highUnits: booksUnits,
    toleranceUnits: input.toleranceUsdUnits,
    lines,
  });
}

/** S18 RC1: one order of the supplier's day, as its statement gives it. */
export interface SupplierDayOrder {
  supplierOrderId: string;
  status: string | null;
  totalUnits: number | null;
}

const SUPPLIER_FAILED_STATUSES = new Set(['failed', 'refunded', 'cancelled']);

/**
 * S18 RC1, RC2: what a supplier charged for the orders of a business day against our attempts
 * that name them. Actual = Σ the totals of its `completed` orders; books = Σ unit cost × units
 * delivered of the attempts they name; within the tolerance, and every order accounted for, it is
 * `ok`. Lines: an attempt charged more than 2% off its cost (`charge_differs`, the difference),
 * completed there but failed here (`delivered_but_failed`, the charge), failed or refunded there
 * but delivered here (`failed_but_delivered`, the cost); orders no attempt names are listed by the
 * supplier's id (`unmatchedSupplierOrders`): money spent we do not count.
 */
export async function supplierChargesCheck(
  db: Executor,
  input: { supplier: SupplierCode; orders: SupplierDayOrder[]; toleranceUsdUnits: number },
): Promise<CheckResult> {
  const place = supplierPlace(input.supplier);
  const ids = [...new Set(input.orders.map((order) => order.supplierOrderId))];
  const { rows } =
    ids.length === 0
      ? { rows: [] }
      : await db.execute<{
          id: string;
          supplier_order_id: string;
          status: string;
          cost: string;
        }>(sql`
    select distinct on (f.supplier_order_id) f.id, f.supplier_order_id, f.status::text as status,
      (f.unit_cost_usd_units * f.delivered_quantity)::text as cost
    from fulfilment_attempts f join suppliers s on s.id = f.supplier_id
    where s.code = ${input.supplier}
      and f.supplier_order_id in (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})
    order by f.supplier_order_id, f.created_at desc, f.id desc`);
  const attempts = new Map(rows.map((row) => [row.supplier_order_id, row]));
  const lines: Line[] = [];
  const unmatched: string[] = [];
  let actualUnits = 0;
  let booksUnits = 0;
  for (const order of input.orders) {
    const status = order.status?.toLowerCase() ?? '';
    const charged = status === 'completed' ? (order.totalUnits ?? 0) : 0;
    actualUnits += charged;
    const attempt = attempts.get(order.supplierOrderId);
    if (!attempt) {
      if (status === 'completed') unmatched.push(order.supplierOrderId.slice(0, 64));
      continue;
    }
    const cost = units(attempt.cost);
    booksUnits += cost;
    if (status === 'completed' && attempt.status === 'failed') {
      lines.push({ kind: 'delivered_but_failed', id: attempt.id, amountUnits: charged });
    } else if (SUPPLIER_FAILED_STATUSES.has(status) && cost > 0) {
      lines.push({ kind: 'failed_but_delivered', id: attempt.id, amountUnits: cost });
    } else if (
      status === 'completed' &&
      order.totalUnits !== null &&
      Math.abs(order.totalUnits - cost) * 10_000 > cost * CHARGE_MISMATCH_BP
    ) {
      lines.push({ kind: 'charge_differs', id: attempt.id, amountUnits: order.totalUnits - cost });
    }
  }
  const result = rangeResult({
    check: 'supplier_charges',
    place,
    currency: 'USD',
    booksUnits,
    actualUnits,
    lowUnits: booksUnits,
    highUnits: booksUnits,
    toleranceUnits: input.toleranceUsdUnits,
    lines,
  });
  const accounted = lines.length === 0 && unmatched.length === 0;
  return {
    ...result,
    status: result.status === 'ok' && accounted ? 'ok' : 'mismatch',
    offendingCount: lines.length + unmatched.length + (result.status === 'ok' ? 0 : 1),
    details: {
      ...result.details,
      unmatchedSupplierOrders: unmatched.slice(0, RECONCILIATION_MAX_OFFENDING_IDS),
    },
  };
}

/**
 * Rule E3: the store address's USDT balance on one network against the held amount on
 * `usdt_receipts:<network>`; the range is `[held, held + uncredited]`, uncredited = the recorded
 * transfers no credited deposit holds and no manual deposit or `unclaimed_receipt` movement claims.
 */
export async function usdtBalanceCheck(
  db: Executor,
  input: { network: UsdtMethod; actualUnits: number; toleranceUsdUnits: number },
): Promise<CheckResult> {
  const place: TreasuryPlace = input.network;
  const booksUnits = await placeBooks(db, place);
  if (!(await openingRecorded(db, place))) {
    return skippedResult('usdt_balance', place, 'opening_missing', booksUnits);
  }
  const { rows } = await db.execute<{ id: string; amount: string }>(sql`
    select t.id, t.amount_units::text as amount from usdt_transfers t
    where t.method = ${input.network}
      and not exists (
        select 1 from usdt_deposits u join deposits d on d.id = u.deposit_id
        where u.transfer_id = t.id and d.status = 'credited')
      and not exists (
        select 1 from payment_references claim
        where claim.method = t.method
          and claim.reference in (upper(t.txid), '0X' || upper(t.txid)))
      and not exists (
        select 1 from treasury_movements m join ledger_accounts a on a.id = m.to_account_id
        where a.code = ${TREASURY_ACCOUNTS[place].code}
          and m.outside_category = 'unclaimed_receipt' and m.reverses_movement_id is null
          and not exists (select 1 from treasury_movements r where r.reverses_movement_id = m.id)
          and upper(m.external_reference) in (upper(t.txid), '0X' || upper(t.txid)))
    order by t.block_time, t.id`);
  const lines = rows.map((row) => ({
    kind: 'uncredited_transfer' as const,
    id: row.id,
    amountUnits: units(row.amount),
  }));
  const uncredited = lines.reduce((sum, line) => sum + line.amountUnits, 0);
  return rangeResult({
    check: 'usdt_balance',
    place,
    currency: 'USD',
    booksUnits,
    actualUnits: input.actualUnits,
    lowUnits: booksUnits,
    highUnits: booksUnits + uncredited,
    toleranceUnits: input.toleranceUsdUnits,
    lines,
  });
}

/**
 * Rule E4: the amount the admin counted in the Sham Cash app against the held amount on
 * `sham_cash_receipts:<currency>`; the range is `[held, held + under review]`, under review = the
 * declared amounts of submitted deposits in that currency (the money may have arrived already).
 */
export async function shamCashCountCheck(
  db: Executor,
  input: { currency: Currency; countedUnits: number; toleranceUnits: number },
): Promise<CheckResult> {
  const place: TreasuryPlace = input.currency === 'SYP' ? 'sham_cash_syp' : 'sham_cash_usd';
  const booksUnits = await placeBooks(db, place);
  if (!(await openingRecorded(db, place))) {
    return skippedResult(
      'sham_cash_count',
      place,
      'opening_missing',
      booksUnits,
      input.countedUnits,
    );
  }
  const { rows } = await db.execute<{ id: string; amount: string }>(sql`
    select id, declared_amount_units::text as amount from deposits
    where method = 'sham_cash' and currency = ${input.currency} and status = 'submitted'
    order by submitted_at, id`);
  const lines = rows.map((row) => ({
    kind: 'deposit_in_review' as const,
    id: row.id,
    amountUnits: units(row.amount),
  }));
  const underReview = lines.reduce((sum, line) => sum + line.amountUnits, 0);
  return rangeResult({
    check: 'sham_cash_count',
    place,
    currency: input.currency,
    booksUnits,
    actualUnits: input.countedUnits,
    lowUnits: booksUnits,
    highUnits: booksUnits + underReview,
    toleranceUnits: input.toleranceUnits,
    lines,
  });
}
