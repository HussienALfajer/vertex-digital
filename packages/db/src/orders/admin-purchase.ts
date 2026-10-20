import {
  type AdminOrderPurpose,
  adminOrderShape,
  ownerCapRemaining,
  ROOT_PRICE_LIST_IDS,
} from '@vertex-digital/contracts';
import { and, eq, gte, sql } from 'drizzle-orm';
import { recordAudit } from '../audit/index.js';
import type { Database, Transaction } from '../client.js';
import { checkPurchaseCap, lockActiveCustomer } from '../customers/guard.js';
import { newId } from '../id.js';
import { lockCustomerWallet, postJournal } from '../ledger/index.js';
import { notifyCustomer } from '../notifications/index.js';
import {
  catalogGames,
  catalogProducts,
  customers,
  ledgerAccounts,
  orders,
} from '../schema/index.js';
import { queueTelegramMessage } from '../telegram/index.js';
import { OrderError } from './errors.js';
import { ownerDrawings } from './outcome.js';
import {
  displayTotal,
  insertOrder,
  lineValues,
  type PurchaseCommon,
  prepareLine,
  salesRevenue,
} from './purchase.js';
import {
  addOrderEvent,
  currentOrderPolicy,
  type OrderContext,
  type OrderRow,
  queueFulfil,
} from './transition.js';

/*
 * Purchases from the panel (S16 rules AP1–AP13, AM1, AM2; ADR 0030): one product per order, at the
 * store's current price, paid from the customer's wallet (`on_behalf`) or from the owner's funds
 * (`walk_in`, `gift`, `compensation`), booked against `owner_drawings:USD` under a daily cap.
 */

export interface AdminPurchaseInput
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
  adminId: string;
  purpose: AdminOrderPurpose;
  /** Null exactly for `walk_in` (rule AP1). */
  customerId: string | null;
  productId: string;
  quantity: number;
  fields: Record<string, string>;
  expectedUnitPriceUsdUnits: number;
  confirmPlayer: boolean;
  /** Internal (rule AP9). */
  reason: string;
  /** Shown to the customer; gifts and compensations only. */
  customerNote: string | null;
}

/** The time zone of the owner's day (rule AP7). */
const OWNER_DAY_TIME_ZONE = 'Asia/Damascus';

const damascusMidnight = sql`((now() at time zone ${OWNER_DAY_TIME_ZONE})::date::timestamp at time zone ${OWNER_DAY_TIME_ZONE})`;

/**
 * Rule AP7: owner-funded orders paid since 00:00 Damascus today, their count and their totals less
 * what was refunded.
 */
export async function ownerSpentToday(
  db: Database | Transaction,
): Promise<{ count: number; usedUsdUnits: number }> {
  const [row] = await db
    .select({
      count: sql<string>`count(*)::text`,
      used: sql<string>`coalesce(sum(${orders.totalUsdUnits} - ${orders.refundedUsdUnits}), 0)::text`,
    })
    .from(orders)
    .where(and(eq(orders.payer, 'owner'), gte(orders.paidAt, damascusMidnight)));
  return { count: Number(row?.count ?? 0), usedUsdUnits: Number(row?.used ?? 0) };
}

/**
 * Rules AP3–AP7 in the caller's READ COMMITTED transaction, after the caller took the switches
 * lock shared and read the purchase stop (AP3): replays the same key and body (even while
 * stopped); refuses a new order while stopped; checks the customer (AP4: archived `NOT_FOUND`,
 * `EMAIL_NOT_VERIFIED`, `ACCOUNT_FROZEN`), locks the product `FOR SHARE` and checks the line (AP5,
 * AP6, AP8); posts the purchase journal from the wallet (AM1: wallet lock, the customer's cap,
 * `INSUFFICIENT_BALANCE`) or from owner drawings (AM2: the account locked `FOR UPDATE` while the
 * day's owner total is summed against the cap, AP7); then inserts the `paid` order, its event,
 * the audit entry, the `orders.fulfil` job, the customer's notification (AP11) and the Telegram
 * notice (AP13). Any refusal throws; the caller's transaction rolls everything back.
 */
export async function adminPurchaseOrder(
  tx: Transaction,
  context: Pick<OrderContext, 'jobs' | 'now'>,
  input: AdminPurchaseInput,
): Promise<{ order: OrderRow; created: boolean }> {
  const shape = adminOrderShape(input.purpose);
  if (shape.hasCustomer !== (input.customerId !== null)) {
    throw new OrderError('VALIDATION_FAILED', 'The mode and the customer do not match', {
      fields: { customerId: shape.hasCustomer ? 'required' : 'not_allowed' },
    });
  }
  // The same key waits here for its first request, then reads what it committed.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`order:${input.idempotencyKey}`}))`);
  const [existing] = await tx
    .select()
    .from(orders)
    .where(eq(orders.idempotencyKey, input.idempotencyKey));
  if (existing) {
    if (existing.placedBy !== 'admin' || existing.requestHash !== input.requestHash) {
      throw new OrderError('IDEMPOTENCY_KEY_REUSED', 'The key was used for another purchase');
    }
    return { order: existing, created: false };
  }
  if (input.purchasesStopped) throw new OrderError('PURCHASES_STOPPED', 'Purchases are stopped');

  // AP4: the customer's own rules (S12 CF2's lock first, before any write).
  let customer: Awaited<ReturnType<typeof lockActiveCustomer>> | null = null;
  if (input.customerId !== null) {
    const [row] = await tx
      .select({ archivedAt: customers.archivedAt, emailVerified: customers.emailVerified })
      .from(customers)
      .where(eq(customers.id, input.customerId))
      .for('share');
    if (!row || row.archivedAt !== null) throw new OrderError('NOT_FOUND', 'No such customer');
    if (!row.emailVerified) {
      throw new OrderError('EMAIL_NOT_VERIFIED', "The customer's email is not verified");
    }
    customer = await lockActiveCustomer(tx, input.customerId);
  }
  const isTest = customer?.isTest ?? false;
  const [product] = await tx
    .select()
    .from(catalogProducts)
    .where(eq(catalogProducts.id, input.productId))
    .for('share');
  if (!product) throw new OrderError('NOT_FOUND', 'No such product');
  const line = await prepareLine(
    tx,
    context,
    {
      ...input,
      isTest,
      allowPaused: shape.payer === 'owner',
      // S20 PO4: on behalf charges the customer's list; walk-in and owner-funded take retail.
      priceListId:
        customer && shape.payer === 'customer' ? customer.priceListId : ROOT_PRICE_LIST_IDS.retail,
    },
    { ...input, savePlayer: undefined, gift: undefined },
    product,
  );

  const orderId = newId();
  const total = line.total;
  const display = await displayTotal(tx, total);
  let payFrom: string;
  let owner: { usedUsdUnits: number; capUsdUnits: number } | null = null;
  if (customer && shape.payer === 'customer') {
    // AM1 as S08 M1: the wallet lock, then the cap read under it (S12 LM4).
    payFrom = await lockCustomerWallet(tx, customer.id);
    await checkPurchaseCap(tx, customer, total);
  } else {
    // AP7: the owner drawings row locked, so two admin orders sum the day one after the other.
    payFrom = await ownerDrawings(tx);
    await tx
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.id, payFrom))
      .for('update');
    const capUsdUnits = (await currentOrderPolicy(tx)).ownerDailyCapUsdUnits;
    const { usedUsdUnits } = await ownerSpentToday(tx);
    const remainingUsdUnits = ownerCapRemaining(capUsdUnits, usedUsdUnits);
    if (total > remainingUsdUnits) {
      throw new OrderError('OWNER_DAILY_CAP_EXCEEDED', 'Beyond the owner daily cap', {
        remainingUsdUnits,
      });
    }
    owner = { usedUsdUnits: usedUsdUnits + total, capUsdUnits };
  }
  const journal = await postJournal(tx, {
    idempotencyKey: `order:${orderId}:purchase`,
    kind: 'purchase',
    postings: [
      { accountId: payFrom, amountUnits: -total },
      { accountId: await salesRevenue(tx), amountUnits: total },
    ],
  });

  const order = await insertOrder(tx, {
    id: orderId,
    customerId: input.customerId,
    isTest,
    ...lineValues(line),
    ...display,
    status: 'paid',
    idempotencyKey: input.idempotencyKey,
    requestHash: input.requestHash,
    purchaseJournalId: journal.journalId,
    paidAt: sql`now()`,
    placedBy: 'admin',
    payer: shape.payer,
    adminPurpose: input.purpose,
    adminId: input.adminId,
    adminReason: input.reason,
    customerNote: input.customerNote,
  });
  await addOrderEvent(
    tx,
    order.id,
    'status',
    { actor: 'admin', actorId: input.adminId },
    { from: null, to: 'paid' },
  );
  await recordAudit(tx, {
    action: 'order.paid',
    actorKind: 'admin',
    actorId: input.adminId,
    channel: 'admin',
    entityType: 'order',
    entityId: order.id,
    reason: input.reason,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    details: {
      number: order.number,
      productId: product.id,
      quantity: input.quantity,
      totalUsdUnits: total,
      journalId: journal.journalId,
      purpose: input.purpose,
      payer: shape.payer,
      customerId: input.customerId,
    },
  });
  await queueFulfil(tx, context.jobs, order.id);

  const [game] = await tx
    .select({ nameAr: catalogGames.nameAr })
    .from(catalogGames)
    .where(eq(catalogGames.id, product.gameId));
  if (input.customerId !== null && input.purpose !== 'walk_in') {
    await notifyCustomer(tx, context.jobs, {
      customerId: input.customerId,
      event: 'order_placed_for_you',
      params: {
        orderId: order.id,
        orderNumber: order.number,
        productNameAr: product.nameAr,
        purpose: input.purpose,
        ...(input.customerNote !== null && { message: input.customerNote }),
      },
    });
  }
  await queueTelegramMessage(tx, context.jobs, {
    kind: 'admin_order_placed',
    dedupeKey: `admin-order:${order.id}`,
    params: {
      orderId: order.id,
      orderNumber: order.number,
      purpose: input.purpose,
      gameNameAr: game?.nameAr ?? '',
      productNameAr: product.nameAr,
      quantity: order.quantity,
      totalUsdUnits: total,
      owner,
    },
  });
  return { order, created: true };
}
