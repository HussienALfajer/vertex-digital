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
