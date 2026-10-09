import {
  SUPPLIER_CALL_OPERATIONS,
  SUPPLIER_CALL_RESULTS,
  SUPPLIER_CODES,
  SUPPLIER_HEALTH_STATES,
  SYNC_RUN_STATUSES,
  SYNC_RUN_TRIGGERS,
  WEBHOOK_EVENT_RESULTS,
} from '@vertex-digital/contracts';
import { isNull, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { catalogProducts, productKindEnum } from './catalog.js';
import { amountUnits, archivedAt, bytea, currencyEnum, id, timestamps } from './columns.js';
import { fulfilmentAttempts } from './orders.js';

/*
 * Suppliers, their offers and the routes that map products to offers (S07, F09; ADR 0005, 0021),
 * owned by the api `suppliers` module. Append-only tables (credentials, cost changes, calls,
 * health changes, balance reads, policy) are guarded by migration 0027 and stamped with the time
 * of the insert, so the newest row is the latest written even when its transaction began earlier.
 * Seeds (the four suppliers, the policy): 0027.
 */

export const supplierCodeEnum = pgEnum('supplier_code', SUPPLIER_CODES);

export const supplierHealthStateEnum = pgEnum('supplier_health_state', SUPPLIER_HEALTH_STATES);

export const supplierCallOperationEnum = pgEnum(
  'supplier_call_operation',
  SUPPLIER_CALL_OPERATIONS,
);

export const supplierCallResultEnum = pgEnum('supplier_call_result', SUPPLIER_CALL_RESULTS);

export const syncRunTriggerEnum = pgEnum('sync_run_trigger', SYNC_RUN_TRIGGERS);

export const syncRunStatusEnum = pgEnum('sync_run_status', SYNC_RUN_STATUSES);

export const webhookEventResultEnum = pgEnum('webhook_event_result', WEBHOOK_EVENT_RESULTS);

/** The time of the insert, not of its transaction's start. */
const insertedAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().default(sql`clock_timestamp()`);

/** One row per supplier, seeded; never archived. Base URLs live in the adapters (ADR 0021). */
export const suppliers = pgTable(
  'suppliers',
  {
    id: id(),
    code: supplierCodeEnum('code').notNull().unique(),
    nameAr: text('name_ar').notNull(),
    /** A07: whole cents, $0–$100,000; ignored for `manual`. */
    lowBalanceUsdUnits: amountUnits('low_balance_usd_units').notNull().default(50_000_000),
    /** S09 rule PV5: player checks a Damascus day; 0 turns them off for this supplier. */
    validationDailyQuota: integer('validation_daily_quota').notNull().default(1_000),
    ...timestamps(),
  },
  (table) => [
    check('suppliers_name_ar_check', sql`char_length(${table.nameAr}) between 1 and 40`),
    check(
      'suppliers_low_balance_check',
      sql`${table.lowBalanceUsdUnits} between 0 and 100000000000 and ${table.lowBalanceUsdUnits} % 10000 = 0`,
    ),
    check(
      'suppliers_validation_daily_quota_check',
      sql`${table.validationDailyQuota} between 0 and 1000000`,
    ),
  ],
);

/**
 * Rule SP2: AES-256-GCM of the credential fields (`supplierCredentials` in `src/suppliers`), the
 * supplier id as associated data. The newest row per supplier is in force. Append-only.
 */
export const supplierCredentials = pgTable(
  'supplier_credentials',
  {
    id: id(),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id),
    ciphertext: bytea('ciphertext').notNull(),
    /** Per field, its last 4 characters, for the masked display. */
    hints: jsonb('hints').$type<Record<string, string>>().notNull(),
    /** The admin who set them; no foreign key, as `store_switch_changes.admin_id`. */
    adminId: uuid('admin_id').notNull(),
    createdAt: insertedAt(),
  },
  (table) => [
    index('supplier_credentials_supplier_id_created_at_idx').on(
      table.supplierId,
      table.createdAt.desc(),
    ),
  ],
);

/** A mirror of each supplier's catalog (rules SY2–SY4); manual offers are the admin's (RT7). */
export const supplierOffers = pgTable(
  'supplier_offers',
  {
    id: id(),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id),
    /** The supplier's own id; for `manual`, a UUID the API generates. */
    offerId: text('offer_id').notNull(),
    name: text('name').notNull(),
    groupName: text('group_name'),
    kind: productKindEnum('kind'),
    requiredFields: text('required_fields').array(),
    /** Null: no usable USD cost; the raw value is kept in `cost_raw` (edge case 6). */
    costUsdUnits: amountUnits('cost_usd_units'),
    costRaw: text('cost_raw'),
    inStock: boolean('in_stock').notNull(),
    costConfirmedAt: timestamp('cost_confirmed_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    missingSince: timestamp('missing_since', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('supplier_offers_supplier_id_offer_id_idx').on(table.supplierId, table.offerId),
    index('supplier_offers_supplier_id_group_name_idx').on(table.supplierId, table.groupName),
    index('supplier_offers_supplier_id_missing_since_idx').on(table.supplierId, table.missingSince),
    check('supplier_offers_offer_id_check', sql`char_length(${table.offerId}) between 1 and 128`),
    check('supplier_offers_name_check', sql`char_length(${table.name}) between 1 and 200`),
    check(
      'supplier_offers_group_name_check',
      sql`char_length(${table.groupName}) between 1 and 200`,
    ),
    check('supplier_offers_cost_raw_check', sql`char_length(${table.costRaw}) <= 64`),
    check('supplier_offers_cost_check', sql`${table.costUsdUnits} between 1 and 10000000000`),
  ],
);

/** One run of `suppliers.sync`; updated only from `running` to its end (rule SY1). */
export const supplierSyncRuns = pgTable(
  'supplier_sync_runs',
  {
    id: id(),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id),
    trigger: syncRunTriggerEnum('trigger').notNull(),
    status: syncRunStatusEnum('status').notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    offersSeen: integer('offers_seen').notNull().default(0),
    offersNew: integer('offers_new').notNull().default(0),
    costsChanged: integer('costs_changed').notNull().default(0),
    offersMissing: integer('offers_missing').notNull().default(0),
    reviewsOpened: integer('reviews_opened').notNull().default(0),
    productsRepriced: integer('products_repriced').notNull().default(0),
    /** Sanitized: never credentials, URLs with keys or raw bodies. */
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    ...timestamps(),
  },
  (table) => [
    /** One running run per supplier (rule SY1). */
    uniqueIndex('supplier_sync_runs_running_idx')
      .on(table.supplierId)
      .where(sql`${table.status} = 'running'`),
    index('supplier_sync_runs_supplier_id_started_at_idx').on(
      table.supplierId,
      table.startedAt.desc(),
    ),
    check(
      'supplier_sync_runs_finished_check',
      sql`(${table.status} = 'running') = (${table.finishedAt} is null)`,
    ),
    check('supplier_sync_runs_error_code_check', sql`char_length(${table.errorCode}) <= 64`),
    check('supplier_sync_runs_error_message_check', sql`char_length(${table.errorMessage}) <= 500`),
  ],
);

/** Every change of an offer's cost (rules SY4, RT7). Append-only. */
export const supplierCostChanges = pgTable(
  'supplier_cost_changes',
  {
    id: id(),
    offerId: uuid('offer_id')
      .notNull()
      .references(() => supplierOffers.id),
    fromUsdUnits: amountUnits('from_usd_units'),
    toUsdUnits: amountUnits('to_usd_units'),
    /** Null for a manual cost set by the admin. */
    syncRunId: uuid('sync_run_id').references(() => supplierSyncRuns.id),
    adminId: uuid('admin_id'),
    createdAt: insertedAt(),
  },
  (table) => [
    index('supplier_cost_changes_offer_id_created_at_idx').on(
      table.offerId,
      table.createdAt.desc(),
    ),
    index('supplier_cost_changes_sync_run_id_idx').on(table.syncRunId),
  ],
);

/** Every adapter call, from the API and the worker; health is computed from them (H1). */
export const supplierCalls = pgTable(
  'supplier_calls',
  {
    id: id(),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id),
    operation: supplierCallOperationEnum('operation').notNull(),
    result: supplierCallResultEnum('result').notNull(),
    latencyMs: integer('latency_ms').notNull(),
    /** The supplier's error code, never a message with player data. */
    supplierCode: text('supplier_code'),
    createdAt: insertedAt(),
  },
  (table) => [
    index('supplier_calls_supplier_id_created_at_idx').on(table.supplierId, table.createdAt.desc()),
    /** S09 rule PV5: today's player checks per supplier. */
    index('supplier_calls_supplier_id_operation_created_at_idx').on(
      table.supplierId,
      table.operation,
      table.createdAt.desc(),
    ),
    check('supplier_calls_latency_check', sql`${table.latencyMs} >= 0`),
    check('supplier_calls_supplier_code_check', sql`char_length(${table.supplierCode}) <= 64`),
  ],
);

/** The newest row per supplier is its state; no row: `healthy` (rule H4). */
export const supplierHealthChanges = pgTable(
  'supplier_health_changes',
  {
    id: id(),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id),
    state: supplierHealthStateEnum('state').notNull(),
    reason: text('reason').notNull(),
    calls: integer('calls'),
    successBp: integer('success_bp'),
    p90Ms: integer('p90_ms'),
    createdAt: insertedAt(),
  },
  (table) => [
    index('supplier_health_changes_supplier_id_created_at_idx').on(
      table.supplierId,
      table.createdAt.desc(),
    ),
    check(
      'supplier_health_changes_reason_check',
      sql`char_length(${table.reason}) between 1 and 200`,
    ),
  ],
);

/** Balances as each supplier reports them (rule H5); may be negative on credit. */
export const supplierBalanceReads = pgTable(
  'supplier_balance_reads',
  {
    id: id(),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id),
    currency: currencyEnum('currency').notNull(),
    amountUnits: amountUnits('amount_units').notNull(),
    createdAt: insertedAt(),
  },
  (table) => [
    index('supplier_balance_reads_supplier_id_created_at_idx').on(
      table.supplierId,
      table.createdAt.desc(),
    ),
  ],
);

/** The supplier policy (ADR 0021): the newest row is in force; seeded with the defaults. */
export const supplierPolicy = pgTable(
  'supplier_policy',
  {
    id: id(),
    priceReviewThresholdBp: integer('price_review_threshold_bp').notNull(),
    costStaleMinutes: integer('cost_stale_minutes').notNull(),
    healthWindowMinutes: integer('health_window_minutes').notNull(),
    healthMinCalls: integer('health_min_calls').notNull(),
    degradedSuccessBp: integer('degraded_success_bp').notNull(),
    degradedP90Ms: integer('degraded_p90_ms').notNull(),
    downSuccessBp: integer('down_success_bp').notNull(),
    downConsecutiveErrors: integer('down_consecutive_errors').notNull(),
    probeAfterMinutes: integer('probe_after_minutes').notNull(),
    /** Null for the seed. */
    adminId: uuid('admin_id'),
    createdAt: insertedAt(),
  },
  (table) => [
    index('supplier_policy_created_at_idx').on(table.createdAt.desc()),
    check(
      'supplier_policy_bounds_check',
      sql`${table.priceReviewThresholdBp} between 100 and 5000
        and ${table.costStaleMinutes} between 30 and 1440
        and ${table.healthWindowMinutes} between 5 and 240
        and ${table.healthMinCalls} between 1 and 100
        and ${table.degradedSuccessBp} between 1 and 10000
        and ${table.degradedP90Ms} between 1000 and 120000
        and ${table.downSuccessBp} between 0 and 9999
        and ${table.downSuccessBp} < ${table.degradedSuccessBp}
        and ${table.downConsecutiveErrors} between 1 and 20
        and ${table.probeAfterMinutes} between 1 and 120`,
    ),
  ],
);

/**
 * A product's route to one supplier offer (rules RT1–RT3). One unarchived route per supplier per
 * product, and an offer serves one product.
 */
export const productRoutes = pgTable(
  'product_routes',
  {
    id: id(),
    productId: uuid('product_id')
      .notNull()
      .references(() => catalogProducts.id),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id),
    offerId: uuid('offer_id')
      .notNull()
      .references(() => supplierOffers.id),
    priority: integer('priority').notNull().default(1),
    enabled: boolean('enabled').notNull().default(true),
    /** Supplier field name → input field key of the product's game. */
    fieldMap: jsonb('field_map').$type<Record<string, string>>().notNull().default({}),
    ...timestamps(),
    archivedAt: archivedAt(),
  },
  (table) => [
    uniqueIndex('product_routes_product_id_supplier_id_live_idx')
      .on(table.productId, table.supplierId)
      .where(isNull(table.archivedAt)),
    uniqueIndex('product_routes_offer_id_live_idx')
      .on(table.offerId)
      .where(isNull(table.archivedAt)),
    index('product_routes_offer_id_idx').on(table.offerId),
    index('product_routes_supplier_id_idx').on(table.supplierId),
    check('product_routes_priority_check', sql`${table.priority} between 1 and 9`),
    check('product_routes_field_map_check', sql`jsonb_typeof(${table.fieldMap}) = 'object'`),
  ],
);

/**
 * Every verified supplier webhook, stored once per event id (S08 rule F4, ADR 0005). The body is
 * encrypted with `ORDER_CODES_SECRET` (it may carry codes). Only the processing columns change,
 * once (migration 0031).
 */
export const supplierWebhookEvents = pgTable(
  'supplier_webhook_events',
  {
    id: id(),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id),
    eventId: text('event_id').notNull(),
    bodyCiphertext: bytea('body_ciphertext').notNull(),
    /** Set when processed: the attempt the event named, if any (rule F5). */
    attemptId: uuid('attempt_id').references(() => fulfilmentAttempts.id),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    result: webhookEventResultEnum('result'),
    createdAt: insertedAt(),
  },
  (table) => [
    uniqueIndex('supplier_webhook_events_supplier_id_event_id_idx').on(
      table.supplierId,
      table.eventId,
    ),
    index('supplier_webhook_events_attempt_id_idx').on(table.attemptId),
    check(
      'supplier_webhook_events_event_id_check',
      sql`char_length(${table.eventId}) between 1 and 128`,
    ),
    check(
      'supplier_webhook_events_processed_check',
      sql`(${table.processedAt} is null) = (${table.result} is null)`,
    ),
  ],
);
