import { z } from 'zod';
import { productAvailabilitySchema, productKindSchema } from './catalog.js';
import { pagedListSchema, pageQuerySchema } from './lists.js';
import { CURRENCY_SCALE, currencySchema, USD_CENT, usdCentsSchema } from './money.js';

/*
 * Suppliers, their offers and the routes that map store products to offers (S07, F09; ADR 0005,
 * 0021), owned by the api `suppliers` module. Costs are USD units; the price math is in
 * `pricing.ts`. Supplier text (offer names, groups) is shown as received, as text only.
 */

export const SUPPLIER_CODES = ['shop2topup', 'wdgzone', 'manual', 'fake'] as const;

export const supplierCodeSchema = z.enum(SUPPLIER_CODES).meta({ id: 'SupplierCode' });

export type SupplierCode = z.infer<typeof supplierCodeSchema>;

export const SUPPLIER_HEALTH_STATES = ['healthy', 'degraded', 'down'] as const;

export const supplierHealthStateSchema = z
  .enum(SUPPLIER_HEALTH_STATES)
  .meta({ id: 'SupplierHealthState' });

export type SupplierHealthState = z.infer<typeof supplierHealthStateSchema>;

/** The adapter calls recorded in `supplier_calls`, which health is computed from (rule H1). */
export const SUPPLIER_CALL_OPERATIONS = [
  'list_offers',
  'get_balance',
  'validate_player',
  'place_order',
  'get_order',
] as const;

/**
 * `ok`: answered; `refused`: a definitive refusal (the supplier is working); `error`: no
 * trustworthy answer (timeout, connection, 5xx, unreadable reply, an `unknown` order outcome).
 */
export const SUPPLIER_CALL_RESULTS = ['ok', 'refused', 'error'] as const;

export type SupplierCallOperation = (typeof SUPPLIER_CALL_OPERATIONS)[number];

export type SupplierCallResult = (typeof SUPPLIER_CALL_RESULTS)[number];

/**
 * The secret fields the panel asks for, per supplier (rule SP2). Provisional for `shop2topup` and
 * `wdgzone`: their adapter PRs may rename them (Q12).
 */
export const SUPPLIER_CREDENTIAL_FIELDS: Record<SupplierCode, readonly string[]> = {
  shop2topup: ['apiKey', 'webhookSecret'],
  wdgzone: ['apiKey', 'webhookSecret'],
  manual: [],
  fake: ['webhookSecret'],
};

/**
 * Suppliers whose adapter this build has (rule SP1). `manual` needs none; `fake` counts only where
 * `SUPPLIER_FAKE_ENABLED=true`. Each real adapter's PR adds its code here.
 */
const ADAPTERS_READY: readonly SupplierCode[] = ['manual', 'fake'];

/** Rule SP1: the running app has this supplier's adapter. */
export function supplierAvailable(code: SupplierCode, options: { fakeEnabled: boolean }): boolean {
  if (code === 'fake' && !options.fakeEnabled) return false;
  return ADAPTERS_READY.includes(code);
}

/** Suppliers that list offers (rule SY1); `manual` offers are the admin's. */
export function supplierHasCatalog(code: SupplierCode): boolean {
  return code !== 'manual';
}

export const SYNC_RUN_TRIGGERS = ['schedule', 'admin'] as const;

export const syncRunTriggerSchema = z.enum(SYNC_RUN_TRIGGERS).meta({ id: 'SyncRunTrigger' });

export const SYNC_RUN_STATUSES = ['running', 'succeeded', 'failed'] as const;

export const syncRunStatusSchema = z.enum(SYNC_RUN_STATUSES).meta({ id: 'SyncRunStatus' });

/** Every cost is above zero and at most $10,000. */
export const SUPPLIER_COST_MAX_USD_UNITS = 10_000 * CURRENCY_SCALE.USD;

/** A supplier's low-balance threshold (A07): whole cents, $0–$100,000, $50 by default. */
export const LOW_BALANCE_MAX_USD_UNITS = 100_000 * CURRENCY_SCALE.USD;
export const LOW_BALANCE_DEFAULT_USD_UNITS = 50 * CURRENCY_SCALE.USD;

/** "Sync now" at most once a minute per supplier (S07 "Access"). */
export const SYNC_REQUEST_INTERVAL_SECONDS = 60;

/** An import takes 1–100 offers (rule RT8); a field map at most 10 entries. */
export const MAX_IMPORT_ROWS = 100;
export const MAX_FIELD_MAP_ENTRIES = 10;

/** A route's priority: 1–9, a tie-break only (rule RT6). */
export const ROUTE_PRIORITY_MAX = 9;

// Policy ----------------------------------------------------------------------------------------

/** The supplier policy (ADR 0021): the newest `supplier_policy` row is in force. */
export const supplierPolicySchema = z
  .object({
    priceReviewThresholdBp: z.int().min(100).max(5_000),
    costStaleMinutes: z.int().min(30).max(1_440),
    healthWindowMinutes: z.int().min(5).max(240),
    healthMinCalls: z.int().min(1).max(100),
    degradedSuccessBp: z.int().min(1).max(10_000),
    degradedP90Ms: z.int().min(1_000).max(120_000),
    downSuccessBp: z.int().min(0).max(9_999),
    downConsecutiveErrors: z.int().min(1).max(20),
    probeAfterMinutes: z.int().min(1).max(120),
  })
  .refine((policy) => policy.downSuccessBp < policy.degradedSuccessBp, {
    message: 'Expected downSuccessBp below degradedSuccessBp',
    path: ['downSuccessBp'],
  })
  .meta({ id: 'SupplierPolicy' });

export type SupplierPolicy = z.infer<typeof supplierPolicySchema>;

/** The seeded policy (ADR 0021). */
export const SUPPLIER_POLICY_DEFAULTS: SupplierPolicy = {
  priceReviewThresholdBp: 1_000,
  costStaleMinutes: 120,
  healthWindowMinutes: 30,
  healthMinCalls: 5,
  degradedSuccessBp: 9_000,
  degradedP90Ms: 10_000,
  downSuccessBp: 5_000,
  downConsecutiveErrors: 3,
  probeAfterMinutes: 10,
};

// Health (H1–H3) -------------------------------------------------------------------------------

/** One recorded adapter call (`supplier_calls`), as health reads it. */
export interface HealthCall {
  operation: SupplierCallOperation;
  result: SupplierCallResult;
  latencyMs: number;
  at: Date;
}

/** A supplier's state: its newest `supplier_health_changes` row (none: `healthy`). */
export interface HealthStanding {
  state: SupplierHealthState;
  reason: string;
  since: Date;
}

export interface HealthVerdict {
  state: SupplierHealthState;
  reason: string;
  /** The window's figures; null when the verdict did not read them (a probe). */
  calls: number | null;
  successBp: number | null;
  p90Ms: number | null;
}

/** The reason of the `degraded` state a successful probe gives (rule H3). */
export const HEALTH_PROBE_REASON = 'probe ok';

const percent = (bp: number) => `${Math.floor(bp / 100)}%`;

/**
 * The first call time health reads (rules H1, H3): the window's start, or, while a probe's
 * `degraded` stands, the probe's time, so only the calls since it can make the supplier healthy.
 */
export function healthWindowStart(
  previous: HealthStanding,
  now: Date,
  policy: Pick<SupplierPolicy, 'healthWindowMinutes'>,
): Date {
  const start = new Date(now.getTime() - policy.healthWindowMinutes * 60_000);
  const sinceProbe = previous.state === 'degraded' && previous.reason === HEALTH_PROBE_REASON;
  return sinceProbe && previous.since > start ? previous.since : start;
}

/**
 * Rules H1 and H2 over the calls since `healthWindowStart`, oldest first: `down` after
 * `downConsecutiveErrors` errors in a row or, with at least `healthMinCalls` calls, a success rate
 * below `downSuccessBp`; `degraded` below `degradedSuccessBp` or above `degradedP90Ms` (p90 of
 * every operation but `list_offers`); else `healthy`. With fewer calls and no run of errors, the
 * state stays. A `down` supplier leaves that state only by a probe (`probeOutcome`, rule H3).
 */
export function supplierHealth(
  calls: readonly HealthCall[],
  policy: SupplierPolicy,
  previous: SupplierHealthState,
): HealthVerdict {
  const total = calls.length;
  const answered = calls.filter((call) => call.result !== 'error').length;
  const successBp = total === 0 ? null : Math.floor((answered * 10_000) / total);
  const latencies = calls
    .filter((call) => call.operation !== 'list_offers')
    .map((call) => call.latencyMs)
    .sort((a, b) => a - b);
  // Nearest rank: the smallest latency at or above 90% of the calls.
  const p90Ms =
    latencies.length === 0
      ? null
      : (latencies[Math.ceil((latencies.length * 9) / 10) - 1] as number);
  const figures = { calls: total, successBp, p90Ms };
  const run = calls.slice(-policy.downConsecutiveErrors);
  if (run.length === policy.downConsecutiveErrors && run.every((call) => call.result === 'error')) {
    return { state: 'down', reason: `${run.length} consecutive errors`, ...figures };
  }
  if (successBp === null || total < policy.healthMinCalls) {
    return { state: previous, reason: `${total} calls < ${policy.healthMinCalls}`, ...figures };
  }
  if (successBp < policy.downSuccessBp) {
    return {
      state: 'down',
      reason: `success ${percent(successBp)} < ${percent(policy.downSuccessBp)}`,
      ...figures,
    };
  }
  if (successBp < policy.degradedSuccessBp) {
    return {
      state: 'degraded',
      reason: `success ${percent(successBp)} < ${percent(policy.degradedSuccessBp)}`,
      ...figures,
    };
  }
  if (p90Ms !== null && p90Ms > policy.degradedP90Ms) {
    return {
      state: 'degraded',
      reason: `p90 ${p90Ms} ms > ${policy.degradedP90Ms} ms`,
      ...figures,
    };
  }
  return { state: 'healthy', reason: `success ${percent(successBp)}`, ...figures };
}

/**
 * Rule H3 for a supplier `down` since `downSince`, over its calls since then, oldest first: the
 * first call `probeAfterMinutes` after entering `down` (or after the last failed probe) is the
 * probe; its success recovers the supplier (to `degraded`), its failure starts the wait again.
 * Calls inside a wait count for nothing. `nextProbeAt` is when the job probes, if nothing has.
 */
export function probeOutcome(
  downSince: Date,
  calls: readonly Pick<HealthCall, 'result' | 'at'>[],
  policy: Pick<SupplierPolicy, 'probeAfterMinutes'>,
): { recoveredAt: Date | null; nextProbeAt: Date } {
  const wait = policy.probeAfterMinutes * 60_000;
  let nextProbeAt = new Date(downSince.getTime() + wait);
  for (const call of calls) {
    if (call.at < nextProbeAt) continue;
    if (call.result !== 'error') return { recoveredAt: call.at, nextProbeAt };
    nextProbeAt = new Date(call.at.getTime() + wait);
  }
  return { recoveredAt: null, nextProbeAt };
}

// Routes (RT3–RT6) ------------------------------------------------------------------------------

/** Why a route cannot serve its product now (rule RT4), in the order they are checked. */
export const ROUTE_UNUSABLE_REASONS = [
  'archived',
  'disabled',
  'supplier_unavailable',
  'supplier_not_configured',
  'supplier_paused',
  'supplier_down',
  'offer_missing',
  'out_of_stock',
  'cost_unknown',
  'cost_stale',
  'fields_incomplete',
  'balance_low',
] as const;

export const routeUnusableReasonSchema = z
  .enum(ROUTE_UNUSABLE_REASONS)
  .meta({ id: 'RouteUnusableReason' });

export type RouteUnusableReason = z.infer<typeof routeUnusableReasonSchema>;

/** Healthy automatic routes, then degraded automatic routes, then the manual route (rule RT5). */
export const ROUTE_TIERS = ['healthy', 'degraded', 'manual'] as const;

export const routeTierSchema = z.enum(ROUTE_TIERS).meta({ id: 'RouteTier' });

export type RouteTier = z.infer<typeof routeTierSchema>;

/** What rule RT4 reads about a route, its supplier, its offer and its product's game. */
export interface RouteFacts {
  archived: boolean;
  enabled: boolean;
  supplierCode: SupplierCode;
  supplierAvailable: boolean;
  supplierConfigured: boolean;
  supplierPaused: boolean;
  health: SupplierHealthState;
  offerMissing: boolean;
  inStock: boolean;
  costUsdUnits: number | null;
  costConfirmedAt: Date | null;
  /** The supplier's field names; null when it does not publish them. */
  requiredFields: readonly string[] | null;
  /** Supplier field name → input field key. */
  fieldMap: Readonly<Record<string, string>>;
  /** The unarchived input field keys of the product's game. */
  liveFieldKeys: readonly string[];
  /** The supplier's newest balance in USD units; null when it reports none in USD. */
  balanceUsdUnits: number | null;
}

/** The supplier fields a route leaves unmapped (rule RT3); empty when they are unknown. */
export function unmappedFields(
  requiredFields: readonly string[] | null,
  fieldMap: Readonly<Record<string, string>>,
): string[] {
  return (requiredFields ?? []).filter((field) => !Object.hasOwn(fieldMap, field));
}

/** A cost older than the policy's limit is unknown (rule SY5); manual costs never go stale. */
export function isCostStale(
  supplierCode: SupplierCode,
  costConfirmedAt: Date | null,
  now: Date,
  policy: Pick<SupplierPolicy, 'costStaleMinutes'>,
): boolean {
  if (supplierCode === 'manual') return false;
  if (costConfirmedAt === null) return true;
  return now.getTime() - costConfirmedAt.getTime() > policy.costStaleMinutes * 60_000;
}

/** Rule RT4: why the route is unusable now, or null when it may serve its product. */
export function routeUnusableReason(
  route: RouteFacts,
  now: Date,
  policy: Pick<SupplierPolicy, 'costStaleMinutes'>,
): RouteUnusableReason | null {
  if (route.archived) return 'archived';
  if (!route.enabled) return 'disabled';
  if (!route.supplierAvailable) return 'supplier_unavailable';
  if (!route.supplierConfigured) return 'supplier_not_configured';
  if (route.supplierPaused) return 'supplier_paused';
  if (route.health === 'down') return 'supplier_down';
  if (route.offerMissing) return 'offer_missing';
  if (!route.inStock) return 'out_of_stock';
  if (route.costUsdUnits === null) return 'cost_unknown';
  if (isCostStale(route.supplierCode, route.costConfirmedAt, now, policy)) return 'cost_stale';
  const keys = new Set(route.liveFieldKeys);
  const mapped = Object.values(route.fieldMap).every((key) => keys.has(key));
  if (!mapped || unmappedFields(route.requiredFields, route.fieldMap).length > 0) {
    return 'fields_incomplete';
  }
  if (route.balanceUsdUnits !== null && route.balanceUsdUnits < route.costUsdUnits) {
    return 'balance_low';
  }
  return null;
}

/** A route's tier (rule RT5): the manual supplier is a last resort, whatever its cost. */
export function routeTier(supplierCode: SupplierCode, health: SupplierHealthState): RouteTier {
  if (supplierCode === 'manual') return 'manual';
  return health === 'healthy' ? 'healthy' : 'degraded';
}

/** What ordering reads about a route. */
export interface OrderedRoute {
  supplierCode: SupplierCode;
  health: SupplierHealthState;
  costUsdUnits: number | null;
  priority: number;
}

/**
 * Routes in the order the price basis and the router use (rules RT5, RT6): by tier, then cost
 * (unknown last), then priority, then supplier code.
 */
export function orderRoutes<Route extends OrderedRoute>(routes: readonly Route[]): Route[] {
  const tier = (route: Route) => ROUTE_TIERS.indexOf(routeTier(route.supplierCode, route.health));
  const cost = (route: Route) => route.costUsdUnits ?? Number.MAX_SAFE_INTEGER;
  return [...routes].sort(
    (a, b) =>
      tier(a) - tier(b) ||
      cost(a) - cost(b) ||
      a.priority - b.priority ||
      a.supplierCode.localeCompare(b.supplierCode),
  );
}

/** Rule P1: the basis route among the usable routes, or null when there is none. */
export function priceBasis<Route extends OrderedRoute>(
  usableRoutes: readonly Route[],
): Route | null {
  return orderRoutes(usableRoutes)[0] ?? null;
}

// Schemas ---------------------------------------------------------------------------------------

/** A supplier cost: above zero, at most $10,000. */
export const supplierCostSchema = z.int().min(1).max(SUPPLIER_COST_MAX_USD_UNITS);

/** A cost the admin types for a manual offer (rule RT7): whole cents. */
export const manualCostSchema = usdCentsSchema.min(USD_CENT).max(SUPPLIER_COST_MAX_USD_UNITS);

const supplierFieldName = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/);
const inputFieldKey = z.string().regex(/^[a-z][a-z0-9_]{1,31}$/);

/** Supplier field name → input field key of the product's game (rule RT3). */
export const fieldMapSchema = z
  .record(supplierFieldName, inputFieldKey)
  .refine((map) => Object.keys(map).length <= MAX_FIELD_MAP_ENTRIES, {
    message: `Expected at most ${MAX_FIELD_MAP_ENTRIES} entries`,
  })
  .meta({ id: 'FieldMap' });

export type FieldMap = z.infer<typeof fieldMapSchema>;

const priority = z.int().min(1).max(ROUTE_PRIORITY_MAX);

export const syncRunSchema = z
  .object({
    id: z.uuid(),
    supplierCode: supplierCodeSchema,
    trigger: syncRunTriggerSchema,
    status: syncRunStatusSchema,
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime().nullable(),
    offersSeen: z.int().nonnegative(),
    offersNew: z.int().nonnegative(),
    costsChanged: z.int().nonnegative(),
    offersMissing: z.int().nonnegative(),
    reviewsOpened: z.int().nonnegative(),
    productsRepriced: z.int().nonnegative(),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
  })
  .meta({ id: 'SyncRun' });

export type SyncRun = z.infer<typeof syncRunSchema>;

export const syncRunPageSchema = pagedListSchema(syncRunSchema, 'SyncRunPage');

export type SyncRunPage = z.infer<typeof syncRunPageSchema>;

export const supplierBalanceSchema = z
  .object({
    id: z.uuid(),
    currency: currencySchema,
    amountUnits: z.int(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'SupplierBalance' });

export type SupplierBalance = z.infer<typeof supplierBalanceSchema>;

export const supplierHealthChangeSchema = z
  .object({
    id: z.uuid(),
    state: supplierHealthStateSchema,
    reason: z.string(),
    calls: z.int().nonnegative().nullable(),
    successBp: z.int().min(0).max(10_000).nullable(),
    p90Ms: z.int().nonnegative().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'SupplierHealthChange' });

export type SupplierHealthChange = z.infer<typeof supplierHealthChangeSchema>;

/** `GET /api/admin/suppliers`: one card per supplier. */
export const supplierSummarySchema = z
  .object({
    code: supplierCodeSchema,
    nameAr: z.string(),
    available: z.boolean(),
    configured: z.boolean(),
    paused: z.boolean(),
    health: supplierHealthStateSchema,
    healthSince: z.iso.datetime().nullable(),
    balance: supplierBalanceSchema.nullable(),
    /** The newest balance is in USD and below the threshold (rule H5). */
    balanceLow: z.boolean(),
    lowBalanceUsdUnits: z.int().nonnegative(),
    lastRun: syncRunSchema.nullable(),
    offerCount: z.int().nonnegative(),
    mappedCount: z.int().nonnegative(),
    /** The adapter can check a player id (S09 rule PV1). */
    canValidatePlayer: z.boolean(),
    /** S09 rule AD2: the daily validation quota and today's calls (since 00:00 Damascus). */
    validationQuota: z.int().nonnegative(),
    validationsToday: z.int().nonnegative(),
  })
  .meta({ id: 'SupplierSummary' });

export type SupplierSummary = z.infer<typeof supplierSummarySchema>;

/** `GET /api/admin/suppliers/:code`: never the credential values, only their hints (rule SP2). */
export const supplierDetailSchema = supplierSummarySchema
  .extend({
    credentialFields: z.array(z.string()),
    credentials: z
      .object({
        /** Per field, its last 4 characters. */
        hints: z.record(z.string(), z.string()),
        setAt: z.iso.datetime(),
      })
      .nullable(),
    healthHistory: z.array(supplierHealthChangeSchema),
    balanceHistory: z.array(supplierBalanceSchema),
  })
  .meta({ id: 'SupplierDetail' });

export type SupplierDetail = z.infer<typeof supplierDetailSchema>;

/** `PUT /api/admin/suppliers/:code/credentials`: every field of that supplier (rule SP2). */
export const setSupplierCredentialsSchema = z
  .object({ values: z.record(supplierFieldName, z.string().trim().min(1).max(500)) })
  .meta({ id: 'SetSupplierCredentials' });

export type SetSupplierCredentials = z.infer<typeof setSupplierCredentialsSchema>;

/** `PATCH /api/admin/suppliers/:code` (A07). */
export const updateSupplierSchema = z
  .object({ lowBalanceUsdUnits: usdCentsSchema.max(LOW_BALANCE_MAX_USD_UNITS) })
  .meta({ id: 'UpdateSupplier' });

export type UpdateSupplier = z.infer<typeof updateSupplierSchema>;

/** A supplier's daily player-validation quota (S09 rule PV5): 0 turns validation off for it. */
export const VALIDATION_QUOTA_MAX = 1_000_000;
export const VALIDATION_QUOTA_DEFAULT = 1_000;

/** `PUT /api/admin/suppliers/:code/validation-quota` (rule AD2). */
export const validationQuotaSchema = z
  .object({ quota: z.int().min(0).max(VALIDATION_QUOTA_MAX) })
  .meta({ id: 'ValidationQuota' });

export type ValidationQuota = z.infer<typeof validationQuotaSchema>;

const booleanFilter = z.enum(['true', 'false']).optional();

export const offerListQuerySchema = pageQuerySchema
  .extend({
    /** Part of the offer's name or of the supplier's offer id. */
    q: z.string().trim().min(1).max(100).optional(),
    group: z.string().trim().min(1).max(200).optional(),
    mapped: booleanFilter,
    missing: booleanFilter,
    inStock: booleanFilter,
  })
  .meta({ id: 'OfferListQuery' });

export type OfferListQuery = z.infer<typeof offerListQuerySchema>;

export const supplierOfferSchema = z
  .object({
    id: z.uuid(),
    supplierCode: supplierCodeSchema,
    /** The supplier's own id. */
    offerId: z.string(),
    name: z.string(),
    groupName: z.string().nullable(),
    kind: productKindSchema.nullable(),
    requiredFields: z.array(z.string()).nullable(),
    costUsdUnits: z.int().nullable(),
    /** The supplier's raw value when it gave no usable USD cost. */
    costRaw: z.string().nullable(),
    inStock: z.boolean(),
    costConfirmedAt: z.iso.datetime().nullable(),
    costStale: z.boolean(),
    lastSeenAt: z.iso.datetime(),
    missingSince: z.iso.datetime().nullable(),
    /** The product its unarchived route serves (rule RT1). */
    mapped: z
      .object({
        routeId: z.uuid(),
        productId: z.uuid(),
        productNameAr: z.string(),
        gameId: z.uuid(),
        gameNameAr: z.string(),
      })
      .nullable(),
  })
  .meta({ id: 'SupplierOffer' });

export type SupplierOffer = z.infer<typeof supplierOfferSchema>;

export const supplierOfferPageSchema = pagedListSchema(supplierOfferSchema, 'SupplierOfferPage');

export type SupplierOfferPage = z.infer<typeof supplierOfferPageSchema>;

export const offerCostChangeSchema = z
  .object({
    id: z.uuid(),
    fromUsdUnits: z.int().nullable(),
    toUsdUnits: z.int().nullable(),
    syncRunId: z.uuid().nullable(),
    /** Set by the admin (a manual offer, rule RT7). */
    byAdmin: z.boolean(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'OfferCostChange' });

export type OfferCostChange = z.infer<typeof offerCostChangeSchema>;

export const offerCostChangePageSchema = pagedListSchema(
  offerCostChangeSchema,
  'OfferCostChangePage',
);

export type OfferCostChangePage = z.infer<typeof offerCostChangePageSchema>;

/** `POST /api/admin/suppliers/:code/import` (rule RT8): all or nothing. */
export const importOffersSchema = z
  .object({
    gameId: z.uuid(),
    /** The kind of the offers whose kind the supplier does not give. */
    kind: productKindSchema.optional(),
    fieldMap: fieldMapSchema.default({}),
    rows: z
      .array(
        z.object({
          /** The offer's id in `supplier_offers`. */
          offerId: z.uuid(),
          nameAr: z
            .string()
            .trim()
            .min(1)
            .max(60)
            .regex(/^[^\p{Cc}]+$/u),
        }),
      )
      .min(1)
      .max(MAX_IMPORT_ROWS)
      .refine(
        (rows) => new Set(rows.map((row) => row.offerId)).size === rows.length,
        'Expected each offer once',
      ),
  })
  .meta({ id: 'ImportOffers' });

export type ImportOffers = z.input<typeof importOffersSchema>;

/** A refused import row, in the refusal's `details.rows` (edge case 10). */
export interface ImportRowError {
  index: number;
  code: string;
}

export const importResultSchema = z
  .object({
    products: z.array(
      z.object({
        id: z.uuid(),
        nameAr: z.string(),
        routeId: z.uuid(),
        priceUsdUnits: z.int().nullable(),
      }),
    ),
  })
  .meta({ id: 'ImportResult' });

export type ImportResult = z.infer<typeof importResultSchema>;

export const createRouteSchema = z
  .object({
    offerId: z.uuid(),
    priority: priority.default(1),
    fieldMap: fieldMapSchema.default({}),
  })
  .meta({ id: 'CreateRoute' });

export type CreateRoute = z.input<typeof createRouteSchema>;

export const createManualRouteSchema = z
  .object({ costUsdUnits: manualCostSchema })
  .meta({ id: 'CreateManualRoute' });

export type CreateManualRoute = z.infer<typeof createManualRouteSchema>;

export const updateRouteSchema = z
  .object({ priority, enabled: z.boolean(), fieldMap: fieldMapSchema })
  .partial()
  .meta({ id: 'UpdateRoute' });

export type UpdateRoute = z.infer<typeof updateRouteSchema>;

export const setManualCostSchema = createManualRouteSchema.meta({ id: 'SetManualCost' });

export const routeSchema = z
  .object({
    id: z.uuid(),
    supplierCode: supplierCodeSchema,
    supplierNameAr: z.string(),
    offer: supplierOfferSchema.pick({
      id: true,
      offerId: true,
      name: true,
      kind: true,
      requiredFields: true,
      costUsdUnits: true,
      costConfirmedAt: true,
      inStock: true,
      missingSince: true,
    }),
    priority: z.int(),
    enabled: z.boolean(),
    fieldMap: z.record(z.string(), z.string()),
    archivedAt: z.iso.datetime().nullable(),
    /** Null for an unusable route. */
    tier: routeTierSchema.nullable(),
    unusableReason: routeUnusableReasonSchema.nullable(),
    /** The route the price follows (rule P1). */
    basis: z.boolean(),
    /** The supplier does not publish the offer's fields: mapped from its documentation (RT3). */
    requirementsUnknown: z.boolean(),
  })
  .meta({ id: 'Route' });

export type Route = z.infer<typeof routeSchema>;

/** A product's routes and price (the routes drawer). */
export const productRoutingSchema = z
  .object({
    productId: z.uuid(),
    /** Usable routes in tier order (RT5, RT6), then unusable, then archived ones. */
    routes: z.array(routeSchema),
    basisRouteId: z.uuid().nullable(),
    currentPrice: z
      .object({
        priceUsdUnits: z.int(),
        costUsdUnits: z.int(),
        routeId: z.uuid(),
        createdAt: z.iso.datetime(),
      })
      .nullable(),
    /** The price the basis gives now (rule P1); null with no usable route. */
    targetPriceUsdUnits: z.int().nullable(),
    openReview: z
      .object({
        id: z.uuid(),
        costBeforeUsdUnits: z.int(),
        costAfterUsdUnits: z.int(),
        changeBp: z.int(),
        proposedPriceUsdUnits: z.int(),
      })
      .nullable(),
    availability: productAvailabilitySchema,
  })
  .meta({ id: 'ProductRouting' });

export type ProductRouting = z.infer<typeof productRoutingSchema>;
