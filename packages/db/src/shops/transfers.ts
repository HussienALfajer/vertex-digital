import {
  rateFromNumeric,
  type ShopTransferCurrency,
  shopTransferRefusal,
  shopTransferUsd,
} from '@vertex-digital/contracts';
import { eq } from 'drizzle-orm';
import { recordAudit } from '../audit/index.js';
import type { Transaction } from '../client.js';
import { lockActiveCustomer } from '../customers/guard.js';
import { accountBalance } from '../ledger/balance.js';
import { postJournal } from '../ledger/post-journal.js';
import { lockCustomerWallet, lockShopCustomerWallet } from '../ledger/wallet.js';
import { type JobSender, queueEmail } from '../notifications/index.js';
import { customers, shopTransfers } from '../schema/index.js';
import {
  auditActor,
  lockKey,
  lockShop,
  lockShopCustomer,
  type ShopActor,
  ShopError,
  shopRateNow,
  transferredToday,
} from './state.js';

export type ShopTransferRow = typeof shopTransfers.$inferSelect;

export interface ShopTransferInput {
  shopId: string;
  merchantId: string;
  shopCustomerId: string;
  currency: ShopTransferCurrency;
  amountUnits: number;
  /** The USD the merchant's screen showed (WL2): another USD at the current rate is refused. */
  expectedUsdUnits: number;
  idempotencyKey: string;
  actor: ShopActor;
}

export interface ShopTransferOutcome {
  transfer: ShopTransferRow;
  customerBalanceUsdUnits: number;
  merchantBalanceUsdUnits: number;
  transferredTodayUsdUnits: number;
  /** The key was posted already with the same request: nothing new was written. */
  replayed: boolean;
}

/**
 * WL1–WL4: the merchant moves an amount to a shop customer's wallet. Under the key's lock (a
 * repeated key replays its transfer), the locks in a fixed order: the merchant `FOR SHARE`
 * (frozen refused), the shop (active), the shop customer (verified, not frozen), the merchant's
 * wallet, then the shop customer's. The amount at the shop's rate must be the one shown, and the
 * merchant's balance, the customer's cap and the day's cap must allow it. One `shop_transfer`
 * journal, the transfer row, the audit entry and the two emails commit together. The caller has
 * checked the merchant's recent password or passkey (WL4).
 */
export async function transferToShopCustomer(
  tx: Transaction,
  jobs: JobSender,
  input: ShopTransferInput,
): Promise<ShopTransferOutcome> {
  await lockKey(tx, `shop-transfer:${input.idempotencyKey}`);
  const [earlier] = await tx
    .select()
    .from(shopTransfers)
    .where(eq(shopTransfers.idempotencyKey, input.idempotencyKey));
  if (earlier) return replay(tx, input, earlier);

  const merchant = await lockActiveCustomer(tx, input.merchantId);
  if (merchant.accountType !== 'merchant') {
    throw new ShopError('NOT_MERCHANT', 'The account is not a merchant');
  }
  const shop = await lockShop(tx, input.shopId, 'share');
  if (shop.merchantId !== input.merchantId) throw new ShopError('NOT_FOUND', 'No such shop');
  if (shop.status !== 'active') {
    throw new ShopError('SHOP_UNAVAILABLE', 'The shop takes no transfers', { status: shop.status });
  }
  const customer = await lockShopCustomer(tx, shop.id, input.shopCustomerId);
  if (customer.frozenAt !== null) throw new ShopError('ACCOUNT_FROZEN', 'The customer is frozen');
  if (!customer.emailVerified) {
    throw new ShopError('CUSTOMER_STATE_INVALID', 'The customer has not verified the email');
  }
  const merchantWallet = await lockCustomerWallet(tx, input.merchantId);
  const customerWallet = await lockShopCustomerWallet(tx, customer.id);

  const { rate } = await shopRateNow(tx, shop);
  const amountUsdUnits = shopTransferUsd(input.currency, input.amountUnits, rate);
  if (amountUsdUnits === null) {
    throw new ShopError('VALIDATION_FAILED', 'The amount cannot be transferred as entered');
  }
  if (amountUsdUnits !== input.expectedUsdUnits) {
    throw new ShopError('PRICE_CHANGED', 'The shop rate changed', { amountUsdUnits, rate });
  }
  const merchantBalance = await accountBalance(tx, merchantWallet);
  const customerBalance = await accountBalance(tx, customerWallet);
  const today = await transferredToday(tx, shop.id);
  const refusal = shopTransferRefusal({
    amountUsdUnits,
    merchantBalanceUsdUnits: merchantBalance,
    customerBalanceUsdUnits: customerBalance,
    balanceCapUsdUnits: shop.customerBalanceCapUsdUnits,
    transferredTodayUsdUnits: today,
    dailyCapUsdUnits: shop.dailyTransferCapUsdUnits,
  });
  if (refusal) {
    const { code, ...details } = refusal;
    throw new ShopError(code, 'The transfer is refused', details);
  }

  const { journalId } = await postJournal(tx, {
    idempotencyKey: `shop-transfer:${input.idempotencyKey}`,
    kind: 'shop_transfer',
    postings: [
      { accountId: merchantWallet, amountUnits: -amountUsdUnits },
      { accountId: customerWallet, amountUnits: amountUsdUnits },
    ],
  });
  const [transfer] = await tx
    .insert(shopTransfers)
    .values({
      shopId: shop.id,
      shopCustomerId: customer.id,
      cause: 'transfer',
      direction: 'to_customer',
      amountUsdUnits,
      enteredCurrency: input.currency,
      enteredAmountUnits: input.amountUnits,
      rateSypPerUsd: input.currency === 'syp' ? rate : null,
      journalId,
      idempotencyKey: input.idempotencyKey,
    })
    .returning();
  if (!transfer) throw new Error('The transfer was not written');
  await recordAudit(tx, {
    action: 'shop.transfer',
    ...auditActor(input.actor),
    entityType: 'merchant_shop',
    entityId: shop.id,
    details: {
      transferId: transfer.id,
      shopCustomerId: customer.id,
      amountUsdUnits,
      enteredCurrency: input.currency,
      enteredAmountUnits: input.amountUnits,
      rate: transfer.rateSypPerUsd === null ? null : rateFromNumeric(transfer.rateSypPerUsd),
      journalId,
    },
  });
  const at = transfer.createdAt.toISOString();
  await queueEmail(tx, jobs, {
    to: customer.email,
    template: 'shop_customer_transfer_received',
    params: { shopName: shop.displayName, slug: shop.slug, amountUsdUnits, at },
  });
  const [owner] = await tx
    .select({ email: customers.email })
    .from(customers)
    .where(eq(customers.id, input.merchantId));
  if (owner) {
    // Abuse: an email for each transfer, so a stolen session shows at once.
    await queueEmail(tx, jobs, {
      to: owner.email,
      template: 'customer_merchant_shop_transfer',
      customerId: input.merchantId,
      params: { customerName: customer.name, amountUsdUnits, at },
    });
  }
  return {
    transfer,
    customerBalanceUsdUnits: customerBalance + amountUsdUnits,
    merchantBalanceUsdUnits: merchantBalance - amountUsdUnits,
    transferredTodayUsdUnits: today + amountUsdUnits,
    replayed: false,
  };
}

/** The same key again: the first transfer when the request is the same, else refused. */
async function replay(
  tx: Transaction,
  input: ShopTransferInput,
  transfer: ShopTransferRow,
): Promise<ShopTransferOutcome> {
  if (
    transfer.shopId !== input.shopId ||
    transfer.shopCustomerId !== input.shopCustomerId ||
    transfer.cause !== 'transfer' ||
    transfer.enteredCurrency !== input.currency ||
    transfer.enteredAmountUnits !== input.amountUnits
  ) {
    throw new ShopError('IDEMPOTENCY_KEY_REUSED', 'The key was used for another transfer');
  }
  const merchantWallet = await lockCustomerWallet(tx, input.merchantId);
  const customerWallet = await lockShopCustomerWallet(tx, input.shopCustomerId);
  return {
    transfer,
    merchantBalanceUsdUnits: await accountBalance(tx, merchantWallet),
    customerBalanceUsdUnits: await accountBalance(tx, customerWallet),
    transferredTodayUsdUnits: await transferredToday(tx, input.shopId),
    replayed: true,
  };
}
