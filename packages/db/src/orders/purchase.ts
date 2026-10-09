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
  rateFromNumeric,
  sypDisplayPrice,
} from '@vertex-digital/contracts';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { recordAudit } from '../audit/index.js';
import type { Transaction } from '../client.js';
import { newId } from '../id.js';
import { ensureCustomerWallet, ensureSystemAccount, postJournal } from '../ledger/index.js';
import { productRoutingStates } from '../pricing/index.js';
import {
  catalogInputFields,
  catalogProducts,
  customers,
  exchangeRates,
  orders,
} from '../schema/index.js';
import { addOrderEvent, type OrderContext, type OrderRow, queueFulfil } from './transition.js';

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

export interface PurchaseInput {
  customerId: string;
  productId: string;
  quantity: number;
  /** Input field key → value, as typed (rule O5). */
  fields: Record<string, string>;
  expectedUnitPriceUsdUnits: number;
  /** The customer's `Idempotency-Key` and the SHA-256 hex of the canonical body (rule O1). */
  idempotencyKey: string;
  requestHash: string;
  /** `SUPPLIER_FAKE_ENABLED` (S07 rule SP1). */
  fakeEnabled: boolean;
  /** `store` for the customer's request, `cli` for `order:place`. */
  channel: Extract<AuditChannel, 'store' | 'cli'>;
  ipAddress?: string | null;
  userAgent?: string | null;
}

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

/**
 * The pay step (rules O1–O6, M1) in the caller's READ COMMITTED transaction, after the caller took
 * the switches lock shared and checked the purchase stop (rule O2): replays the same key and
 * body, locks the product `FOR SHARE` (repricing takes it `FOR UPDATE`, so the price read is the
 * one in force), checks availability for this customer, the price, the quantity and the fields,
 * then posts the purchase journal (which locks the wallet and refuses `INSUFFICIENT_BALANCE`),
 * inserts the `paid` order, its event, the audit entry and the `orders.fulfil` job. Any refusal
 * throws, and the caller's transaction rolls everything back.
 */
export async function purchaseOrder(
  tx: Transaction,
  context: Pick<OrderContext, 'jobs' | 'now'>,
  input: PurchaseInput,
): Promise<{ order: OrderRow; created: boolean }> {
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
    return { order: existing, created: false };
  }

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

  // Routes of a supplier this build cannot use stay out (rule SP1), as in the price itself.
  const usable = (
    await productRoutingStates(tx, [product.id], {
      now: context.now,
      fakeEnabled: input.fakeEnabled,
    })
  ).get(product.id);
  if (!usable) throw new OrderError('NOT_FOUND', 'No such product');
  const current = usable.current;
  const availability =
    usable.availability === 'hidden' || usable.availability === 'paused'
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
          usable.routes
            .filter((route) => route.unusableReason === null)
            .map((route) => ({
              supplierCode: route.supplierCode,
              costUsdUnits: route.costUsdUnits as number,
            })),
          customer.isTest,
        );
  if (availability !== 'available' || !current) {
    throw new OrderError('PRODUCT_UNAVAILABLE', 'The product cannot be bought now', {
      availability,
    });
  }
  if (current.priceUsdUnits !== input.expectedUnitPriceUsdUnits) {
    throw new OrderError('PRICE_CHANGED', 'The price is not the one expected', {
      unitPriceUsdUnits: current.priceUsdUnits,
    });
  }
  if (input.quantity > product.maxQuantity) {
    throw new OrderError('VALIDATION_FAILED', 'Quantity above the product maximum', {
      fields: { quantity: 'too_big' },
    });
  }
  const fieldRules = await tx
    .select()
    .from(catalogInputFields)
    .where(
      and(eq(catalogInputFields.gameId, product.gameId), isNull(catalogInputFields.archivedAt)),
    )
    .orderBy(asc(catalogInputFields.sortOrder));
  const parsed = orderFieldValuesSchema(fieldRules).safeParse(input.fields);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      if (issue.code === 'unrecognized_keys') {
        for (const key of issue.keys) fields[key] = 'unknown';
      } else {
        fields[String(issue.path[0])] ??= issue.code;
      }
    }
    throw new OrderError('VALIDATION_FAILED', 'The account fields are not valid', { fields });
  }

  const orderId = newId();
  const total = orderTotal(current.priceUsdUnits, input.quantity);
  const [rate] = await tx
    .select()
    .from(exchangeRates)
    .orderBy(desc(exchangeRates.createdAt), desc(exchangeRates.id))
    .limit(1);
  const wallet = await ensureCustomerWallet(tx, input.customerId);
  const revenue = await ensureSystemAccount(tx, {
    code: 'sales_revenue:USD',
    kind: 'sales_revenue',
    currency: 'USD',
  });
  const journal = await postJournal(tx, {
    idempotencyKey: `order:${orderId}:purchase`,
    kind: 'purchase',
    postings: [
      { accountId: wallet, amountUnits: -total },
      { accountId: revenue, amountUnits: total },
    ],
  });

  let order: OrderRow | undefined;
  for (let attempt = 1; !order; attempt += 1) {
    try {
      order = await tx.transaction(async (step) => {
        const [row] = await step
          .insert(orders)
          .values({
            id: orderId,
            number: orderNumber(),
            customerId: input.customerId,
            isTest: customer.isTest,
            productId: product.id,
            gameId: product.gameId,
            kind: product.kind,
            status: 'paid',
            quantity: input.quantity,
            unitPriceUsdUnits: current.priceUsdUnits,
            totalUsdUnits: total,
            priceId: current.id,
            minMarginUsdUnits: current.minMarginUsdUnits,
            fields: parsed.data,
            displayRateId: rate?.id ?? null,
            totalSypUnits: rate
              ? sypDisplayPrice(total, rateFromNumeric(rate.sypPerUsd), rate.displayStepSypUnits)
              : null,
            idempotencyKey: input.idempotencyKey,
            requestHash: input.requestHash,
            purchaseJournalId: journal.journalId,
            paidAt: sql`now()`,
          })
          .returning();
        return row as OrderRow;
      });
    } catch (error) {
      if (!uniqueViolation(error, 'orders_number_unique') || attempt >= NUMBER_ATTEMPTS)
        throw error;
    }
  }

  await addOrderEvent(
    tx,
    order.id,
    'status',
    { actor: 'customer', actorId: input.customerId },
    { from: null, to: 'paid' },
  );
  await recordAudit(tx, {
    action: 'order.paid',
    actorKind: input.channel === 'cli' ? 'cli' : 'customer',
    actorId: input.channel === 'cli' ? null : input.customerId,
    channel: input.channel,
    entityType: 'order',
    entityId: order.id,
    details: {
      number: order.number,
      productId: product.id,
      quantity: input.quantity,
      totalUsdUnits: total,
      journalId: journal.journalId,
    },
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  });
  await queueFulfil(tx, context.jobs, order.id);
  return { order, created: true };
}
