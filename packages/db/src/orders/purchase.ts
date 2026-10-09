import { randomInt } from 'node:crypto';
import {
  type AuditChannel,
  availabilityForCustomer,
  type ErrorCode,
  ORDER_NUMBER_ALPHABET,
  ORDER_NUMBER_LENGTH,
  ORDER_NUMBER_PREFIX,
  orderFieldValuesSchema,
  orderTotal,
  type PlayerCheckState,
  RESERVATION_HOURS,
  RESERVATIONS_MAX,
  rateFromNumeric,
  sypDisplayPrice,
} from '@vertex-digital/contracts';
import { and, asc, count, desc, eq, isNull, sql } from 'drizzle-orm';
import type { PgInsertValue } from 'drizzle-orm/pg-core';
import { recordAudit } from '../audit/index.js';
import type { Transaction } from '../client.js';
import { newId } from '../id.js';
import {
  accountBalance,
  ensureSystemAccount,
  lockCustomerWallet,
  postJournal,
} from '../ledger/index.js';
import { type ProductRoutingState, productRoutingStates } from '../pricing/index.js';
import {
  catalogInputFields,
  catalogProducts,
  customers,
  exchangeRates,
  orders,
} from '../schema/index.js';
import { findSavedPlayer, type SavedPlayerRow, touchSavedPlayer } from './saved-players.js';
import { createShareLink } from './share-links.js';
import {
  addOrderEvent,
  type OrderContext,
  type OrderRow,
  queueFulfil,
  queuePayWaiting,
} from './transition.js';

/** A purchase refusal the API answers with its contract code (S08 rules O1–O5). */
export class OrderError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'OrderError';
    this.code = code;
    this.details = details;
  }
}

/** One pack to buy: a purchase, or a line of a checkout (S10 rule CT5). */
export interface LineInput {
  productId: string;
  quantity: number;
  /** Input field key → value, as typed (rule O5). */
  fields: Record<string, string>;
  expectedUnitPriceUsdUnits: number;
  /** S09 rule PV8: the customer confirmed a player id that is not known valid. */
  confirmPlayer: boolean;
  /** S10 rule SP1: save the player id with this label. */
  savePlayer?: { label: string } | undefined;
  /** S10 rule GF1: a direct top-up for someone else; empty texts are none. */
  gift?: { senderName?: string | undefined; message?: string | undefined } | undefined;
}

/** What a purchase or a checkout knows beyond its lines. */
export interface PurchaseCommon {
  customerId: string;
  /** The customer's `Idempotency-Key` and the SHA-256 hex of the canonical body (rule O1). */
  idempotencyKey: string;
  requestHash: string;
  /** `SUPPLIER_FAKE_ENABLED` (S07 rule SP1). */
  fakeEnabled: boolean;
  /** The `purchases_stopped` switch, read under the switches' shared lock (rule O2). */
  purchasesStopped: boolean;
  /** `store` for the customer's request, `cli` for `order:place`. */
  channel: Extract<AuditChannel, 'store' | 'cli'>;
  /**
   * S09 rule PV8: the cached player check of the order's fields, read by the API (it holds the
   * HMAC key and the adapters' capabilities); null when no check is possible for this purchase.
   */
  playerCheck: (
    tx: Transaction,
    order: {
      productId: string;
      gameId: string;
      productKind: 'direct' | 'code';
      isTest: boolean;
      fields: Record<string, string>;
    },
  ) => Promise<PlayerCheckLookup | null>;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface PurchaseInput extends PurchaseCommon, LineInput {
  /** S09 rule RS1: `reserve` makes a reservation when the balance is short. */
  whenBalanceShort: 'refuse' | 'reserve';
}

/** What the cache knows of the order's fields (S09 rule PV8); `none`: no unexpired row. */
export type PlayerCheckLookup =
  | { result: 'valid'; playerName: string | null }
  | { result: 'invalid' }
  | { result: 'none' };

/** Attempts at a free order number before giving up (6 characters: 887 million numbers). */
const NUMBER_ATTEMPTS = 5;

function orderNumber(): string {
  let text = ORDER_NUMBER_PREFIX;
  for (let index = 0; index < ORDER_NUMBER_LENGTH; index += 1) {
    text += ORDER_NUMBER_ALPHABET[randomInt(ORDER_NUMBER_ALPHABET.length)];
  }
  return text;
}

const uniqueViolation = (error: unknown, constraint: string): boolean => {
  const cause = (error as { cause?: { code?: string; constraint?: string } })?.cause ?? error;
  const pg = cause as { code?: string; constraint?: string };
  return pg.code === '23505' && pg.constraint === constraint;
};

/** The product's routing state now; routes of a supplier this build cannot use stay out (SP1). */
export async function routingNow(
  tx: Transaction,
  productId: string,
  now: Date,
  fakeEnabled: boolean,
): Promise<ProductRoutingState | undefined> {
  return (await productRoutingStates(tx, [productId], { now, fakeEnabled })).get(productId);
}

/** The product's availability for this customer (S08 rule O3: test routes for test customers). */
export function availabilityNow(usable: ProductRoutingState, isTest: boolean) {
  const current = usable.current;
  return usable.availability === 'hidden' || usable.availability === 'paused'
    ? usable.availability
    : availabilityForCustomer(
        {
          categoryArchived: false,
          gameArchived: false,
          productArchived: false,
          gameStatus: 'active',
          productStatus: 'active',
          price: current
            ? {
                priceUsdUnits: current.priceUsdUnits,
                minMarginUsdUnits: usable.rule.values.minMarginUsdUnits,
              }
            : null,
        },
        usableRouteCosts(usable),
        isTest,
      );
}

/** The usable routes' suppliers and costs (rule RT4). */
export function usableRouteCosts(usable: ProductRoutingState) {
  return usable.routes
    .filter((route) => route.unusableReason === null)
    .map((route) => ({
      supplierCode: route.supplierCode,
      costUsdUnits: route.costUsdUnits as number,
    }));
}

/** The order's fields checked against the game's unarchived fields (rule O5), or the refusals. */
export async function checkOrderFields(
  tx: Transaction,
  gameId: string,
  values: Record<string, string>,
): Promise<
  { ok: true; fields: Record<string, string> } | { ok: false; refusals: Record<string, string> }
> {
  const fieldRules = await tx
    .select()
    .from(catalogInputFields)
    .where(and(eq(catalogInputFields.gameId, gameId), isNull(catalogInputFields.archivedAt)))
    .orderBy(asc(catalogInputFields.sortOrder));
  const parsed = orderFieldValuesSchema(fieldRules).safeParse(values);
  if (parsed.success) return { ok: true, fields: parsed.data };
  const refusals: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) refusals[key] = 'unknown';
    } else {
      refusals[String(issue.path[0])] ??= issue.code;
    }
  }
  return { ok: false, refusals };
}

/** The SYP shown for a USD total at the newest rate (rule O6); nulls without a rate. */
export async function displayTotal(tx: Transaction, totalUsdUnits: number) {
  const [rate] = await tx
    .select()
    .from(exchangeRates)
    .orderBy(desc(exchangeRates.createdAt), desc(exchangeRates.id))
    .limit(1);
  return {
    displayRateId: rate?.id ?? null,
    totalSypUnits: rate
      ? sypDisplayPrice(totalUsdUnits, rateFromNumeric(rate.sypPerUsd), rate.displayStepSypUnits)
      : null,
  };
}

type ProductRow = typeof catalogProducts.$inferSelect;

/** A line that passed its checks: the price in force, the fields as stored, the player check. */
export interface PreparedLine {
  product: ProductRow;
  price: { id: string; priceUsdUnits: number; minMarginUsdUnits: number };
  quantity: number;
  total: number;
  fields: Record<string, string>;
  playerCheck: PlayerCheckState;
  playerName: string | null;
  gift: { senderName: string | null; message: string | null } | null;
  savePlayer: { label: string } | null;
}

/**
 * The checks of one line on its product, locked `FOR SHARE` by the caller (repricing takes it
 * `FOR UPDATE`, so the price read is the one in force): availability for this customer (O3), the
 * expected price (O4), the quantity and the fields (O5), the gift on a direct product (S10 GF1)
 * and the player confirmation (S09 PV8). A refusal throws its `OrderError`.
 */
export async function prepareLine(
  tx: Transaction,
  context: Pick<OrderContext, 'now'>,
  common: Pick<PurchaseCommon, 'fakeEnabled' | 'playerCheck'> & { isTest: boolean },
  line: LineInput,
  product: ProductRow,
): Promise<PreparedLine> {
  const usable = await routingNow(tx, product.id, context.now, common.fakeEnabled);
  if (!usable) throw new OrderError('NOT_FOUND', 'No such product');
  const current = usable.current;
  const availability = availabilityNow(usable, common.isTest);
  if (availability !== 'available' || !current) {
    throw new OrderError('PRODUCT_UNAVAILABLE', 'The product cannot be bought now', {
      availability,
    });
  }
  if (current.priceUsdUnits !== line.expectedUnitPriceUsdUnits) {
    throw new OrderError('PRICE_CHANGED', 'The price is not the one expected', {
      unitPriceUsdUnits: current.priceUsdUnits,
    });
  }
  if (line.quantity > product.maxQuantity) {
    throw new OrderError('VALIDATION_FAILED', 'Quantity above the product maximum', {
      fields: { quantity: 'too_big' },
    });
  }
  if (line.gift && product.kind !== 'direct') {
    throw new OrderError('VALIDATION_FAILED', 'Only a direct top-up can be a gift', {
      gift: 'code_product',
    });
  }
  const checked = await checkOrderFields(tx, product.gameId, line.fields);
  if (!checked.ok) {
    throw new OrderError('VALIDATION_FAILED', 'The account fields are not valid', {
      fields: checked.refusals,
    });
  }
  const fields = checked.fields;

  // S09 rule PV8: a player id not known valid needs the customer's confirmation.
  let playerCheck: PlayerCheckState = 'none';
  let playerName: string | null = null;
  const lookup = await common.playerCheck(tx, {
    productId: product.id,
    gameId: product.gameId,
    productKind: product.kind,
    isTest: common.isTest,
    fields,
  });
  if (lookup?.result === 'valid') {
    playerCheck = 'valid';
    playerName = lookup.playerName;
  } else if (lookup) {
    if (!line.confirmPlayer) {
      throw new OrderError('PLAYER_NOT_CONFIRMED', 'The player id is not confirmed', {
        result: lookup.result,
      });
    }
    playerCheck = lookup.result === 'invalid' ? 'invalid_confirmed' : 'unchecked_confirmed';
  }
  return {
    product,
    price: {
      id: current.id,
      priceUsdUnits: current.priceUsdUnits,
      minMarginUsdUnits: current.minMarginUsdUnits,
    },
    quantity: line.quantity,
    total: orderTotal(current.priceUsdUnits, line.quantity),
    fields,
    playerCheck,
    playerName,
    gift: line.gift
      ? { senderName: line.gift.senderName || null, message: line.gift.message || null }
      : null,
    savePlayer: product.kind === 'direct' && line.savePlayer ? line.savePlayer : null,
  };
}

/** Inserts an order with a free number (a taken one is drawn again). */
export async function insertOrder(
  tx: Transaction,
  values: Omit<PgInsertValue<typeof orders>, 'number'>,
): Promise<OrderRow> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await tx.transaction(async (step) => {
        const [row] = await step
          .insert(orders)
          .values({ ...values, number: orderNumber() })
          .returning();
        return row as OrderRow;
      });
    } catch (error) {
      if (!uniqueViolation(error, 'orders_number_unique') || attempt >= NUMBER_ATTEMPTS)
        throw error;
    }
  }
}

/** The order columns a prepared line fixes (identity, price, fields, player check, gift). */
export function lineValues(line: PreparedLine) {
  return {
    productId: line.product.id,
    gameId: line.product.gameId,
    kind: line.product.kind,
    quantity: line.quantity,
    unitPriceUsdUnits: line.price.priceUsdUnits,
    totalUsdUnits: line.total,
    priceId: line.price.id,
    minMarginUsdUnits: line.price.minMarginUsdUnits,
    fields: line.fields,
    playerCheck: line.playerCheck,
    playerName: line.playerName,
    isGift: line.gift !== null,
    giftSenderName: line.gift?.senderName ?? null,
    giftMessage: line.gift?.message ?? null,
  };
}

/**
 * The pay step (rules O1–O6, M1) in the caller's READ COMMITTED transaction, after the caller took
 * the switches lock shared and read the purchase stop (rule O2): replays the same key and body
 * (even while stopped), refuses a new purchase while stopped, locks the product `FOR SHARE`,
 * checks the line (`prepareLine`), then posts the purchase journal (which locks the wallet and
 * refuses `INSUFFICIENT_BALANCE`), inserts the `paid` order, its event, the audit entry, the saved
 * id (S10 SP1, SP4), the gift link (GF4) and the `orders.fulfil` job. Any refusal throws, and the
 * caller's transaction rolls everything back.
 */
export async function purchaseOrder(
  tx: Transaction,
  context: Pick<OrderContext, 'jobs' | 'now'>,
  input: PurchaseInput,
): Promise<{ order: OrderRow; created: boolean; savedPlayer: SavedPlayerRow | null }> {
  // The same key waits here for its first request, then reads what it committed.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`order:${input.idempotencyKey}`}))`);
  const [existing] = await tx
    .select()
    .from(orders)
    .where(eq(orders.idempotencyKey, input.idempotencyKey));
  if (existing) {
    if (existing.customerId !== input.customerId || existing.requestHash !== input.requestHash) {
      throw new OrderError('IDEMPOTENCY_KEY_REUSED', 'The key was used for another purchase');
    }
    const savedPlayer = input.savePlayer
      ? await findSavedPlayer(tx, existing.customerId, existing.gameId, existing.fields)
      : null;
    return { order: existing, created: false, savedPlayer };
  }
  if (input.purchasesStopped) throw new OrderError('PURCHASES_STOPPED', 'Purchases are stopped');

  const [customer] = await tx
    .select({ isTest: customers.isTest })
    .from(customers)
    .where(eq(customers.id, input.customerId));
  if (!customer) throw new Error(`Customer ${input.customerId} does not exist`);
  const [product] = await tx
    .select()
    .from(catalogProducts)
    .where(eq(catalogProducts.id, input.productId))
    .for('share');
  if (!product) throw new OrderError('NOT_FOUND', 'No such product');
  const line = await prepareLine(
    tx,
    context,
    { ...input, isTest: customer.isTest },
    input,
    product,
  );

  const orderId = newId();
  const total = line.total;
  const display = await displayTotal(tx, total);
  // The wallet lock first (S09 rule RS2): the balance and the reservations count under it.
  const wallet = await lockCustomerWallet(tx, input.customerId);
  const reserve =
    input.whenBalanceShort === 'reserve' && (await accountBalance(tx, wallet)) < total;
  let journalId: string | null = null;
  if (reserve) {
    const [open] = await tx
      .select({ count: count() })
      .from(orders)
      .where(and(eq(orders.customerId, input.customerId), eq(orders.status, 'awaiting_balance')));
    if ((open?.count ?? 0) >= RESERVATIONS_MAX) {
      throw new OrderError('RESERVATIONS_LIMIT_REACHED', 'Too many open reservations', {
        limit: RESERVATIONS_MAX,
      });
    }
  } else {
    const journal = await postJournal(tx, {
      idempotencyKey: `order:${orderId}:purchase`,
      kind: 'purchase',
      postings: [
        { accountId: wallet, amountUnits: -total },
        { accountId: await salesRevenue(tx), amountUnits: total },
      ],
    });
    journalId = journal.journalId;
  }

  const order = await insertOrder(tx, {
    id: orderId,
    customerId: input.customerId,
    isTest: customer.isTest,
    ...lineValues(line),
    ...display,
    status: reserve ? 'awaiting_balance' : 'paid',
    idempotencyKey: input.idempotencyKey,
    requestHash: input.requestHash,
    purchaseJournalId: journalId,
    paidAt: reserve ? null : sql`now()`,
    reservedAt: reserve ? sql`now()` : null,
    expiresAt: reserve ? sql`now() + ${`${RESERVATION_HOURS} hours`}::interval` : null,
  });

  const audit = purchaseAudit(input, order.id);
  await addOrderEvent(
    tx,
    order.id,
    'status',
    { actor: 'customer', actorId: input.customerId },
    { from: null, to: order.status },
  );
  const savedPlayer = await touchSavedPlayer(tx, order, line.savePlayer);
  if (reserve) {
    await recordAudit(tx, {
      ...audit,
      action: 'order.reserved',
      details: {
        number: order.number,
        productId: product.id,
        quantity: input.quantity,
        totalUsdUnits: total,
        expiresAt: (order.expiresAt as Date).toISOString(),
      },
    });
    // Rule RS4: a credit may have landed while the customer decided.
    await queuePayWaiting(tx, context.jobs, input.customerId);
  } else {
    await recordAudit(tx, {
      ...audit,
      action: 'order.paid',
      details: {
        number: order.number,
        productId: product.id,
        quantity: input.quantity,
        totalUsdUnits: total,
        journalId: journalId as string,
        ...(order.isGift && { gift: true }),
      },
    });
    if (order.isGift) await createShareLink(tx, { orderId: order.id, kind: 'gift' });
    await queueFulfil(tx, context.jobs, order.id);
  }
  return { order, created: true, savedPlayer };
}

/** The system account every purchase credits (S08 rule M1). */
export function salesRevenue(tx: Transaction) {
  return ensureSystemAccount(tx, {
    code: 'sales_revenue:USD',
    kind: 'sales_revenue',
    currency: 'USD',
  });
}

/** The audit entry's actor of a purchase or a checkout. */
export function purchaseAudit(
  input: Pick<PurchaseCommon, 'channel' | 'customerId' | 'ipAddress' | 'userAgent'>,
  orderId: string,
) {
  return {
    actorKind: input.channel === 'cli' ? 'cli' : 'customer',
    actorId: input.channel === 'cli' ? null : input.customerId,
    channel: input.channel,
    entityType: 'order',
    entityId: orderId,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  } as const;
}
