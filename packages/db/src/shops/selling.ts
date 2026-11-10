import {
  rateFromNumeric,
  shopOrderAmounts,
  shopPackSellable,
  shopSellingPrice,
  shopSellingSyp,
} from '@vertex-digital/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { recordAudit } from '../audit/index.js';
import type { Transaction } from '../client.js';
import { lockShopMerchant } from '../customers/guard.js';
import { newId } from '../id.js';
import { postJournal } from '../ledger/post-journal.js';
import { ensureSystemAccount, lockShopCustomerWallet } from '../ledger/wallet.js';
import { afterMerchantPurchase } from '../merchant-tools/alerts.js';
import { ownSellingPrice, rateInForce, sellingSettingsOf } from '../merchant-tools/sales.js';
import {
  afterSectionOrder,
  checkCreditLimits,
  currentCreditPolicy,
  lockRecipients,
} from '../orders/credit.js';
import { OrderError } from '../orders/errors.js';
import {
  displayTotal,
  insertOrder,
  lineValues,
  type PurchaseCommon,
  prepareLine,
  salesRevenue,
  sectionLines,
} from '../orders/purchase.js';
import {
  addOrderEvent,
  type OrderContext,
  type OrderRow,
  queueFulfil,
} from '../orders/transition.js';
import {
  catalogProducts,
  merchantShopHiddenGames,
  merchantShops,
  orders,
  shopOrderSales,
} from '../schema/index.js';
import { lockShop, lockShopCustomer, shopRateNow } from './state.js';

/*
 * Selling in a merchant's shop (S26 PR5–PR8, ADR 0040): the shop customer's purchase, and what
 * happens to its money when the order finishes. Vertex sells to the merchant as always: the order
 * is the merchant's, at the merchant's list price (B); the shop customer pays the merchant's
 * selling price (S) from the shop wallet, and the margin (S − B) waits in `shop_margin_held:USD`
 * until the order finishes. The merchant's wallet is not touched by a purchase.
 */

export const SHOP_MARGIN_HELD_CODE = 'shop_margin_held:USD';

/** The system account that holds shop margins between purchase and finish (PR6, PR8). */
export function shopMarginHeld(tx: Transaction) {
  return ensureSystemAccount(tx, {
    code: SHOP_MARGIN_HELD_CODE,
    kind: 'shop_margin_held',
    currency: 'USD',
  });
}

export interface ShopPurchaseInput
  extends Pick<
    PurchaseCommon,
    | 'idempotencyKey'
    | 'requestHash'
    | 'fakeEnabled'
    | 'purchasesStopped'
    | 'playerCheck'
    | 'ipAddress'
    | 'userAgent'
  > {
  shopId: string;
  shopCustomerId: string;
  productId: string;
  quantity: number;
  fields: Record<string, string>;
  /** PR5: the unit selling price the page showed; another current price is `PRICE_CHANGED`. */
  expectedUnitSellUsdUnits: number;
  confirmPlayer: boolean;
}

export type ShopSaleRow = typeof shopOrderSales.$inferSelect;

/**
 * PR5–PR7 in the caller's READ COMMITTED transaction, after it took the switches lock shared and
 * read the purchase stop. `purchaseOrder`'s lock order, with the shop customer's wallet paying:
 * the key's lock (the same key and body replay the first order, even while stopped), the merchant
 * `FOR SHARE` (a frozen merchant's shop still sells, SH4), the shop `FOR SHARE` (`active`, or
 * `closed` selling at its stored list, SH7), the shop customer `FOR SHARE` (frozen refused, CA7),
 * the product `FOR SHARE`, the line's checks on the merchant's list, the recipients, then the
 * shop wallet. One `purchase` journal moves S out of the shop wallet, B to sales revenue and the
 * margin to the held account; the merchant's order, its sale row, its event, the audit entry and
 * the fulfilment job commit with it. Any refusal throws and the caller rolls back.
 */
export async function purchaseShopOrder(
  tx: Transaction,
  context: Pick<OrderContext, 'jobs' | 'now'>,
  input: ShopPurchaseInput,
): Promise<{ order: OrderRow; sale: ShopSaleRow; created: boolean }> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`order:${input.idempotencyKey}`}))`);
  const [existing] = await tx
    .select({ order: orders, sale: shopOrderSales })
    .from(orders)
    .leftJoin(shopOrderSales, eq(shopOrderSales.orderId, orders.id))
    .where(eq(orders.idempotencyKey, input.idempotencyKey));
  if (existing) {
    if (
      existing.order.shopCustomerId !== input.shopCustomerId ||
      existing.order.requestHash !== input.requestHash ||
      existing.sale === null
    ) {
      throw new OrderError('IDEMPOTENCY_KEY_REUSED', 'The key was used for another purchase');
    }
    return { order: existing.order, sale: existing.sale, created: false };
  }
  if (input.purchasesStopped) throw new OrderError('PURCHASES_STOPPED', 'Purchases are stopped');

  // The merchant's id is fixed on the shop (its guard), so it is read before the merchant's lock.
  const [owner] = await tx
    .select({ merchantId: merchantShops.merchantId })
    .from(merchantShops)
    .where(eq(merchantShops.id, input.shopId));
  if (!owner) throw new OrderError('NOT_FOUND', 'No such shop');
  const merchant = await lockShopMerchant(tx, owner.merchantId);
  const shop = await lockShop(tx, input.shopId, 'share');
  const closed = shop.status === 'closed';
  // SH5, PR7: an active shop of a merchant, or a closed one at its stored list.
  if (shop.status !== 'active' && !closed) {
    throw new OrderError('SHOP_UNAVAILABLE', 'The shop sells nothing now', { status: shop.status });
  }
  if (!closed && merchant.accountType !== 'merchant') {
    throw new OrderError('SHOP_UNAVAILABLE', 'The shop sells nothing now', { status: shop.status });
  }
  const priceListId = closed ? shop.priceListIdAtClose : merchant.priceListId;
  if (priceListId === null) throw new Error(`Shop ${shop.id} closed without its list`);
  const buyer = await lockShopCustomer(tx, shop.id, input.shopCustomerId);
  if (buyer.frozenAt !== null) throw new OrderError('ACCOUNT_FROZEN', 'The account is frozen');
  if (!buyer.emailVerified) {
    throw new OrderError('EMAIL_NOT_VERIFIED', 'The email is not verified yet');
  }
  const [product] = await tx
    .select()
    .from(catalogProducts)
    .where(eq(catalogProducts.id, input.productId))
    .for('share');
  if (!product) throw new OrderError('NOT_FOUND', 'No such product');
  // ST6: a hidden game's packs never sell in the shop.
  const [hidden] = await tx
    .select({ gameId: merchantShopHiddenGames.gameId })
    .from(merchantShopHiddenGames)
    .where(
      and(
        eq(merchantShopHiddenGames.shopId, shop.id),
        eq(merchantShopHiddenGames.gameId, product.gameId),
      ),
    );
  if (hidden) throw new OrderError('NOT_FOUND', 'No such product');

  const line = await prepareLine(
    tx,
    context,
    {
      fakeEnabled: input.fakeEnabled,
      playerCheck: input.playerCheck,
      isTest: merchant.isTest,
      priceListId,
      // PR5: the product's customer limit, not the merchant's tier quantities.
      accountType: 'customer',
      tierQuantities: null,
      earlyAccess: !closed && merchant.earlyAccess,
      skipPriceCheck: true,
    },
    {
      productId: input.productId,
      quantity: input.quantity,
      fields: input.fields,
      expectedUnitPriceUsdUnits: 0,
      confirmPlayer: input.confirmPlayer,
    },
    product,
  );
  // PR1: F44 cash products are not sold in shops.
  if (line.serviceClass === 'cash') {
    throw new OrderError('PRODUCT_UNAVAILABLE', 'Cash is not sold in shops', {
      availability: 'hidden',
    });
  }
  const unitBuy = line.price.priceUsdUnits;
  const [settings, own, { rate }, storeRate] = [
    await sellingSettingsOf(tx, shop.merchantId),
    await ownSellingPrice(tx, shop.merchantId, product.id),
    await shopRateNow(tx, shop),
    await rateInForce(tx),
  ];
  const unitSell = shopSellingPrice(unitBuy, settings, own, rate);
  // PR3: never below the merchant's purchase price (edge case 2), nor a SYP price without a rate.
  if (unitSell === null || !shopPackSellable(unitSell, unitBuy)) {
    throw new OrderError('PRODUCT_UNAVAILABLE', 'The pack is not sold in the shop now', {
      availability: 'paused_by_margin_guard',
    });
  }
  if (unitSell !== input.expectedUnitSellUsdUnits) {
    throw new OrderError('PRICE_CHANGED', 'The price is not the one expected', {
      unitPriceUsdUnits: unitSell,
    });
  }
  const amounts = shopOrderAmounts(unitSell, unitBuy, line.quantity);
  const step = settings.sypStepUnits ?? storeRate?.displayStepSypUnits ?? null;
  const unitSellSyp = step === null ? null : shopSellingSyp(unitSell, own, rate, step);

  const orderId = newId();
  // S25 CL5, PR7: the recipient's lock before the wallet's; the retail limits per shop customer.
  const section = sectionLines([line]);
  const policy = section.length > 0 ? await currentCreditPolicy(tx) : null;
  await lockRecipients(
    tx,
    section.map((entry) => entry.recipient),
  );
  const wallet = await lockShopCustomerWallet(tx, buyer.id);
  if (policy) {
    await checkCreditLimits(tx, {
      policy,
      owner: { shopCustomerId: buyer.id },
      merchant: false,
      walletId: wallet,
      lines: section,
    });
  }
  const postings = [
    { accountId: wallet, amountUnits: -amounts.sellUsdUnits },
    { accountId: await salesRevenue(tx), amountUnits: amounts.buyUsdUnits },
  ];
  if (amounts.marginUsdUnits > 0) {
    postings.push({ accountId: await shopMarginHeld(tx), amountUnits: amounts.marginUsdUnits });
  }
  // `postJournal` refuses `INSUFFICIENT_BALANCE` under the wallet's lock.
  const { journalId } = await postJournal(tx, {
    idempotencyKey: `order:${orderId}:purchase`,
    kind: 'purchase',
    postings,
  });

  const order = await insertOrder(tx, {
    id: orderId,
    customerId: shop.merchantId,
    shopCustomerId: buyer.id,
    isTest: merchant.isTest,
    ...lineValues(line),
    // The merchant's purchase as every order shows it (rule O6); the shop's SYP is on the sale row.
    ...(await displayTotal(tx, line.total)),
    status: 'paid',
    idempotencyKey: input.idempotencyKey,
    requestHash: input.requestHash,
    purchaseJournalId: journalId,
    paidAt: sql`now()`,
  });
  const [sale] = await tx
    .insert(shopOrderSales)
    .values({
      orderId: order.id,
      shopId: shop.id,
      shopCustomerId: buyer.id,
      unitSellUsdUnits: unitSell,
      unitBuyUsdUnits: unitBuy,
      quantity: line.quantity,
      sellCurrency: own?.currency === 'syp' ? 'syp' : 'usd',
      unitSellEnteredUnits: own?.currency === 'syp' ? own.amountUnits : unitSell,
      unitSellSypUnits: unitSellSyp,
      rateSypPerUsd: rate,
    })
    .returning();
  if (!sale) throw new Error('The shop sale was not written');
  await addOrderEvent(
    tx,
    order.id,
    'status',
    { actor: 'customer', actorId: buyer.id },
    { from: null, to: order.status },
  );
  await recordAudit(tx, {
    action: 'shop.order_paid',
    actorKind: 'shop_customer',
    actorId: buyer.id,
    channel: 'store',
    entityType: 'order',
    entityId: order.id,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    details: {
      number: order.number,
      shopCustomerId: buyer.id,
      productId: product.id,
      quantity: line.quantity,
      sellUsdUnits: amounts.sellUsdUnits,
      buyUsdUnits: amounts.buyUsdUnits,
      journalId,
    },
  });
  await queueFulfil(tx, context.jobs, order.id);
  // S23: the merchant's purchase from Vertex counts B toward the tier (spec default).
  if (merchant.accountType === 'merchant') await afterMerchantPurchase(tx, context.jobs, merchant);
  if (policy) await afterSectionOrder(tx, context, policy, order);
  return { order, sale, created: true };
}

/** `numeric` rates come back as text with trailing zeros; the rate as the contracts write it. */
export function saleRate(sale: Pick<ShopSaleRow, 'rateSypPerUsd'>): string | null {
  return sale.rateSypPerUsd === null ? null : rateFromNumeric(sale.rateSypPerUsd);
}
