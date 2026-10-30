import {
  CHECKOUT_LINE_REFUSALS,
  type CheckoutLineRefusal,
  checkoutLinesMax,
  checkoutTotal,
  type NewCheckoutSource,
} from '@vertex-digital/contracts';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { recordAudit } from '../audit/index.js';
import type { Transaction } from '../client.js';
import { checkPurchaseCap, lockActiveCustomer, requireMerchantTerms } from '../customers/guard.js';
import { newId } from '../id.js';
import { LedgerError, lockCustomerWallet, postJournal } from '../ledger/index.js';
import { afterMerchantPurchase } from '../merchant-tools/alerts.js';
import { recordMerchantSale } from '../merchant-tools/sales.js';
import { catalogProducts, checkouts, orders } from '../schema/index.js';
import {
  displayTotal,
  insertOrder,
  type LineInput,
  lineValues,
  OrderError,
  type PreparedLine,
  type PurchaseCommon,
  prepareLine,
  purchaseAudit,
  salesRevenue,
} from './purchase.js';
import { touchSavedPlayer } from './saved-players.js';
import { createShareLink } from './share-links.js';
import { addOrderEvent, type OrderContext, type OrderRow, queueFulfil } from './transition.js';

/*
 * A cart paid at once (S10 F16, rules CT5, M1): every line is checked as a purchase would be, and
 * the whole cart is refused with each line's reason, or paid by one purchase journal with one
 * order per line. Nothing is reserved.
 */

export type CheckoutRow = typeof checkouts.$inferSelect;

export interface CheckoutInput extends PurchaseCommon {
  lines: LineInput[];
  /** S21 BK3: a new checkout is the cart's; `bulk` rows are past ones (removed 2026-10-30). */
  source?: NewCheckoutSource;
}

export interface CheckoutResult {
  checkout: CheckoutRow;
  /** In line order. */
  orders: OrderRow[];
  created: boolean;
}

const REFUSAL_CODES: readonly string[] = CHECKOUT_LINE_REFUSALS;

/** The checkout's orders, in line order. */
export async function checkoutOrderRows(db: Transaction, checkoutId: string): Promise<OrderRow[]> {
  return db
    .select()
    .from(orders)
    .where(eq(orders.checkoutId, checkoutId))
    .orderBy(asc(orders.checkoutLine));
}

/**
 * Rule CT5 in the caller's READ COMMITTED transaction, after it took the switches lock shared and
 * read the purchase stop: the same key replays its checkout; a stop refuses; every line's product
 * is locked `FOR SHARE` in id order (no deadlock with repricing or another checkout); every line
 * is checked and all refusals are collected into one `CHECKOUT_REFUSED`; then the checkout, one
 * `paid` order per line, one purchase journal for the sum (`checkout:<id>:purchase`, which locks
 * the wallet and refuses `INSUFFICIENT_BALANCE`), and for each order its event, audit entry,
 * saved id, gift link and `orders.fulfil` job.
 */
export async function checkoutOrders(
  tx: Transaction,
  context: Pick<OrderContext, 'jobs' | 'now'>,
  input: CheckoutInput,
): Promise<CheckoutResult> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`checkout:${input.idempotencyKey}`}))`,
  );
  const [existing] = await tx
    .select()
    .from(checkouts)
    .where(eq(checkouts.idempotencyKey, input.idempotencyKey));
  if (existing) {
    if (existing.customerId !== input.customerId || existing.requestHash !== input.requestHash) {
      throw new OrderError('IDEMPOTENCY_KEY_REUSED', 'The key was used for another checkout');
    }
    return {
      checkout: existing,
      orders: await checkoutOrderRows(tx, existing.id),
      created: false,
    };
  }
  if (input.purchasesStopped) throw new OrderError('PURCHASES_STOPPED', 'Purchases are stopped');

  // S12 CF2: the customer `FOR SHARE` before any write; a frozen customer is refused as a whole.
  const customer = await lockActiveCustomer(tx, input.customerId);
  requireMerchantTerms(customer);
  // S21 BK3, edge case 21, S23 TS5: up to the tier's lines for a merchant (read under the lock,
  // so a list checked under a higher tier is refused after a fall), 10 for a customer.
  const linesMax = checkoutLinesMax(customer.accountType, customer.tierQuantities);
  if (input.lines.length > linesMax) {
    throw new OrderError('VALIDATION_FAILED', 'Too many checkout lines', {
      lines: { max: linesMax },
    });
  }
  const productIds = [...new Set(input.lines.map((line) => line.productId))];
  const products = await tx
    .select()
    .from(catalogProducts)
    .where(inArray(catalogProducts.id, productIds))
    .orderBy(asc(catalogProducts.id))
    .for('share');
  const byId = new Map(products.map((product) => [product.id, product]));

  const prepared: PreparedLine[] = [];
  const refusals: CheckoutLineRefusal[] = [];
  for (const [index, line] of input.lines.entries()) {
    const product = byId.get(line.productId);
    try {
      if (!product) throw new OrderError('NOT_FOUND', 'No such product');
      prepared.push(
        await prepareLine(
          tx,
          context,
          {
            ...input,
            isTest: customer.isTest,
            priceListId: customer.priceListId,
            accountType: customer.accountType,
            tierQuantities: customer.tierQuantities,
            earlyAccess: customer.earlyAccess,
          },
          line,
          product,
        ),
      );
    } catch (error) {
      if (!(error instanceof OrderError)) throw error;
      if (error.code === 'NOT_FOUND') {
        refusals.push({ index, code: 'PRODUCT_UNAVAILABLE', details: { availability: 'hidden' } });
      } else if (REFUSAL_CODES.includes(error.code)) {
        refusals.push({
          index,
          code: error.code as CheckoutLineRefusal['code'],
          details: (error.details ?? {}) as Record<string, unknown>,
        });
      } else {
        throw error;
      }
    }
  }
  if (refusals.length > 0) {
    throw new OrderError('CHECKOUT_REFUSED', 'Some lines of the checkout were refused', {
      lines: refusals,
    });
  }

  const checkoutId = newId();
  const total = checkoutTotal(
    prepared.map((line) => ({
      unitPriceUsdUnits: line.price.priceUsdUnits,
      quantity: line.quantity,
    })),
  );
  const wallet = await lockCustomerWallet(tx, input.customerId);
  // S12 LM4: the whole total against the cap, all or nothing (edge case 5).
  await checkPurchaseCap(tx, customer, total);
  let journalId: string;
  try {
    const journal = await postJournal(tx, {
      idempotencyKey: `checkout:${checkoutId}:purchase`,
      kind: 'purchase',
      postings: [
        { accountId: wallet, amountUnits: -total },
        { accountId: await salesRevenue(tx), amountUnits: total },
      ],
    });
    journalId = journal.journalId;
  } catch (error) {
    if (error instanceof LedgerError && error.code === 'INSUFFICIENT_BALANCE') {
      const { balanceUnits } = error.details as { balanceUnits: number };
      throw new OrderError('INSUFFICIENT_BALANCE', 'The balance does not cover the cart', {
        balanceUnits,
        totalUnits: total,
      });
    }
    throw error;
  }
  const [checkout] = await tx
    .insert(checkouts)
    .values({
      id: checkoutId,
      customerId: input.customerId,
      isTest: customer.isTest,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      lineCount: prepared.length,
      source: input.source ?? 'cart',
      totalUsdUnits: total,
      ...(await displayTotal(tx, total)),
      purchaseJournalId: journalId,
    })
    .returning();
  if (!checkout) throw new Error('The checkout was not written');

  const written: OrderRow[] = [];
  for (const [index, line] of prepared.entries()) {
    const order = await insertOrder(tx, {
      id: newId(),
      customerId: input.customerId,
      isTest: customer.isTest,
      ...lineValues(line),
      ...(await displayTotal(tx, line.total)),
      status: 'paid',
      // Each order keeps its own key, derived from the checkout's (rule O1 holds per order).
      idempotencyKey: newId(),
      requestHash: input.requestHash,
      purchaseJournalId: journalId,
      paidAt: sql`now()`,
      checkoutId,
      checkoutLine: index + 1,
    });
    await addOrderEvent(
      tx,
      order.id,
      'status',
      { actor: 'customer', actorId: input.customerId, details: { checkoutId } },
      { from: null, to: 'paid' },
    );
    await recordAudit(tx, {
      ...purchaseAudit(input, order.id),
      action: 'order.paid',
      details: {
        number: order.number,
        productId: order.productId,
        quantity: order.quantity,
        totalUsdUnits: order.totalUsdUnits,
        journalId,
        checkoutId,
        ...(order.isGift && { gift: true }),
      },
    });
    await touchSavedPlayer(tx, order, line.savePlayer, customer.accountType);
    if (customer.accountType === 'merchant') await recordMerchantSale(tx, order);
    if (order.isGift) await createShareLink(tx, { orderId: order.id, kind: 'gift' });
    await queueFulfil(tx, context.jobs, order.id);
    written.push(order);
  }
  // S21 LV4, AL5 after the checkout's one debit.
  await afterMerchantPurchase(tx, context.jobs, customer);
  return { checkout, orders: written, created: true };
}
