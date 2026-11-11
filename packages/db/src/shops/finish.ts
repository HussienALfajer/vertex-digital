import { shopOrderAmounts } from '@vertex-digital/contracts';
import { eq } from 'drizzle-orm';
import { recordAudit } from '../audit/index.js';
import type { Transaction } from '../client.js';
import { postJournal } from '../ledger/post-journal.js';
import {
  ensureSystemAccount,
  lockCustomerWallet,
  lockShopCustomerWallet,
} from '../ledger/wallet.js';
import { shopOrderSales } from '../schema/index.js';

/*
 * A shop order's money when it finishes (S26 PR8, ADR 0040), in the order's terminal transaction:
 * the undelivered units' refund at the selling price, and the delivered units' margin released to
 * the merchant. The merchant's wallet is locked before the shop customer's, as transfers do.
 */

export const SHOP_MARGIN_HELD = {
  code: 'shop_margin_held:USD',
  kind: 'shop_margin_held',
  currency: 'USD',
} as const;

export type ShopSale = typeof shopOrderSales.$inferSelect;

interface ShopOrder {
  id: string;
  /** The merchant (the seller of record). */
  customerId: string | null;
  shopCustomerId: string | null;
  deliveredQuantity: number;
}

/** The order's sale row, or null for an order that is not a shop order. */
export async function shopSaleOf(tx: Transaction, orderId: string): Promise<ShopSale | null> {
  const [sale] = await tx.select().from(shopOrderSales).where(eq(shopOrderSales.orderId, orderId));
  return sale ?? null;
}

/**
 * PR8: the postings of a shop order's refund of `units`: the shop wallet gets S·n back, the
 * refunds account takes B·n (the order's own refund, C7) and the held account gives up the margin.
 * A partial refund locks the merchant's wallet first: its margin release follows in the same
 * transaction, and the merchant's lock comes before the shop customer's.
 */
export async function shopRefundPostings(
  tx: Transaction,
  order: ShopOrder,
  sale: ShopSale,
  units: number,
  refundsAccountId: string,
): Promise<{ postings: { accountId: string; amountUnits: number }[]; sellUsdUnits: number }> {
  if (order.customerId === null || order.shopCustomerId === null) {
    throw new Error(`Order ${order.id} is not a shop order`);
  }
  if (order.deliveredQuantity > 0) await lockCustomerWallet(tx, order.customerId);
  const amounts = shopOrderAmounts(sale.unitSellUsdUnits, sale.unitBuyUsdUnits, units);
  const postings = [
    {
      accountId: await lockShopCustomerWallet(tx, order.shopCustomerId),
      amountUnits: amounts.sellUsdUnits,
    },
    { accountId: refundsAccountId, amountUnits: -amounts.buyUsdUnits },
  ];
  if (amounts.marginUsdUnits > 0) {
    postings.push({
      accountId: await ensureSystemAccount(tx, SHOP_MARGIN_HELD),
      amountUnits: -amounts.marginUsdUnits,
    });
  }
  return { postings, sellUsdUnits: amounts.sellUsdUnits };
}

/**
 * PR8: once a shop order is terminal, the margin of its delivered units moves from the held
 * account to the merchant's wallet (`shop_margin`, `shop-margin:<order>`; none at zero), a frozen
 * merchant's included, and the sale row records it, once. Refunded units gave their margin back
 * with the refund, so the held account is back to zero for the order.
 */
export async function releaseShopMargin(tx: Transaction, order: ShopOrder): Promise<void> {
  const sale = await shopSaleOf(tx, order.id);
  if (!sale || sale.marginReleasedUsdUnits !== null) return;
  if (order.customerId === null) throw new Error(`Shop order ${order.id} has no merchant`);
  const margin = shopOrderAmounts(
    sale.unitSellUsdUnits,
    sale.unitBuyUsdUnits,
    order.deliveredQuantity,
  ).marginUsdUnits;
  if (margin > 0) {
    const { journalId } = await postJournal(tx, {
      idempotencyKey: `shop-margin:${order.id}`,
      kind: 'shop_margin',
      postings: [
        { accountId: await ensureSystemAccount(tx, SHOP_MARGIN_HELD), amountUnits: -margin },
        { accountId: await lockCustomerWallet(tx, order.customerId), amountUnits: margin },
      ],
    });
    await recordAudit(tx, {
      action: 'shop.margin_released',
      actorKind: 'system',
      actorId: null,
      channel: 'worker',
      entityType: 'order',
      entityId: order.id,
      details: {
        orderId: order.id,
        deliveredQuantity: order.deliveredQuantity,
        amountUsdUnits: margin,
        journalId,
      },
    });
  }
  await tx
    .update(shopOrderSales)
    .set({ marginReleasedUsdUnits: margin })
    .where(eq(shopOrderSales.orderId, order.id));
}
