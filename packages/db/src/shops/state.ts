import {
  type AuditChannel,
  type ErrorCode,
  rateFromNumeric,
  type ShopRateMode,
} from '@vertex-digital/contracts';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Executor, Transaction } from '../client.js';
import { rateInForce } from '../merchant-tools/sales.js';
import { merchantShopRates, merchantShops, shopCustomers } from '../schema/index.js';

/*
 * Merchant shops (S26, ADR 0040): the shop and shop customer rows as the write paths lock them,
 * the shop's rate in force, and the errors they refuse with.
 */

export type ShopRow = typeof merchantShops.$inferSelect;
export type ShopCustomerRow = typeof shopCustomers.$inferSelect;

/** A refusal of a shop write path, with the contract code the API answers. */
export class ShopError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ShopError';
    this.code = code;
    this.details = details;
  }
}

/** Who acts, as the audit entry records it. */
export interface ShopActor {
  kind: 'admin' | 'customer' | 'shop_customer' | 'system';
  id: string | null;
  channel: AuditChannel;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export const auditActor = (actor: ShopActor) =>
  ({
    actorKind: actor.kind,
    actorId: actor.id,
    channel: actor.channel,
    ipAddress: actor.ipAddress ?? null,
    userAgent: actor.userAgent ?? null,
  }) as const;

/** The shop row locked as asked, or `NOT_FOUND`. A shop's lock comes before its rows' locks. */
export async function lockShop(
  tx: Transaction,
  shopId: string,
  mode: 'share' | 'no key update',
): Promise<ShopRow> {
  const [row] = await tx.select().from(merchantShops).where(eq(merchantShops.id, shopId)).for(mode);
  if (!row) throw new ShopError('NOT_FOUND', 'No such shop');
  return row;
}

/**
 * A shop customer of this shop `FOR SHARE`, or `NOT_FOUND` (another shop's customer, or archived:
 * CA9). Frozen customers are returned; each caller refuses them as its rule says (CA7).
 */
export async function lockShopCustomer(
  tx: Transaction,
  shopId: string,
  shopCustomerId: string,
): Promise<ShopCustomerRow> {
  const [row] = await tx
    .select()
    .from(shopCustomers)
    .where(and(eq(shopCustomers.id, shopCustomerId), eq(shopCustomers.shopId, shopId)))
    .for('share');
  if (!row || row.archivedAt !== null) throw new ShopError('NOT_FOUND', 'No such shop customer');
  return row;
}

export interface ShopRateNow {
  /** The rate in force (ST3): the own rate in `own` mode, else the store's; null with neither. */
  rate: string | null;
  ownRate: string | null;
  storeRate: string | null;
  storeRateId: string | null;
}

/** ST3: the shop's newest own rate, the store's rate in force, and the one the shop uses. */
export async function shopRateNow(
  db: Executor,
  shop: { id: string; rateMode: ShopRateMode },
): Promise<ShopRateNow> {
  const [own] = await db
    .select({ rate: merchantShopRates.rateSypPerUsd })
    .from(merchantShopRates)
    .where(eq(merchantShopRates.shopId, shop.id))
    .orderBy(desc(merchantShopRates.createdAt), desc(merchantShopRates.id))
    .limit(1);
  const store = await rateInForce(db);
  const ownRate = own ? rateFromNumeric(own.rate) : null;
  const storeRate = store ? rateFromNumeric(store.sypPerUsd) : null;
  return {
    rate: shop.rateMode === 'own' && ownRate !== null ? ownRate : storeRate,
    ownRate,
    storeRate,
    storeRateId: store?.id ?? null,
  };
}

/** WL3: what the merchant transferred to the shop's customers this Damascus day. */
export async function transferredToday(db: Executor, shopId: string): Promise<number> {
  const result = await db.execute<{ total: string }>(sql`
    select coalesce(sum(amount_usd_units), 0)::text as total from shop_transfers
    where shop_id = ${shopId} and direction = 'to_customer'
      and created_at >= (date_trunc('day', now() at time zone 'Asia/Damascus') at time zone 'Asia/Damascus')`);
  return Number(result.rows[0]?.total ?? 0);
}

/** A transaction-scoped advisory lock on a request's key: a repeated key waits, then replays. */
export async function lockKey(tx: Transaction, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

/** Shop customers' balances by id (S26 customers lists), from the postings; 0 without a wallet. */
export async function shopCustomerBalances(
  db: Executor,
  shopCustomerIds: readonly string[],
): Promise<Map<string, number>> {
  if (shopCustomerIds.length === 0) return new Map();
  const result = await db.execute<{ id: string; balance: string }>(sql`
    select a.shop_customer_id as id, coalesce(sum(p.amount_units), 0)::text as balance
    from ledger_accounts a
    left join ledger_postings p on p.account_id = a.id
    where a.shop_customer_id in (${sql.join(
      shopCustomerIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
    group by a.shop_customer_id`);
  return new Map(result.rows.map((row) => [row.id, Number(row.balance)]));
}

/** Each shop's customers' total balance (the admin's shops list), by shop id. */
export async function shopTotalBalances(
  db: Executor,
  shopIds: readonly string[],
): Promise<Map<string, number>> {
  if (shopIds.length === 0) return new Map();
  const result = await db.execute<{ id: string; total: string }>(sql`
    select c.shop_id as id, coalesce(sum(p.amount_units), 0)::text as total
    from shop_customers c
    join ledger_accounts a on a.shop_customer_id = c.id
    left join ledger_postings p on p.account_id = a.id
    where c.shop_id in (${sql.join(
      shopIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
    group by c.shop_id`);
  return new Map(result.rows.map((row) => [row.id, Number(row.total)]));
}

/** The store's rate in force (S07), as a shop compares an own rate with it (ST3). */
export async function storeRateNow(
  db: Executor,
): Promise<{ storeRate: string | null; storeRateId: string | null }> {
  const store = await rateInForce(db);
  return {
    storeRate: store ? rateFromNumeric(store.sypPerUsd) : null,
    storeRateId: store?.id ?? null,
  };
}

export interface ShopWalletEntryRow {
  id: string;
  kind:
    | 'transfer_in'
    | 'return_out'
    | 'purchase'
    | 'refund'
    | 'compensation'
    | 'settlement'
    | 'adjustment';
  amountUnits: number;
  balanceAfterUnits: number;
  orderId: string | null;
  createdAt: Date;
  position: number;
}

/**
 * A shop wallet's timeline (S26 screens, "الرصيد"), newest first by write position, with the
 * balance after each journal; `before` is the position to continue below.
 */
export async function shopWalletEntries(
  db: Executor,
  shopCustomerId: string,
  limit: number,
  before: number | null,
): Promise<ShopWalletEntryRow[]> {
  const result = await db.execute<{
    id: string;
    kind: string;
    settled: boolean;
    compensated: string | null;
    amount: string;
    balance: string;
    order_id: string | null;
    created_at: Date;
    position: string;
  }>(sql`
    with entries as (
      select j.id, j.kind::text as kind, j.created_at,
        exists (select 1 from shop_settlements x where x.journal_id = j.id) as settled,
        (select c.order_id from shop_compensations c
          where c.adjustment_journal_id = j.id or c.margin_journal_id = j.id) as compensated,
        coalesce(
          (select o.id from orders o where o.purchase_journal_id = j.id or o.refund_journal_id = j.id
            limit 1),
          (select c.order_id from shop_compensations c
            where c.adjustment_journal_id = j.id or c.margin_journal_id = j.id)) as order_id,
        sum(p.amount_units) as amount, max(p.position) as position
      from ledger_accounts a
      join ledger_postings p on p.account_id = a.id
      join ledger_journals j on j.id = p.journal_id
      where a.shop_customer_id = ${shopCustomerId}
      group by j.id
    ),
    running as (
      select *, sum(amount) over (order by position) as balance from entries
    )
    select id, kind, settled, compensated, amount::text, balance::text, order_id, created_at, position::text
    from running
    where ${before === null ? sql`true` : sql`position < ${before}`}
    order by position desc
    limit ${limit}`);
  return result.rows.map((row) => {
    const amount = Number(row.amount);
    const kind: ShopWalletEntryRow['kind'] = row.settled
      ? 'settlement'
      : row.compensated !== null
        ? 'compensation'
        : row.kind === 'shop_transfer'
          ? amount > 0
            ? 'transfer_in'
            : 'return_out'
          : row.kind === 'purchase'
            ? 'purchase'
            : row.kind === 'refund'
              ? 'refund'
              : 'adjustment';
    return {
      id: row.id,
      kind,
      amountUnits: amount,
      balanceAfterUnits: Number(row.balance),
      orderId: row.order_id,
      createdAt: new Date(row.created_at),
      position: Number(row.position),
    };
  });
}
