import {
  type ShopCompensationMarginSource,
  shopCompensationAmounts,
  shopCompensationRefusal,
} from '@vertex-digital/contracts';
import { eq, sql } from 'drizzle-orm';
import { recordAudit } from '../audit/index.js';
import type { Transaction } from '../client.js';
import { newId } from '../id.js';
import { accountBalance } from '../ledger/balance.js';
import { postJournal } from '../ledger/post-journal.js';
import {
  ensureSystemAccount,
  lockCustomerWallet,
  lockShopCustomerWallet,
} from '../ledger/wallet.js';
import { type JobSender, notifyCustomer } from '../notifications/index.js';
import { catalogProducts, orders, shopCompensations } from '../schema/index.js';
import { shopSaleOf } from './finish.js';
import { notifyShopCustomer } from './notify.js';
import { lockKey, ShopError } from './state.js';

export type ShopCompensationRow = typeof shopCompensations.$inferSelect;

export interface ShopCompensationInput {
  orderId: string;
  units: number;
  marginFrom: ShopCompensationMarginSource;
  reason: string;
  idempotencyKey: string;
  adminId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  now?: Date;
}

/**
 * PR10: the admin compensates `units` of a delivered shop order. Under the key's lock (a repeated
 * key replays the first compensation), the order `FOR UPDATE` (one compensation of an order at a
 * time, so the units already compensated are counted), then the merchant's wallet, then the shop
 * customer's. Vertex's part (B·n) is an `adjustment` from `adjustments:compensation`; the margin
 * part, owed only when the order's margin was released, comes from the merchant's wallet (refused
 * with `INSUFFICIENT_BALANCE` when it does not cover it), from the store in the same adjustment, or
 * is left out (`none`: the shop ticket tells the merchant what is owed). Audited; the shop customer
 * and, when the margin was taken back, the merchant are told.
 */
export async function compensateShopOrder(
  tx: Transaction,
  jobs: JobSender,
  input: ShopCompensationInput,
): Promise<{ compensation: ShopCompensationRow; replayed: boolean }> {
  await lockKey(tx, `shop-compensation:${input.idempotencyKey}`);
  const [earlier] = await tx
    .select()
    .from(shopCompensations)
    .where(eq(shopCompensations.idempotencyKey, input.idempotencyKey));
  if (earlier) {
    if (earlier.orderId !== input.orderId || earlier.units !== input.units) {
      throw new ShopError('IDEMPOTENCY_KEY_REUSED', 'The key was used for another compensation');
    }
    return { compensation: earlier, replayed: true };
  }

  const [order] = await tx
    .select()
    .from(orders)
    .where(eq(orders.id, input.orderId))
    .for('no key update');
  if (!order) throw new ShopError('NOT_FOUND', 'No such order');
  const sale = order.shopCustomerId === null ? null : await shopSaleOf(tx, order.id);
  const [done] = await tx
    .select({ units: sql<string>`coalesce(sum(${shopCompensations.units}), 0)::text` })
    .from(shopCompensations)
    .where(eq(shopCompensations.orderId, order.id));
  const refusal = shopCompensationRefusal(
    {
      shopOrder: sale !== null,
      finishedAt: order.finishedAt,
      deliveredQuantity: order.deliveredQuantity,
      compensatedQuantity: Number(done?.units ?? 0),
    },
    input.units,
    input.now ?? new Date(),
  );
  if (refusal || !sale || order.customerId === null || order.shopCustomerId === null) {
    throw new ShopError('ORDER_NOT_COMPENSABLE', 'The order cannot be compensated', {
      reason: refusal ?? 'not_shop_order',
    });
  }
  const amounts = shopCompensationAmounts(
    sale.unitSellUsdUnits,
    sale.unitBuyUsdUnits,
    input.units,
    (sale.marginReleasedUsdUnits ?? 0) > 0,
  );
  const marginFrom: ShopCompensationMarginSource =
    amounts.marginUsdUnits === 0 ? 'none' : input.marginFrom;

  const merchantWallet = await lockCustomerWallet(tx, order.customerId);
  if (
    marginFrom === 'merchant' &&
    (await accountBalance(tx, merchantWallet)) < amounts.marginUsdUnits
  ) {
    throw new ShopError(
      'INSUFFICIENT_BALANCE',
      "The merchant's balance does not cover the margin",
      {
        marginUsdUnits: amounts.marginUsdUnits,
      },
    );
  }
  const shopWallet = await lockShopCustomerWallet(tx, order.shopCustomerId);
  const id = newId();
  const fromStore = amounts.vertexUsdUnits + (marginFrom === 'store' ? amounts.marginUsdUnits : 0);
  const adjustment = await postJournal(tx, {
    idempotencyKey: `shop-compensation:${id}`,
    kind: 'adjustment',
    postings: [
      {
        accountId: await ensureSystemAccount(tx, {
          code: 'adjustments:compensation',
          kind: 'adjustments',
          currency: 'USD',
        }),
        amountUnits: -fromStore,
      },
      { accountId: shopWallet, amountUnits: fromStore },
    ],
  });
  const margin =
    marginFrom === 'merchant'
      ? await postJournal(tx, {
          idempotencyKey: `shop-margin-back:${id}`,
          kind: 'shop_margin',
          postings: [
            { accountId: merchantWallet, amountUnits: -amounts.marginUsdUnits },
            { accountId: shopWallet, amountUnits: amounts.marginUsdUnits },
          ],
        })
      : null;
  const [compensation] = await tx
    .insert(shopCompensations)
    .values({
      id,
      orderId: order.id,
      shopId: sale.shopId,
      shopCustomerId: order.shopCustomerId,
      units: input.units,
      vertexUsdUnits: amounts.vertexUsdUnits,
      marginUsdUnits: amounts.marginUsdUnits,
      marginFrom,
      adjustmentJournalId: adjustment.journalId,
      marginJournalId: margin?.journalId ?? null,
      idempotencyKey: input.idempotencyKey,
      adminId: input.adminId,
    })
    .returning();
  if (!compensation) throw new Error('The compensation was not written');
  await recordAudit(tx, {
    action: 'shop.order_compensated',
    actorKind: 'admin',
    actorId: input.adminId,
    channel: 'admin',
    entityType: 'order',
    entityId: order.id,
    reason: input.reason,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    details: {
      compensationId: id,
      orderId: order.id,
      units: input.units,
      vertexUsdUnits: amounts.vertexUsdUnits,
      marginUsdUnits: amounts.marginUsdUnits,
      marginFrom,
      journalIds: margin ? [adjustment.journalId, margin.journalId] : [adjustment.journalId],
    },
  });
  const [product] = await tx
    .select({ nameAr: catalogProducts.nameAr })
    .from(catalogProducts)
    .where(eq(catalogProducts.id, order.productId));
  await notifyShopCustomer(tx, jobs, {
    shopCustomerId: order.shopCustomerId,
    event: 'order_compensated',
    params: {
      orderId: order.id,
      orderNumber: order.number,
      productNameAr: product?.nameAr ?? '',
      amountUsdUnits: fromStore + (margin ? amounts.marginUsdUnits : 0),
    },
  });
  if (margin) {
    await notifyCustomer(tx, jobs, {
      customerId: order.customerId,
      event: 'merchant_shop_margin_returned',
      params: {
        orderId: order.id,
        orderNumber: order.number,
        amountUsdUnits: amounts.marginUsdUnits,
      },
    });
  }
  return { compensation, replayed: false };
}
