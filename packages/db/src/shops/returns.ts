import {
  type ReturnRequestAction,
  returnRequestTransition,
  SHOP_RETURN_ALERT_DAYS,
  SHOP_RETURN_REQUEST_HOURS,
  shopReturnsAlarming,
} from '@vertex-digital/contracts';
import { and, eq, lte, sql } from 'drizzle-orm';
import { recordAudit } from '../audit/index.js';
import type { Database, Transaction } from '../client.js';
import { lockActiveCustomer } from '../customers/guard.js';
import { accountBalance } from '../ledger/balance.js';
import { postJournal } from '../ledger/post-journal.js';
import {
  findShopCustomerWallet,
  lockCustomerWallet,
  lockShopCustomerWallet,
} from '../ledger/wallet.js';
import { type JobSender, notifyCustomer } from '../notifications/index.js';
import { shopReturnRequests, shopTransfers } from '../schema/index.js';
import { damascusDate } from '../suppliers/validations.js';
import { queueTelegramMessage } from '../telegram/index.js';
import { notifyShopCustomer } from './notify.js';
import {
  auditActor,
  lockKey,
  lockShop,
  lockShopCustomer,
  type ShopActor,
  ShopError,
  type ShopRow,
} from './state.js';

export type ShopReturnRequestRow = typeof shopReturnRequests.$inferSelect;

export interface ReturnRequestInput {
  shopId: string;
  merchantId: string;
  shopCustomerId: string;
  amountUsdUnits: number;
  idempotencyKey: string;
  actor: ShopActor;
}

/**
 * WL5: the merchant asks to take back an amount up to the customer's balance. The merchant not
 * frozen, the shop active, one pending request per customer (`RETURN_REQUEST_PENDING`); the
 * customer is emailed. A repeated key returns its request.
 */
export async function requestShopReturn(
  tx: Transaction,
  jobs: JobSender,
  input: ReturnRequestInput,
): Promise<{ request: ShopReturnRequestRow; replayed: boolean }> {
  await lockKey(tx, `shop-return-request:${input.idempotencyKey}`);
  const [earlier] = await tx
    .select()
    .from(shopReturnRequests)
    .where(eq(shopReturnRequests.idempotencyKey, input.idempotencyKey));
  if (earlier) {
    if (
      earlier.shopCustomerId !== input.shopCustomerId ||
      earlier.amountUsdUnits !== input.amountUsdUnits
    ) {
      throw new ShopError('IDEMPOTENCY_KEY_REUSED', 'The key was used for another request');
    }
    return { request: earlier, replayed: true };
  }
  const merchant = await lockActiveCustomer(tx, input.merchantId);
  if (merchant.accountType !== 'merchant') {
    throw new ShopError('NOT_MERCHANT', 'The account is not a merchant');
  }
  const shop = await activeShopOf(tx, input.shopId, input.merchantId);
  const customer = await lockShopCustomer(tx, shop.id, input.shopCustomerId);
  if (customer.frozenAt !== null) throw new ShopError('ACCOUNT_FROZEN', 'The customer is frozen');
  const [pending] = await tx
    .select({ id: shopReturnRequests.id })
    .from(shopReturnRequests)
    .where(
      and(
        eq(shopReturnRequests.shopCustomerId, customer.id),
        eq(shopReturnRequests.status, 'pending'),
      ),
    );
  if (pending) {
    throw new ShopError('RETURN_REQUEST_PENDING', 'A return request is pending', {
      requestId: pending.id,
    });
  }
  const wallet = await findShopCustomerWallet(tx, customer.id);
  const balance = wallet === null ? 0 : await accountBalance(tx, wallet);
  if (input.amountUsdUnits > balance) {
    throw new ShopError('INSUFFICIENT_BALANCE', 'The customer holds less', {
      balanceUnits: balance,
    });
  }
  const [request] = await tx
    .insert(shopReturnRequests)
    .values({
      shopId: shop.id,
      shopCustomerId: customer.id,
      amountUsdUnits: input.amountUsdUnits,
      expiresAt: sql`now() + make_interval(hours => ${SHOP_RETURN_REQUEST_HOURS})`,
      idempotencyKey: input.idempotencyKey,
    })
    .returning();
  if (!request) throw new Error('The return request was not written');
  await recordAudit(tx, {
    action: 'shop.return_requested',
    ...auditActor(input.actor),
    entityType: 'merchant_shop',
    entityId: shop.id,
    details: returnDetails(request),
  });
  await notifyShopCustomer(tx, jobs, {
    shopCustomerId: customer.id,
    event: 'return_requested',
    params: {
      amountUsdUnits: request.amountUsdUnits,
      expiresAt: request.expiresAt.toISOString(),
    },
  });
  return { request, replayed: false };
}

/** Who ends a request: its customer (confirm, decline), its merchant (cancel) or the job (expire). */
export type ReturnRequestEnd =
  | { action: 'confirm'; shopCustomerId: string; idempotencyKey: string }
  | { action: 'decline'; shopCustomerId: string }
  | { action: 'cancel'; merchantId: string }
  | { action: 'expire' };

export interface EndedReturnRequest {
  request: ShopReturnRequestRow;
  /** Confirm only: the return's transfer row. */
  transferId: string | null;
  replayed: boolean;
}

/**
 * WL5, WL6: a pending request ends once. The shop's lock comes before the request's (a close
 * cancels the shop's requests under the shop's lock). A confirm needs the shop active and the
 * customer not frozen; under the merchant's wallet lock, then the customer's, it moves the amount
 * back (`INSUFFICIENT_BALANCE` leaves the request pending, WL6). Each end writes its audit entry
 * and tells the merchant, but a cancel, which the merchant made.
 */
export async function endShopReturn(
  tx: Transaction,
  jobs: JobSender,
  requestId: string,
  end: ReturnRequestEnd,
  actor: ShopActor,
): Promise<EndedReturnRequest> {
  if (end.action === 'confirm') await lockKey(tx, `shop-return:${requestId}`);
  const [found] = await tx
    .select({ shopId: shopReturnRequests.shopId })
    .from(shopReturnRequests)
    .where(eq(shopReturnRequests.id, requestId));
  if (!found) throw new ShopError('NOT_FOUND', 'No such return request');
  const shop = await lockShop(tx, found.shopId, 'share');
  const [request] = await tx
    .select()
    .from(shopReturnRequests)
    .where(eq(shopReturnRequests.id, requestId))
    .for('update');
  if (!request) throw new ShopError('NOT_FOUND', 'No such return request');
  if (
    ('shopCustomerId' in end && end.shopCustomerId !== request.shopCustomerId) ||
    ('merchantId' in end && end.merchantId !== shop.merchantId)
  ) {
    throw new ShopError('NOT_FOUND', 'No such return request');
  }
  const status = returnRequestTransition(request.status, end.action as ReturnRequestAction);
  if (status === null) {
    const replay = await replayedEnd(tx, request, end);
    if (replay) return replay;
    throw new ShopError('RETURN_REQUEST_STATE_INVALID', 'The request is not pending', {
      status: request.status,
    });
  }
  const customer = await lockShopCustomer(tx, shop.id, request.shopCustomerId);
  let transferId: string | null = null;
  let journalId: string | null = null;
  if (end.action === 'confirm') {
    if (shop.status !== 'active') {
      throw new ShopError('SHOP_UNAVAILABLE', 'The shop takes no returns', { status: shop.status });
    }
    if (customer.frozenAt !== null) throw new ShopError('ACCOUNT_FROZEN', 'The account is frozen');
    const merchantWallet = await lockCustomerWallet(tx, shop.merchantId);
    const customerWallet = await lockShopCustomerWallet(tx, customer.id);
    ({ journalId } = await postJournal(tx, {
      idempotencyKey: `shop-return:${request.id}`,
      kind: 'shop_transfer',
      postings: [
        { accountId: customerWallet, amountUnits: -request.amountUsdUnits },
        { accountId: merchantWallet, amountUnits: request.amountUsdUnits },
      ],
    }));
    const [transfer] = await tx
      .insert(shopTransfers)
      .values({
        shopId: shop.id,
        shopCustomerId: customer.id,
        cause: 'return',
        direction: 'to_merchant',
        amountUsdUnits: request.amountUsdUnits,
        enteredCurrency: 'usd',
        enteredAmountUnits: request.amountUsdUnits,
        journalId,
        returnRequestId: request.id,
        idempotencyKey: end.idempotencyKey,
      })
      .returning({ id: shopTransfers.id, createdAt: shopTransfers.createdAt });
    if (!transfer) throw new Error('The return was not written');
    transferId = transfer.id;
    await alertIfReturnsAlarming(tx, jobs, shop);
    await notifyShopCustomer(tx, jobs, {
      shopCustomerId: customer.id,
      event: 'return_done',
      params: { amountUsdUnits: request.amountUsdUnits },
    });
  }
  const [ended] = await tx
    .update(shopReturnRequests)
    .set({ status, decidedAt: sql`now()` })
    .where(eq(shopReturnRequests.id, request.id))
    .returning();
  if (!ended) throw new Error('The return request was not ended');
  const details = returnDetails(ended);
  if (end.action === 'confirm' && transferId && journalId) {
    await recordAudit(tx, {
      action: 'shop.return_confirmed',
      ...auditActor(actor),
      entityType: 'merchant_shop',
      entityId: shop.id,
      details: { ...details, transferId, journalId },
    });
  } else {
    await recordAudit(tx, {
      action:
        end.action === 'decline'
          ? 'shop.return_declined'
          : end.action === 'cancel'
            ? 'shop.return_cancelled'
            : 'shop.return_expired',
      ...auditActor(actor),
      entityType: 'merchant_shop',
      entityId: shop.id,
      details,
    });
  }
  if (status !== 'cancelled' && status !== 'pending') {
    await notifyCustomer(tx, jobs, {
      customerId: shop.merchantId,
      event: 'merchant_shop_return_ended',
      params: {
        shopCustomerId: customer.id,
        customerName: customer.name,
        amountUsdUnits: ended.amountUsdUnits,
        status,
      },
    });
  }
  return { request: ended, transferId, replayed: false };
}

/**
 * Abuse ("money laundering"): after a confirmed return, the shop's transfers and returns over the
 * last 7 days; returns above half of the transfers, with $200 returned at least, tell the admin
 * once a Damascus day per shop.
 */
async function alertIfReturnsAlarming(
  tx: Transaction,
  jobs: JobSender,
  shop: { id: string; displayName: string },
): Promise<void> {
  const result = await tx.execute<{ transferred: string; returned: string }>(sql`
    select
      coalesce(sum(amount_usd_units) filter (where direction = 'to_customer'), 0)::text as transferred,
      coalesce(sum(amount_usd_units) filter (where direction = 'to_merchant'), 0)::text as returned
    from shop_transfers
    where shop_id = ${shop.id}
      and created_at > now() - ${`${SHOP_RETURN_ALERT_DAYS} days`}::interval`);
  const totals = {
    transferredUsdUnits: Number(result.rows[0]?.transferred ?? 0),
    returnedUsdUnits: Number(result.rows[0]?.returned ?? 0),
  };
  if (!shopReturnsAlarming(totals)) return;
  await queueTelegramMessage(tx, jobs, {
    kind: 'shop_returns_alert',
    dedupeKey: `shop-returns:${shop.id}:${damascusDate(new Date())}`,
    params: {
      shopId: shop.id,
      tradeName: shop.displayName,
      days: SHOP_RETURN_ALERT_DAYS,
      ...totals,
    },
  });
}

/** The same end again (a double tap, a retried confirm): what the first one wrote. */
async function replayedEnd(
  tx: Transaction,
  request: ShopReturnRequestRow,
  end: ReturnRequestEnd,
): Promise<EndedReturnRequest | null> {
  if (end.action === 'confirm' && request.status === 'confirmed') {
    const [transfer] = await tx
      .select({ id: shopTransfers.id, idempotencyKey: shopTransfers.idempotencyKey })
      .from(shopTransfers)
      .where(eq(shopTransfers.returnRequestId, request.id));
    if (transfer?.idempotencyKey === end.idempotencyKey) {
      return { request, transferId: transfer.id, replayed: true };
    }
    return null;
  }
  const same =
    (end.action === 'decline' && request.status === 'declined') ||
    (end.action === 'cancel' && request.status === 'cancelled');
  return same ? { request, transferId: null, replayed: true } : null;
}

/** WL5: the job ends pending requests past their 24 hours, each in its own transaction. */
export async function expireShopReturns(
  db: Database,
  jobs: JobSender,
  limit = 100,
): Promise<string[]> {
  const due = await db
    .select({ id: shopReturnRequests.id })
    .from(shopReturnRequests)
    .where(
      and(eq(shopReturnRequests.status, 'pending'), lte(shopReturnRequests.expiresAt, sql`now()`)),
    )
    .orderBy(shopReturnRequests.expiresAt)
    .limit(limit);
  const expired: string[] = [];
  for (const { id } of due) {
    const ended = await db.transaction(async (tx) => {
      const [current] = await tx
        .select({ status: shopReturnRequests.status, expiresAt: shopReturnRequests.expiresAt })
        .from(shopReturnRequests)
        .where(eq(shopReturnRequests.id, id));
      // Confirmed, declined or cancelled since the read: nothing to expire.
      if (current?.status !== 'pending') return false;
      await endShopReturn(
        tx,
        jobs,
        id,
        { action: 'expire' },
        { kind: 'system', id: null, channel: 'worker' },
      );
      return true;
    });
    if (ended) expired.push(id);
  }
  return expired;
}

/** The active shop of this merchant, `FOR SHARE`, or `SHOP_UNAVAILABLE` / `NOT_FOUND`. */
export async function activeShopOf(
  tx: Transaction,
  shopId: string,
  merchantId: string,
): Promise<ShopRow> {
  const shop = await lockShop(tx, shopId, 'share');
  if (shop.merchantId !== merchantId) throw new ShopError('NOT_FOUND', 'No such shop');
  if (shop.status !== 'active') {
    throw new ShopError('SHOP_UNAVAILABLE', 'The shop is not active', { status: shop.status });
  }
  return shop;
}

const returnDetails = (request: ShopReturnRequestRow) => ({
  requestId: request.id,
  shopCustomerId: request.shopCustomerId,
  amountUsdUnits: request.amountUsdUnits,
});
