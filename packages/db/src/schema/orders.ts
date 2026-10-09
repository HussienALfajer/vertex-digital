import {
  ATTEMPT_RESOLVERS,
  ATTEMPT_STATUSES,
  CODE_REVEAL_ACTORS,
  ORDER_EVENT_ACTORS,
  ORDER_EVENT_KINDS,
  ORDER_STATUSES,
  REFUND_REASONS,
  type RouteCandidate,
} from '@vertex-digital/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  inet,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { customers } from './auth.js';
import { catalogGames, catalogProducts, productKindEnum } from './catalog.js';
import { amountUnits, bytea, id, timestamps } from './columns.js';
import { productPrices } from './pricing.js';
import { exchangeRates } from './rates.js';
import { productRoutes, supplierOffers, suppliers } from './suppliers.js';
import { ledgerJournals } from './wallet.js';

/*
 * Orders and their fulfilment (S08, F11; ADR 0004, 0005, 0013), owned by the api `orders` module.
 * Every write goes through `packages/db/src/orders`, shared by the API and the worker. Guards
 * (no delete, terminal orders and closed attempts fixed, append-only events, codes, reveals and
 * policy) and the policy seed: migration 0031.
 */

export const orderStatusEnum = pgEnum('order_status', ORDER_STATUSES);

export const attemptStatusEnum = pgEnum('attempt_status', ATTEMPT_STATUSES);

export const attemptResolverEnum = pgEnum('attempt_resolver', ATTEMPT_RESOLVERS);

export const orderEventKindEnum = pgEnum('order_event_kind', ORDER_EVENT_KINDS);

export const orderEventActorEnum = pgEnum('order_event_actor', ORDER_EVENT_ACTORS);

export const refundReasonEnum = pgEnum('refund_reason', REFUND_REASONS);

export const codeRevealActorEnum = pgEnum('code_reveal_actor', CODE_REVEAL_ACTORS);

/** The time of the insert, not of its transaction's start. */
const insertedAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`);

/**
 * One purchase (rules O1–O6). Never deleted or archived: it ends in a terminal status. The money
 * columns keep `refunded = unit price × refunded units` and `delivered + refunded ≤ quantity`.
 */
export const orders = pgTable(
  'orders',
  {
    id: id(),
    number: text('number').notNull().unique(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    /** The customer's test flag at purchase (rule R4). */
    isTest: boolean('is_test').notNull(),
    productId: uuid('product_id')
      .notNull()
      .references(() => catalogProducts.id),
    gameId: uuid('game_id')
      .notNull()
      .references(() => catalogGames.id),
    kind: productKindEnum('kind').notNull(),
    status: orderStatusEnum('status').notNull(),
    quantity: integer('quantity').notNull(),
    unitPriceUsdUnits: amountUnits('unit_price_usd_units').notNull(),
    totalUsdUnits: amountUnits('total_usd_units').notNull(),
    /** The price row charged, and its rule's minimum margin: the guard of every attempt. */
    priceId: uuid('price_id')
      .notNull()
      .references(() => productPrices.id),
    minMarginUsdUnits: amountUnits('min_margin_usd_units').notNull(),
    /** Input field key → value, trimmed (rule O5). */
    fields: jsonb('fields').$type<Record<string, string>>().notNull(),
    /** The pounds shown at purchase (rule O6): display only, no SYP moves. */
    displayRateId: uuid('display_rate_id').references(() => exchangeRates.id),
    totalSypUnits: amountUnits('total_syp_units'),
    deliveredQuantity: integer('delivered_quantity').notNull().default(0),
    refundedQuantity: integer('refunded_quantity').notNull().default(0),
    refundedUsdUnits: amountUnits('refunded_usd_units').notNull().default(0),
    refundReason: refundReasonEnum('refund_reason'),
    /** The customer's `Idempotency-Key` and the SHA-256 of the canonical body (rule O1). */
    idempotencyKey: uuid('idempotency_key').notNull().unique(),
    requestHash: text('request_hash').notNull(),
    purchaseJournalId: uuid('purchase_journal_id')
      .notNull()
      .unique()
      .references(() => ledgerJournals.id),
    refundJournalId: uuid('refund_journal_id')
      .unique()
      .references(() => ledgerJournals.id),
    /** The admin's `Idempotency-Key` of a refund decision (rule D5). */
    refundIdempotencyKey: uuid('refund_idempotency_key').unique(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    reviewSince: timestamp('review_since', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    index('orders_customer_id_created_at_idx').on(table.customerId, table.createdAt.desc()),
    index('orders_status_created_at_idx').on(table.status, table.createdAt),
    index('orders_created_at_idx').on(table.createdAt.desc()),
    index('orders_product_id_idx').on(table.productId),
    index('orders_game_id_idx').on(table.gameId),
    index('orders_price_id_idx').on(table.priceId),
    index('orders_display_rate_id_idx').on(table.displayRateId),
    /** Delivery time (rule T1). */
    index('orders_delivery_stats_idx')
      .on(table.productId, table.deliveredAt.desc())
      .where(sql`${table.status} = 'delivered' and not ${table.isTest}`),
    check('orders_number_check', sql`${table.number} ~ '^VO-[2-9A-HJKMNP-Z]{6}$'`),
    check('orders_quantity_check', sql`${table.quantity} between 1 and 50`),
    check(
      'orders_unit_price_check',
      sql`${table.unitPriceUsdUnits} > 0 and ${table.unitPriceUsdUnits} % 10000 = 0`,
    ),
    check(
      'orders_total_check',
      sql`${table.totalUsdUnits} = ${table.unitPriceUsdUnits} * ${table.quantity}`,
    ),
    check('orders_min_margin_check', sql`${table.minMarginUsdUnits} >= 0`),
    check('orders_fields_check', sql`jsonb_typeof(${table.fields}) = 'object'`),
    check(
      'orders_syp_check',
      sql`(${table.displayRateId} is null) = (${table.totalSypUnits} is null) and ${table.totalSypUnits} >= 0`,
    ),
    check(
      'orders_quantities_check',
      sql`${table.deliveredQuantity} >= 0 and ${table.refundedQuantity} >= 0
        and ${table.deliveredQuantity} + ${table.refundedQuantity} <= ${table.quantity}`,
    ),
    check(
      'orders_refunded_check',
      sql`${table.refundedUsdUnits} = ${table.unitPriceUsdUnits} * ${table.refundedQuantity}
        and (${table.refundedQuantity} = 0) = (${table.refundJournalId} is null)
        and (${table.refundedQuantity} = 0) = (${table.refundReason} is null)`,
    ),
    check(
      'orders_terminal_check',
      sql`(${table.status} <> 'delivered' or ${table.deliveredQuantity} = ${table.quantity})
        and (${table.status} <> 'partially_refunded' or (${table.deliveredQuantity} > 0
          and ${table.refundedQuantity} > 0
          and ${table.deliveredQuantity} + ${table.refundedQuantity} = ${table.quantity}))
        and (${table.status} <> 'refunded' or (${table.deliveredQuantity} = 0
          and ${table.refundedQuantity} = ${table.quantity}))
        and (${table.status} in ('delivered', 'partially_refunded', 'refunded', 'cancelled'))
          = (${table.finishedAt} is not null)
        and (${table.status} = 'delivered') = (${table.deliveredAt} is not null)
        and (${table.status} = 'needs_review') = (${table.reviewSince} is not null)`,
    ),
    check('orders_request_hash_check', sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

/** Every status change, attempt change and note of an order (rule AU1). Append-only. */
export const orderEvents = pgTable(
  'order_events',
  {
    id: id(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    kind: orderEventKindEnum('kind').notNull(),
    fromStatus: orderStatusEnum('from_status'),
    toStatus: orderStatusEnum('to_status'),
    actor: orderEventActorEnum('actor').notNull(),
    /** The customer or the admin; no foreign key (the admin row is replaceable). */
    actorId: uuid('actor_id'),
    attemptId: uuid('attempt_id').references(() => fulfilmentAttempts.id),
    /** A code such as `no_route`, `hard_limit`, `input_rejected`. */
    reason: text('reason'),
    /** Never codes or field values. */
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: insertedAt(),
  },
  (table) => [
    index('order_events_order_id_created_at_idx').on(table.orderId, table.createdAt),
    index('order_events_attempt_id_idx').on(table.attemptId),
    check('order_events_reason_check', sql`char_length(${table.reason}) between 1 and 64`),
    check(
      'order_events_status_check',
      sql`(${table.kind} = 'status') = (${table.toStatus} is not null)`,
    ),
  ],
);

/**
 * One supplier call for an order's remaining units (rules R3, F1). Its id is the idempotency key
 * sent to the supplier (ADR 0004). A route is tried once per order; one attempt is open at a time.
 */
export const fulfilmentAttempts = pgTable(
  'fulfilment_attempts',
  {
    id: id(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    routeId: uuid('route_id')
      .notNull()
      .references(() => productRoutes.id),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id),
    offerId: uuid('offer_id')
      .notNull()
      .references(() => supplierOffers.id),
    /** The supplier's own offer id, as sent. */
    supplierOfferId: text('supplier_offer_id').notNull(),
    quantity: integer('quantity').notNull(),
    unitCostUsdUnits: amountUnits('unit_cost_usd_units').notNull(),
    status: attemptStatusEnum('status').notNull(),
    deliveredQuantity: integer('delivered_quantity').notNull().default(0),
    supplierOrderId: text('supplier_order_id'),
    /** Sanitized: never field values, codes or credentials. */
    failureReason: text('failure_reason'),
    inputRejected: boolean('input_rejected').notNull().default(false),
    /** The supplier's own error code. */
    supplierErrorCode: text('supplier_error_code'),
    /** Every route the router saw, with its rank or skip reason (ADR 0005). */
    candidates: jsonb('candidates').$type<RouteCandidate[]>().notNull(),
    /** The classified outcome, without codes. */
    result: jsonb('result').$type<Record<string, unknown>>(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    pollCount: integer('poll_count').notNull().default(0),
    nextPollAt: timestamp('next_poll_at', { withTimezone: true }),
    /** A manual attempt's reminder was sent (rule MN2). */
    remindedAt: timestamp('reminded_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: attemptResolverEnum('resolved_by'),
    adminReason: text('admin_reason'),
    /** The admin's `Idempotency-Key` of a resolution (rule D1). */
    decisionIdempotencyKey: uuid('decision_idempotency_key').unique(),
    costJournalId: uuid('cost_journal_id')
      .unique()
      .references(() => ledgerJournals.id),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('fulfilment_attempts_order_id_route_id_idx').on(table.orderId, table.routeId),
    /** One open attempt per order (rule R3). */
    uniqueIndex('fulfilment_attempts_open_idx')
      .on(table.orderId)
      .where(sql`${table.status} in ('sending', 'pending', 'unknown')`),
    index('fulfilment_attempts_status_next_poll_at_idx').on(table.status, table.nextPollAt),
    index('fulfilment_attempts_route_id_idx').on(table.routeId),
    index('fulfilment_attempts_supplier_id_idx').on(table.supplierId),
    index('fulfilment_attempts_offer_id_idx').on(table.offerId),
    check('fulfilment_attempts_quantity_check', sql`${table.quantity} between 1 and 50`),
    check(
      'fulfilment_attempts_delivered_check',
      sql`${table.deliveredQuantity} between 0 and ${table.quantity}
        and (${table.status} = 'delivered') = (${table.deliveredQuantity} > 0)`,
    ),
    check('fulfilment_attempts_unit_cost_check', sql`${table.unitCostUsdUnits} > 0`),
    check(
      'fulfilment_attempts_resolved_check',
      sql`(${table.status} in ('delivered', 'failed')) = (${table.resolvedAt} is not null)
        and (${table.resolvedAt} is null) = (${table.resolvedBy} is null)
        and (${table.status} = 'delivered') = (${table.costJournalId} is not null)
        and (not ${table.inputRejected} or ${table.status} = 'failed')
        and (${table.resolvedBy} = 'admin') = (${table.adminReason} is not null)`,
    ),
    check(
      'fulfilment_attempts_text_check',
      sql`char_length(${table.supplierOfferId}) between 1 and 128
        and char_length(${table.supplierOrderId}) between 1 and 128
        and char_length(${table.failureReason}) between 1 and 200
        and char_length(${table.supplierErrorCode}) between 1 and 64
        and char_length(${table.adminReason}) between 5 and 500`,
    ),
    check('fulfilment_attempts_poll_count_check', sql`${table.pollCount} >= 0`),
  ],
);

/**
 * One code per delivered unit (rule C1): AES-256-GCM with `ORDER_CODES_SECRET`, the row id as
 * associated data. Append-only.
 */
export const orderCodes = pgTable(
  'order_codes',
  {
    id: id(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    attemptId: uuid('attempt_id')
      .notNull()
      .references(() => fulfilmentAttempts.id),
    position: integer('position').notNull(),
    /** AES-256-GCM (`src/orders/codes.ts`). */
    ciphertext: bytea('ciphertext').notNull(),
    /** The last 4 characters of a code of 12 characters or more (rule C3). */
    hint: text('hint'),
    createdAt: insertedAt(),
  },
  (table) => [
    uniqueIndex('order_codes_attempt_id_position_idx').on(table.attemptId, table.position),
    index('order_codes_order_id_idx').on(table.orderId),
    check('order_codes_position_check', sql`${table.position} between 1 and 50`),
    check('order_codes_hint_check', sql`char_length(${table.hint}) = 4`),
  ],
);

/** Every reveal of a code, by the buyer or the admin (rules C2, C3). Append-only. */
export const orderCodeReveals = pgTable(
  'order_code_reveals',
  {
    id: id(),
    codeId: uuid('code_id')
      .notNull()
      .references(() => orderCodes.id),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    actor: codeRevealActorEnum('actor').notNull(),
    actorId: uuid('actor_id').notNull(),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    createdAt: insertedAt(),
  },
  (table) => [
    index('order_code_reveals_code_id_created_at_idx').on(table.codeId, table.createdAt),
    index('order_code_reveals_order_id_idx').on(table.orderId),
    check('order_code_reveals_user_agent_check', sql`char_length(${table.userAgent}) <= 300`),
  ],
);

/** The order policy (owner, 2026-10-09): the newest row is in force; seeded with the defaults. */
export const orderPolicy = pgTable(
  'order_policy',
  {
    id: id(),
    firstPollSeconds: integer('first_poll_seconds').notNull(),
    fastPollSeconds: integer('fast_poll_seconds').notNull(),
    fastPollMinutes: integer('fast_poll_minutes').notNull(),
    slowPollSeconds: integer('slow_poll_seconds').notNull(),
    hardLimitMinutes: integer('hard_limit_minutes').notNull(),
    reviewPollMinutes: integer('review_poll_minutes').notNull(),
    reviewPollHours: integer('review_poll_hours').notNull(),
    manualReminderMinutes: integer('manual_reminder_minutes').notNull(),
    /** Null for the seed. */
    adminId: uuid('admin_id'),
    createdAt: insertedAt(),
  },
  (table) => [
    index('order_policy_created_at_idx').on(table.createdAt.desc()),
    check(
      'order_policy_bounds_check',
      sql`${table.firstPollSeconds} between 15 and 600
        and ${table.fastPollSeconds} between 15 and 600
        and ${table.fastPollMinutes} between 1 and 60
        and ${table.slowPollSeconds} between 60 and 3600
        and ${table.hardLimitMinutes} between 5 and 240
        and ${table.reviewPollMinutes} between 5 and 240
        and ${table.reviewPollHours} between 1 and 72
        and ${table.manualReminderMinutes} between 5 and 240`,
    ),
  ],
);
