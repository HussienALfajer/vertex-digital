import { type ShopSettlementTarget, shopCacheTag, shopTransition } from '@vertex-digital/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { recordAudit } from '../audit/index.js';
import type { Executor, Transaction } from '../client.js';
import { accountPriceList } from '../customers/price-lists.js';
import { accountBalance } from '../ledger/balance.js';
import { postJournal } from '../ledger/post-journal.js';
import {
  ensureSystemAccount,
  lockCustomerWallet,
  lockShopCustomerWallet,
} from '../ledger/wallet.js';
import { type JobSender, notifyCustomer } from '../notifications/index.js';
import { merchantShops, shopReturnRequests, shopSettlements } from '../schema/index.js';
import { queueStoreRevalidate } from '../store/revalidate.js';
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

/** The shop customers' balances of a shop: how many hold money, and the total (WL9). */
export async function shopBalances(
  db: Executor,
  shopId: string,
): Promise<{ customers: number; totalUsdUnits: number }> {
  const result = await db.execute<{ customers: number; total: string }>(sql`
    select (count(*) filter (where balance > 0))::int as customers,
      coalesce(sum(balance), 0)::text as total
    from (
      select a.id, coalesce(sum(p.amount_units), 0) as balance
      from shop_customers c
      join ledger_accounts a on a.shop_customer_id = c.id
      left join ledger_postings p on p.account_id = a.id
      where c.shop_id = ${shopId}
      group by a.id
    ) as wallets`);
  const row = result.rows[0];
  return { customers: row?.customers ?? 0, totalUsdUnits: Number(row?.total ?? 0) };
}

/**
 * SH7: closes an active or suspended shop, with the shop locked: it keeps selling at the
 * merchant's effective list of this moment, its pending return requests are cancelled (edge case
 * 14), and the merchant is told. On the merchant's revocation (`cause: 'revocation'`, called by
 * `revokeMerchant` before the account changes) the admin is told on Telegram when customers hold
 * a balance. A shop already closed answers null; another state is `SHOP_STATE_INVALID`.
 */
export async function closeShop(
  tx: Transaction,
  jobs: JobSender,
  input: { shopId: string; cause: 'admin' | 'revocation'; reason: string; actor: ShopActor },
): Promise<ShopRow | null> {
  const shop = await lockShop(tx, input.shopId, 'no key update');
  if (shop.status === 'closed') return null;
  if (shopTransition(shop.status, 'close') === null) {
    throw new ShopError('SHOP_STATE_INVALID', 'The shop cannot close', { status: shop.status });
  }
  const list = await accountPriceList(tx, shop.merchantId);
  const cancelled = await tx
    .update(shopReturnRequests)
    .set({ status: 'cancelled', decidedAt: sql`now()` })
    .where(and(eq(shopReturnRequests.shopId, shop.id), eq(shopReturnRequests.status, 'pending')))
    .returning();
  const [closed] = await tx
    .update(merchantShops)
    .set({
      status: 'closed',
      closedAt: sql`now()`,
      priceListIdAtClose: list?.effectiveList.id ?? null,
    })
    .where(eq(merchantShops.id, shop.id))
    .returning();
  if (!closed) throw new Error('The shop was not closed');
  for (const request of cancelled) {
    await recordAudit(tx, {
      action: 'shop.return_cancelled',
      ...auditActor(input.actor),
      entityType: 'merchant_shop',
      entityId: shop.id,
      details: {
        requestId: request.id,
        shopCustomerId: request.shopCustomerId,
        amountUsdUnits: request.amountUsdUnits,
      },
    });
  }
  await recordAudit(tx, {
    action: 'shop.closed',
    ...auditActor(input.actor),
    entityType: 'merchant_shop',
    entityId: shop.id,
    reason: input.reason,
    details: {
      cause: input.cause,
      priceListIdAtClose: closed.priceListIdAtClose,
      cancelledReturnRequestIds: cancelled.map((request) => request.id),
    },
  });
  await notifyCustomer(tx, jobs, {
    customerId: shop.merchantId,
    event: 'merchant_shop_changed',
    params: { status: 'closed', resumed: false, reason: null },
  });
  if (input.cause === 'revocation') {
    const balances = await shopBalances(tx, shop.id);
    if (balances.totalUsdUnits > 0) {
      await queueTelegramMessage(tx, jobs, {
        kind: 'shop_closed_with_balance',
        params: {
          shopId: shop.id,
          tradeName: shop.displayName,
          customers: Math.max(balances.customers, 1),
          totalUsdUnits: balances.totalUsdUnits,
        },
        dedupeKey: `shop-closed:${shop.id}`,
      });
    }
  }
  // The shop's pages show the close and stop the sign-up (SH7).
  await queueStoreRevalidate(tx, jobs, shopCacheTag(shop.id));
  return closed;
}

export interface SettlementInput {
  shopId: string;
  shopCustomerId: string;
  target: ShopSettlementTarget;
  reason: string;
  idempotencyKey: string;
  actor: ShopActor & { kind: 'admin'; id: string };
}

export type ShopSettlementRow = typeof shopSettlements.$inferSelect;

/**
 * WL9: the admin settles a closed shop's customer balance in full: back to the merchant's wallet
 * (`shop_transfer`, the merchant pays the customer cash), or to `adjustments:cash_refund` (an
 * `adjustment`, the owner pays the customer cash, ADR 0003). The wallets are locked merchant
 * first, then the customer's; the balance is read under the lock. A repeated key replays.
 */
export async function settleShopCustomer(
  tx: Transaction,
  jobs: JobSender,
  input: SettlementInput,
): Promise<{ settlement: ShopSettlementRow; replayed: boolean }> {
  await lockKey(tx, `shop-settle:${input.idempotencyKey}`);
  const [earlier] = await tx
    .select()
    .from(shopSettlements)
    .where(eq(shopSettlements.idempotencyKey, input.idempotencyKey));
  if (earlier) {
    if (earlier.shopCustomerId !== input.shopCustomerId || earlier.target !== input.target) {
      throw new ShopError('IDEMPOTENCY_KEY_REUSED', 'The key was used for another settlement');
    }
    return { settlement: earlier, replayed: true };
  }
  const shop = await lockShop(tx, input.shopId, 'share');
  if (shop.status !== 'closed') {
    throw new ShopError('SHOP_STATE_INVALID', 'Only a closed shop is settled', {
      status: shop.status,
    });
  }
  const customer = await lockShopCustomer(tx, shop.id, input.shopCustomerId);
  const merchantWallet =
    input.target === 'merchant' ? await lockCustomerWallet(tx, shop.merchantId) : null;
  const customerWallet = await lockShopCustomerWallet(tx, customer.id);
  const amountUsdUnits = await accountBalance(tx, customerWallet);
  if (amountUsdUnits <= 0) {
    throw new ShopError('CUSTOMER_STATE_INVALID', 'The customer holds nothing to settle');
  }
  const key = `shop-settle:${customer.id}:${input.idempotencyKey}`;
  const { journalId } =
    merchantWallet === null
      ? await postJournal(tx, {
          idempotencyKey: key,
          kind: 'adjustment',
          postings: [
            { accountId: customerWallet, amountUnits: -amountUsdUnits },
            {
              accountId: await ensureSystemAccount(tx, {
                code: 'adjustments:cash_refund',
                kind: 'adjustments',
                currency: 'USD',
              }),
              amountUnits: amountUsdUnits,
            },
          ],
        })
      : await postJournal(tx, {
          idempotencyKey: key,
          kind: 'shop_transfer',
          postings: [
            { accountId: customerWallet, amountUnits: -amountUsdUnits },
            { accountId: merchantWallet, amountUnits: amountUsdUnits },
          ],
        });
  const [settlement] = await tx
    .insert(shopSettlements)
    .values({
      shopId: shop.id,
      shopCustomerId: customer.id,
      target: input.target,
      amountUsdUnits,
      journalId,
      idempotencyKey: input.idempotencyKey,
      adminId: input.actor.id,
    })
    .returning();
  if (!settlement) throw new Error('The settlement was not written');
  await recordAudit(tx, {
    action: 'shop.settled',
    ...auditActor(input.actor),
    entityType: 'merchant_shop',
    entityId: shop.id,
    reason: input.reason,
    details: { shopCustomerId: customer.id, to: input.target, amountUsdUnits, journalId },
  });
  await notifyShopCustomer(tx, jobs, {
    shopCustomerId: customer.id,
    event: 'settled',
    params: {
      amountUsdUnits,
      to: input.target,
    },
  });
  return { settlement, replayed: false };
}

/**
 * SH2, SH7: whether a closed shop of this merchant holds the slug while its customers still hold
 * a balance. Such a slug is not the merchant's to take again until the shop is settled (WL9):
 * a new shop on it would hide the closed shop from the customers who can still spend there.
 */
export async function slugHeldByUnsettledShop(
  db: Executor,
  merchantId: string,
  slug: string,
): Promise<boolean> {
  const closed = await db
    .select({ id: merchantShops.id })
    .from(merchantShops)
    .where(
      and(
        eq(merchantShops.merchantId, merchantId),
        eq(merchantShops.slug, slug),
        eq(merchantShops.status, 'closed'),
      ),
    );
  for (const shop of closed) {
    if ((await shopBalances(db, shop.id)).totalUsdUnits > 0) return true;
  }
  return false;
}
